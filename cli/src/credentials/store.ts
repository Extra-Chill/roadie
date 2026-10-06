// Credential pool store: one directory per pool under <dataDir>/credentials/.
//
// Layout per pool:
//   accounts.json  (mode 0600) — the pool's accounts, each:
//     { id, provider, type: 'api', key, label?, addedAt, lastUsed }
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

export type PoolAccountType = 'api'

export type PoolAccount = {
  id: string
  provider: string
  type: PoolAccountType
  key: string
  label?: string
  addedAt: string
  lastUsed: string | null
}

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
function atomicWriteFileSync({ filePath, data }: { filePath: string; data: string }): void {
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
  return file.accounts.filter(
    (account): account is PoolAccount =>
      typeof account?.id === 'string' &&
      typeof account?.provider === 'string' &&
      typeof account?.key === 'string',
  )
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

export async function addPoolAccount({
  dataDir,
  poolId,
  provider,
  key,
  label,
  now = new Date(),
}: {
  dataDir: string
  poolId: string
  provider: string
  key: string
  label?: string
  now?: Date
}): Promise<PoolAccount | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  const trimmedProvider = provider.trim()
  const trimmedKey = key.trim()
  if (!trimmedProvider) {
    return new Error('Account provider is required')
  }
  if (!trimmedKey) {
    return new Error('Account key is required')
  }
  return await withPoolLock(poolId, () => {
    const accounts = readAccountsFile({ dataDir, poolId })
    const account: PoolAccount = {
      id: crypto.randomUUID(),
      provider: trimmedProvider,
      type: 'api',
      key: trimmedKey,
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

// ── State (cooldowns + last used) ────────────────────────────────

export function readPoolState({ dataDir, poolId }: { dataDir: string; poolId: string }): PoolState | Error {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  return readStateFile({ dataDir, poolId })
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
  return await withPoolLock(poolId, () => {
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
  })
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
}: {
  dataDir: string
  poolId: string
  name: string
  entries: string[]
}): Promise<true | Error> {
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
