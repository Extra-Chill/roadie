// Credential pool store: one directory per pool under <dataDir>/credentials/.
//
// Layout per pool:
//   accounts.json  (mode 0600) — the pool's accounts, each an api key account
//     { id, provider, type: 'api', key, label?, addedAt, lastUsed }
//     or an OAuth subscription account
//     { id, provider, type: 'oauth', refresh, access, expires, label?, addedAt, lastUsed }
//   state.json     (mode 0600) — per-account cooldowns and last used, keyed by
//     account id with epoch-ms values
//   rotation.json  (mode 0600) — named rotations, each an ordered list of
//     `provider/model` strings
//
// Concurrency: one in-process lock per pool (promise chain), so different
// pools never contend with each other. Every write goes through a temp file +
// rename, so readers in other processes (bot CLI vs OpenCode server) only
// ever observe complete files.
//
// This module is imported by the provider module that runs inside the
// OpenCode server process, so it must stay dependency-free: only node
// builtins, and every function takes the data directory explicitly instead of
// importing cli/src/config.ts.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as errore from 'errore'

export const SHARED_POOL_ID = 'shared'
export const POOL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/
// Rotation names become opencode model ids (`roadie/<name>`).
export const ROTATION_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export const CREDENTIALS_DIR_MODE = 0o700
export const CREDENTIALS_FILE_MODE = 0o600

export type PoolAccountType = 'api' | 'oauth'

export type ApiPoolAccount = {
  id: string
  provider: string
  type: 'api'
  key: string
  /** Optional base URL override; wins over the models.dev catalog `api` URL. */
  baseURL?: string
  label?: string
  addedAt: string
  lastUsed: string | null
}

export type OAuthPoolAccount = {
  id: string
  provider: string
  type: 'oauth'
  /** Rotated on every refresh; always the newest refresh token. */
  refresh: string
  /** Short-lived bearer token sent as `authorization` on requests. */
  access: string
  /** Epoch ms after which `access` is considered expired. */
  expires: number
  label?: string
  addedAt: string
  lastUsed: string | null
}

export type PoolAccount = ApiPoolAccount | OAuthPoolAccount

export type PoolState = {
  /** account id -> epoch ms until which the account is cooling down */
  cooldowns: Record<string, number>
  /** account id -> epoch ms of the last dispatch */
  lastUsed: Record<string, number>
}

type AccountsFile = { accounts: PoolAccount[] }
type RotationFile = Record<string, string[]>

const EMPTY_POOL_STATE: PoolState = { cooldowns: {}, lastUsed: {} }

export function isValidPoolId(poolId: string): boolean {
  return POOL_ID_PATTERN.test(poolId)
}

export function getPoolDir({ dataDir, poolId }: { dataDir: string; poolId: string }): string {
  return path.join(dataDir, 'credentials', poolId)
}

// ── Per-pool in-process lock ─────────────────────────────────────

const poolLocks = new Map<string, Promise<unknown>>()

/**
 * Serialize async work per pool id within this process. The chain swallows
 * the previous task's rejection (its own caller already received it) so one
 * failed write never poisons later ones.
 */
export async function withPoolLock<T>(poolId: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = poolLocks.get(poolId) ?? Promise.resolve()
  const task = previous.then(fn, fn)
  const tail = task.then(
    () => undefined,
    () => undefined,
  )
  poolLocks.set(poolId, tail)
  return await task.finally(() => {
    if (poolLocks.get(poolId) === tail) {
      poolLocks.delete(poolId)
    }
  })
}

// ── File primitives ──────────────────────────────────────────────

let tempWriteCounter = 0

/**
 * Write via temp file + rename so readers in other processes never see a
 * partial file. The temp file is created with the final mode so the secret
 * bytes are never world-readable, even briefly.
 */
export function atomicWriteFileSync({ filePath, data }: { filePath: string; data: string }): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: CREDENTIALS_DIR_MODE })
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${++tempWriteCounter}.tmp`,
  )
  fs.writeFileSync(tempPath, data, { mode: CREDENTIALS_FILE_MODE })
  fs.renameSync(tempPath, filePath)
}

function readJsonFile<T>(filePath: string): T | null {
  const text = errore.try({
    try: () => fs.readFileSync(filePath, 'utf8'),
    catch: () => null,
  })
  if (text === null) return null
  const parsed = errore.try({
    try: () => JSON.parse(text) as T,
    catch: () => null,
  })
  return parsed
}

function readAccountsFile({ dataDir, poolId }: { dataDir: string; poolId: string }): PoolAccount[] {
  const file = readJsonFile<AccountsFile>(
    path.join(getPoolDir({ dataDir, poolId }), 'accounts.json'),
  )
  if (!file || !Array.isArray(file.accounts)) return []
  const accounts: PoolAccount[] = []
  for (const account of file.accounts) {
    const normalized = normalizePoolAccount(account)
    if (normalized) accounts.push(normalized)
  }
  return accounts
}

/**
 * Accept both account generations on load so existing accounts.json files keep
 * working unchanged:
 * - api accounts as written since phase 1a (`type: 'api'` + `key`; the type
 *   field is also tolerated being absent, matching the earliest files)
 * - oauth subscription accounts (`type: 'oauth'` + `refresh`/`access`/`expires`)
 * Anything else is dropped, as before.
 */
function normalizePoolAccount(account: unknown): PoolAccount | null {
  if (!account || typeof account !== 'object') return null
  const record = account as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.provider !== 'string') return null
  const base = {
    id: record.id,
    provider: record.provider,
    ...(typeof record.baseURL === 'string' && record.baseURL && { baseURL: record.baseURL }),
    ...(typeof record.label === 'string' && { label: record.label }),
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : '',
    lastUsed: typeof record.lastUsed === 'string' ? record.lastUsed : null,
  }
  if (record.type === 'oauth') {
    if (
      typeof record.refresh !== 'string' ||
      typeof record.access !== 'string' ||
      typeof record.expires !== 'number'
    ) {
      return null
    }
    return { ...base, type: 'oauth', refresh: record.refresh, access: record.access, expires: record.expires }
  }
  if (typeof record.key === 'string') {
    return { ...base, type: 'api', key: record.key }
  }
  return null
}

function readStateFile({ dataDir, poolId }: { dataDir: string; poolId: string }): PoolState {
  const file = readJsonFile<Partial<PoolState>>(
    path.join(getPoolDir({ dataDir, poolId }), 'state.json'),
  )
  if (!file) return { ...EMPTY_POOL_STATE, cooldowns: {}, lastUsed: {} }
  return {
    cooldowns: file.cooldowns && typeof file.cooldowns === 'object' ? file.cooldowns : {},
    lastUsed: file.lastUsed && typeof file.lastUsed === 'object' ? file.lastUsed : {},
  }
}

function readRotationFile({ dataDir, poolId }: { dataDir: string; poolId: string }): Record<string, string[]> {
  const file = readJsonFile<RotationFile>(
    path.join(getPoolDir({ dataDir, poolId }), 'rotation.json'),
  )
  if (!file || typeof file !== 'object') return {}
  const rotations: Record<string, string[]> = {}
  for (const [name, entries] of Object.entries(file)) {
    if (Array.isArray(entries)) {
      rotations[name] = entries.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  return rotations
}

// ── Accounts ─────────────────────────────────────────────────────

export function readPoolAccounts({ dataDir, poolId }: { dataDir: string; poolId: string }): PoolAccount[] | Error {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  return readAccountsFile({ dataDir, poolId })
}

/**
 * Returned by addPoolAccount / addPoolOAuthAccount when the caller's
 * `isDuplicate` check matches an account already in the pool. The check runs
 * under the pool lock, in the same critical section as the write, so two
 * concurrent adds of the same account cannot both succeed.
 */
export class DuplicatePoolAccountError extends Error {
  constructor(readonly existing: PoolAccount) {
    super(`account already present in pool: ${existing.id}`)
    this.name = 'DuplicatePoolAccountError'
  }
}

export async function addPoolAccount({
  dataDir,
  poolId,
  provider,
  key,
  baseURL,
  label,
  now = new Date(),
  isDuplicate,
}: {
  dataDir: string
  poolId: string
  provider: string
  key: string
  /** Optional base URL override; wins over the models.dev catalog `api` URL. */
  baseURL?: string
  label?: string
  now?: Date
  /** Checked under the pool lock; a match returns DuplicatePoolAccountError. */
  isDuplicate?: (account: PoolAccount) => boolean
}): Promise<ApiPoolAccount | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  const trimmedProvider = provider.trim()
  const trimmedKey = key.trim()
  const trimmedBaseURL = baseURL?.trim()
  if (!trimmedProvider) {
    return new Error('Account provider is required')
  }
  if (!trimmedKey) {
    return new Error('Account key is required')
  }
  return await withPoolLock(poolId, () => {
    const accounts = readAccountsFile({ dataDir, poolId })
    const duplicate = isDuplicate ? accounts.find(isDuplicate) : undefined
    if (duplicate) return new DuplicatePoolAccountError(duplicate)
    const account: PoolAccount = {
      id: crypto.randomUUID(),
      provider: trimmedProvider,
      type: 'api',
      key: trimmedKey,
      ...(trimmedBaseURL && { baseURL: trimmedBaseURL }),
      ...(label?.trim() && { label: label.trim() }),
      addedAt: now.toISOString(),
      lastUsed: null,
    }
    atomicWriteFileSync({
      filePath: path.join(getPoolDir({ dataDir, poolId }), 'accounts.json'),
      data: JSON.stringify({ accounts: [...accounts, account] }, null, 2),
    })
    return account
  })
}

export async function addPoolOAuthAccount({
  dataDir,
  poolId,
  provider,
  refresh,
  access,
  expires,
  label,
  now = new Date(),
  isDuplicate,
}: {
  dataDir: string
  poolId: string
  provider: string
  refresh: string
  access: string
  expires: number
  label?: string
  now?: Date
  /** Checked under the pool lock; a match returns DuplicatePoolAccountError. */
  isDuplicate?: (account: PoolAccount) => boolean
}): Promise<PoolAccount | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  const trimmedProvider = provider.trim()
  const trimmedRefresh = refresh.trim()
  const trimmedAccess = access.trim()
  if (!trimmedProvider) {
    return new Error('Account provider is required')
  }
  if (!trimmedRefresh) {
    return new Error('Account refresh token is required')
  }
  if (!trimmedAccess) {
    return new Error('Account access token is required')
  }
  if (!Number.isFinite(expires) || expires <= 0) {
    return new Error('Account expiry must be a positive epoch-ms number')
  }
  return await withPoolLock(poolId, () => {
    const accounts = readAccountsFile({ dataDir, poolId })
    const duplicate = isDuplicate ? accounts.find(isDuplicate) : undefined
    if (duplicate) return new DuplicatePoolAccountError(duplicate)
    const account: OAuthPoolAccount = {
      id: crypto.randomUUID(),
      provider: trimmedProvider,
      type: 'oauth',
      refresh: trimmedRefresh,
      access: trimmedAccess,
      expires,
      ...(label?.trim() && { label: label.trim() }),
      addedAt: now.toISOString(),
      lastUsed: null,
    }
    atomicWriteFileSync({
      filePath: path.join(getPoolDir({ dataDir, poolId }), 'accounts.json'),
      data: JSON.stringify({ accounts: [...accounts, account] }, null, 2),
    })
    return account
  })
}

/**
 * Write rotated OAuth tokens back to an account without taking the pool lock.
 * The caller must already hold the pool's withPoolLock (e.g. a refresh that
 * re-read the account under that same lock); external callers should use
 * updatePoolAccount instead. The refresh token must be persisted on every
 * refresh because Anthropic rotates it: the previous refresh token stops
 * working once a new one is issued.
 */
export function updatePoolAccountLocked({
  dataDir,
  poolId,
  accountId,
  refresh,
  access,
  expires,
}: {
  dataDir: string
  poolId: string
  accountId: string
  refresh: string
  access: string
  expires: number
}): OAuthPoolAccount | Error {
  const accounts = readAccountsFile({ dataDir, poolId })
  const account = accounts.find((entry) => entry.id === accountId)
  if (!account) {
    return new Error(`Account ${accountId} not found in pool ${poolId}`)
  }
  if (account.type !== 'oauth') {
    return new Error(`Account ${accountId} is not an oauth account`)
  }
  const updated: OAuthPoolAccount = { ...account, refresh, access, expires }
  atomicWriteFileSync({
    filePath: path.join(getPoolDir({ dataDir, poolId }), 'accounts.json'),
    data: JSON.stringify(
      { accounts: accounts.map((entry) => (entry.id === accountId ? updated : entry)) },
      null,
      2,
    ),
  })
  return updated
}

/**
 * Write rotated OAuth tokens back to an account under the pool lock.
 */
export async function updatePoolAccount({
  dataDir,
  poolId,
  accountId,
  refresh,
  access,
  expires,
}: {
  dataDir: string
  poolId: string
  accountId: string
  refresh: string
  access: string
  expires: number
}): Promise<OAuthPoolAccount | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  if (!refresh.trim() || !access.trim()) {
    return new Error('Refresh and access tokens are required')
  }
  if (!Number.isFinite(expires) || expires <= 0) {
    return new Error('Account expiry must be a positive epoch-ms number')
  }
  return await withPoolLock(poolId, () =>
    updatePoolAccountLocked({ dataDir, poolId, accountId, refresh, access, expires }),
  )
}

export async function removePoolAccount({
  dataDir,
  poolId,
  accountId,
}: {
  dataDir: string
  poolId: string
  accountId: string
}): Promise<boolean | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  return await withPoolLock(poolId, () => {
    const accounts = readAccountsFile({ dataDir, poolId })
    const remaining = accounts.filter((account) => account.id !== accountId)
    if (remaining.length === accounts.length) {
      return false
    }
    atomicWriteFileSync({
      filePath: path.join(getPoolDir({ dataDir, poolId }), 'accounts.json'),
      data: JSON.stringify({ accounts: remaining }, null, 2),
    })
    // Prune the removed account's cooldown and last-used entries so state.json
    // never accumulates stale keys.
    const state = readStateFile({ dataDir, poolId })
    const { [accountId]: _cooldown, ...cooldowns } = state.cooldowns
    const { [accountId]: _lastUsed, ...lastUsed } = state.lastUsed
    atomicWriteFileSync({
      filePath: path.join(getPoolDir({ dataDir, poolId }), 'state.json'),
      data: JSON.stringify({ cooldowns, lastUsed }, null, 2),
    })
    return true
  })
}

/**
 * Move an account to a 1-based position in the pool's account order, under the
 * pool lock. The order is the tiebreaker the router uses between accounts of
 * the same rotation entry, so this is how an owner decides which account is
 * tried first. Returns the new ordered account list.
 */
export async function movePoolAccount({
  dataDir,
  poolId,
  accountId,
  position,
}: {
  dataDir: string
  poolId: string
  accountId: string
  /** 1-based target position; must fall within the pool's current accounts. */
  position: number
}): Promise<PoolAccount[] | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  return await withPoolLock(poolId, () => {
    const accounts = readAccountsFile({ dataDir, poolId })
    const fromIndex = accounts.findIndex((account) => account.id === accountId)
    if (fromIndex === -1) {
      return new Error(`Account ${accountId} not found in pool ${poolId}`)
    }
    if (!Number.isInteger(position) || position < 1 || position > accounts.length) {
      return new Error(
        `Invalid position ${position}: pool ${poolId} has ${accounts.length} account${accounts.length === 1 ? '' : 's'}`,
      )
    }
    const [moved] = accounts.splice(fromIndex, 1)
    if (!moved) {
      return new Error(`Account ${accountId} not found in pool ${poolId}`)
    }
    const ordered = [...accounts.slice(0, position - 1), moved, ...accounts.slice(position - 1)]
    atomicWriteFileSync({
      filePath: path.join(getPoolDir({ dataDir, poolId }), 'accounts.json'),
      data: JSON.stringify({ accounts: ordered }, null, 2),
    })
    return ordered
  })
}

// ── State (cooldowns + last used) ────────────────────────────────

export function readPoolState({ dataDir, poolId }: { dataDir: string; poolId: string }): PoolState | Error {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  return readStateFile({ dataDir, poolId })
}

/**
 * Cooldown write without taking the pool lock. The caller must already hold
 * the pool's withPoolLock (e.g. a refresh that re-read the account under that
 * same lock); external callers should use markCooldown instead.
 */
export function markCooldownLocked({
  dataDir,
  poolId,
  accountId,
  untilMs,
}: {
  dataDir: string
  poolId: string
  accountId: string
  untilMs: number
}): true | Error {
  const state = readStateFile({ dataDir, poolId })
  atomicWriteFileSync({
    filePath: path.join(getPoolDir({ dataDir, poolId }), 'state.json'),
    data: JSON.stringify(
      { cooldowns: { ...state.cooldowns, [accountId]: untilMs }, lastUsed: state.lastUsed },
      null,
      2,
    ),
  })
  return true
}

export async function markCooldown({
  dataDir,
  poolId,
  accountId,
  untilMs,
}: {
  dataDir: string
  poolId: string
  accountId: string
  untilMs: number
}): Promise<true | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  return await withPoolLock(poolId, () => markCooldownLocked({ dataDir, poolId, accountId, untilMs }))
}

export async function markUsed({
  dataDir,
  poolId,
  accountId,
  now = Date.now(),
}: {
  dataDir: string
  poolId: string
  accountId: string
  now?: number
}): Promise<true | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  return await withPoolLock(poolId, () => {
    const state = readStateFile({ dataDir, poolId })
    atomicWriteFileSync({
      filePath: path.join(getPoolDir({ dataDir, poolId }), 'state.json'),
      data: JSON.stringify(
        { cooldowns: state.cooldowns, lastUsed: { ...state.lastUsed, [accountId]: now } },
        null,
        2,
      ),
    })
    const accounts = readAccountsFile({ dataDir, poolId })
    const account = accounts.find((entry) => entry.id === accountId)
    if (account && account.lastUsed !== new Date(now).toISOString()) {
      atomicWriteFileSync({
        filePath: path.join(getPoolDir({ dataDir, poolId }), 'accounts.json'),
        data: JSON.stringify(
          {
            accounts: accounts.map((entry) =>
              entry.id === accountId
                ? { ...entry, lastUsed: new Date(now).toISOString() }
                : entry,
            ),
          },
          null,
          2,
        ),
      })
    }
    return true
  })
}

// ── Rotations ────────────────────────────────────────────────────

export function readPoolRotations({ dataDir, poolId }: { dataDir: string; poolId: string }): Record<string, string[]> | Error {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  return readRotationFile({ dataDir, poolId })
}

/**
 * Set (or replace) the named rotation for a pool. Entries are ordered
 * `provider/model` strings. An empty entry list removes the rotation.
 */
export async function setPoolRotation({
  dataDir,
  poolId,
  name,
  entries,
  onlyIfAbsent = false,
}: {
  dataDir: string
  poolId: string
  name: string
  entries: string[]
  /** Checked under the pool lock: never replace an existing rotation. */
  onlyIfAbsent?: boolean
}): Promise<true | 'exists' | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  if (!ROTATION_NAME_PATTERN.test(name)) {
    return new Error(
      `Invalid rotation name: ${name}. Use letters, digits, dots, dashes or underscores (max 64 chars).`,
    )
  }
  for (const entry of entries) {
    const [provider, ...rest] = entry.split('/')
    if (!provider || rest.length === 0 || rest.some((part) => !part) || /\s/.test(entry)) {
      return new Error(`Invalid rotation entry: ${entry}. Expected provider/model, e.g. anthropic/claude-sonnet-4`)
    }
  }
  return await withPoolLock(poolId, () => {
    const rotations = readRotationFile({ dataDir, poolId })
    if (onlyIfAbsent && rotations[name]) return 'exists'
    if (entries.length === 0) {
      delete rotations[name]
    } else {
      rotations[name] = [...entries]
    }
    atomicWriteFileSync({
      filePath: path.join(getPoolDir({ dataDir, poolId }), 'rotation.json'),
      data: JSON.stringify(rotations, null, 2),
    })
    return true
  })
}

/**
 * Copy the source pool's (default: shared) rotations into `poolId` under the
 * same names, only when the target pool still has no rotations at all.
 *
 * The `roadie/<rotation>` models in the OpenCode config are named after the
 * shared pool's rotations and routing looks rotations up by name in each
 * pool, so a person pool with accounts but no rotation would 401 every
 * request. Seeding runs under the target pool's lock and re-checks emptiness
 * inside it, so a rotation the owner (or an import) wrote concurrently is
 * never overwritten; later calls are no-ops. Returns the number of rotations
 * copied (0 when skipped).
 */
export async function seedPoolRotations({
  dataDir,
  poolId,
  sourcePoolId = SHARED_POOL_ID,
}: {
  dataDir: string
  poolId: string
  sourcePoolId?: string
}): Promise<number | Error> {
  if (!isValidPoolId(poolId) || !isValidPoolId(sourcePoolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  if (poolId === sourcePoolId) return 0
  return await withPoolLock(poolId, () => {
    const rotations = readRotationFile({ dataDir, poolId })
    if (Object.keys(rotations).length > 0) return 0
    const source = readRotationFile({ dataDir, poolId: sourcePoolId })
    const names = Object.keys(source).filter((name) => (source[name] ?? []).length > 0)
    if (names.length === 0) return 0
    const seeded: Record<string, string[]> = {}
    for (const name of names) {
      seeded[name] = [...(source[name] ?? [])]
    }
    atomicWriteFileSync({
      filePath: path.join(getPoolDir({ dataDir, poolId }), 'rotation.json'),
      data: JSON.stringify(seeded, null, 2),
    })
    return names.length
  })
}
