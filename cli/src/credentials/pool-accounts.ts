// Pool account management seam (#238).
//
// Every caller that adds, lists, removes, reorders pool accounts or sets pool
// rotations (the Discord /credentials and /credentials add flows, the `roadie
// credentials` CLI and the pool host's admin API) goes through one
// PoolAccounts implementation:
//
//   localPoolAccounts   the pool files in this Roadie's data dir
//   remotePoolAccounts  a pool host's admin API (credentials/pool-admin.ts)
//
// resolvePoolAccounts picks one from the environment, so a bot that uses a
// remote pool (ROADIE_POOL_URL) manages the host's accounts instead of
// writing a local pool nobody reads.
//
// Results never carry a secret: accounts are returned through
// toPoolAccountView, an explicit allowlist of fields.

import crypto from 'node:crypto'
import {
  DuplicatePoolAccountError,
  SHARED_POOL_ID,
  addPoolAccount,
  addPoolOAuthAccount,
  isValidPoolId,
  movePoolAccount,
  readPoolAccounts,
  readPoolRotationRecords,
  type PoolRotations,
  readPoolState,
  removePoolAccount,
  seedPoolRotations,
  setPoolRotation,
  type PoolAccount,
} from './store.js'
import {
  ANTHROPIC_OAUTH_REDIRECT_URI,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePKCE,
  parseManualInput,
  type TokenFetch,
} from './adapters/anthropic-oauth.js'
import {
  buildCodexAuthorizeUrl,
  codexAccountId,
  exchangeCodexAuthorizationCode,
} from './adapters/openai-codex-oauth.js'
import { resolveCatalog, validateCatalogProvider, type ModelsDevCatalog } from './provider-catalog.js'
import { readRemotePoolConfig, remotePoolAccounts } from './remote-pool.js'

export const POOL_OAUTH_PROVIDERS = ['anthropic', 'openai-codex', 'xai'] as const
export type PoolOAuthProvider = (typeof POOL_OAUTH_PROVIDERS)[number]

export function isPoolOAuthProvider(value: unknown): value is PoolOAuthProvider {
  return typeof value === 'string' && (POOL_OAUTH_PROVIDERS as readonly string[]).includes(value)
}

/** The secret-free account shape every listing and reply uses. */
export type PoolAccountView = {
  id: string
  provider: string
  type: 'api' | 'oauth'
  /** 1-based position in the pool order (the router's tiebreaker). */
  position: number
  label?: string
  baseURL?: string
  addedAt: string
  lastUsed: string | null
  /** OAuth access token expiry, ISO 8601. */
  expiresAt?: string
  /** Epoch ms until which the account cools down after a 429. */
  coolingUntil?: number
}

export type PoolListing = {
  poolId: string
  accounts: PoolAccountView[]
  rotations: PoolRotations
}

export type PoolAccountAdded = {
  account: PoolAccountView
  /** Non-fatal follow-up, e.g. rotation seeding for a new person pool failed. */
  note?: string
}

export type PoolOAuthStart = { flowId: string; authorizeUrl: string }

export type PoolAccounts = {
  /** Where the accounts live, for messages: `local` or the pool host URL. */
  readonly location: string
  list(input: { poolId: string }): Promise<PoolListing | Error>
  addApiKey(input: { poolId: string; provider: string; key: string; label?: string; baseURL?: string }): Promise<PoolAccountAdded | Error>
  startOAuth(input: { poolId: string; provider: PoolOAuthProvider; label?: string }): Promise<PoolOAuthStart | Error>
  /** `input` is what the user pasted: `code#state`, a redirect URL, or a bare code. */
  completeOAuth(input: { poolId: string; flowId: string; input: string }): Promise<PoolAccountAdded | Error>
  remove(input: { poolId: string; accountId: string }): Promise<boolean | Error>
  move(input: { poolId: string; accountId: string; position: number }): Promise<PoolAccountView[] | Error>
  /** Set (or replace) a named rotation; an empty entry list removes it. */
  setRotation(input: {
    poolId: string
    name: string
    entries: string[]
    description?: string
    /** Omitted preserves the existing flag; true hides the rotation from the /model picker (#343). */
    hidden?: boolean
  }): Promise<true | Error>
}

/** Build the secret-free view. An allowlist: new account fields stay out until added here. */
export function toPoolAccountView({
  account,
  position,
  cooldownUntil,
  now = Date.now(),
}: {
  account: PoolAccount
  position: number
  cooldownUntil?: number
  now?: number
}): PoolAccountView {
  return {
    id: account.id,
    provider: account.provider,
    type: account.type,
    position,
    ...(account.label && { label: account.label }),
    ...(account.type === 'api' && account.baseURL && { baseURL: account.baseURL }),
    addedAt: account.addedAt,
    lastUsed: account.lastUsed,
    ...(account.type === 'oauth' && { expiresAt: new Date(account.expires).toISOString() }),
    ...(typeof cooldownUntil === 'number' && cooldownUntil > now && { coolingUntil: cooldownUntil }),
  }
}

// ── Local ───────────────────────────────────────────────────────

export const POOL_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000

type PendingOAuthFlow = {
  poolId: string
  provider: PoolOAuthProvider
  verifier: string
  state: string
  label?: string
  createdAt: number
}

// Module-level so flows survive across localPoolAccounts instances (a Discord
// click and its modal submit resolve the seam separately).
const pendingOAuthFlows = new Map<string, PendingOAuthFlow>()

function takeOAuthFlow(flowId: string, now: number): PendingOAuthFlow | undefined {
  const flow = pendingOAuthFlows.get(flowId)
  if (!flow) return undefined
  if (now - flow.createdAt >= POOL_OAUTH_FLOW_TTL_MS) {
    pendingOAuthFlows.delete(flowId)
    return undefined
  }
  return flow
}

function duplicateMessage(error: DuplicatePoolAccountError, provider: string, poolId: string): Error {
  return new Error(`That ${provider} account is already in pool ${poolId} (${error.existing.id}).`)
}

function invalidPool(poolId: string): Error | undefined {
  return isValidPoolId(poolId) ? undefined : new Error(`Invalid pool id: ${poolId}`)
}

export function localPoolAccounts({
  dataDir,
  tokenFetch,
  catalog,
  now = Date.now,
}: {
  dataDir: string
  /** OAuth token endpoint fetch (tests). */
  tokenFetch?: TokenFetch
  /** Pre-resolved models.dev catalog (tests). Default: resolveCatalog. */
  catalog?: ModelsDevCatalog
  now?: () => number
}): PoolAccounts {
  function view(poolId: string, account: PoolAccount): PoolAccountView | Error {
    const accounts = readPoolAccounts({ dataDir, poolId })
    if (accounts instanceof Error) return accounts
    const position = accounts.findIndex((candidate) => candidate.id === account.id) + 1
    return toPoolAccountView({ account, position: position || accounts.length, now: now() })
  }

  /**
   * A person pool with accounts but no rotation would fail every request, so
   * the first account in a rotationless pool copies the shared rotations.
   * seedPoolRotations never overwrites existing rotations.
   */
  async function added(poolId: string, account: PoolAccount): Promise<PoolAccountAdded | Error> {
    const accountView = view(poolId, account)
    if (accountView instanceof Error) return accountView
    if (poolId === SHARED_POOL_ID) return { account: accountView }
    const seeded = await seedPoolRotations({ dataDir, poolId })
    if (seeded instanceof Error) {
      return { account: accountView, note: `Could not copy the shared rotations into pool ${poolId}: ${seeded.message}` }
    }
    return { account: accountView }
  }

  return {
    location: 'local',

    async list({ poolId }) {
      const invalid = invalidPool(poolId)
      if (invalid) return invalid
      const accounts = readPoolAccounts({ dataDir, poolId })
      if (accounts instanceof Error) return accounts
      const state = readPoolState({ dataDir, poolId })
      if (state instanceof Error) return state
      const rotations = readPoolRotationRecords({ dataDir, poolId })
      if (rotations instanceof Error) return rotations
      const timestamp = now()
      return {
        poolId,
        accounts: accounts.map((account, index) =>
          toPoolAccountView({ account, position: index + 1, cooldownUntil: state.cooldowns[account.id], now: timestamp }),
        ),
        rotations,
      }
    },

    async addApiKey({ poolId, provider, key, label, baseURL }) {
      const trimmedProvider = provider.trim()
      if (!trimmedProvider) return new Error('Provider is required.')
      if (!key.trim()) return new Error('API key is required.')
      // An explicit base URL skips catalog validation: a custom endpoint is
      // exactly what the catalog cannot know. An unreachable catalog does not
      // block adding; the account routes once the catalog is available.
      if (!baseURL) {
        const resolved = catalog ?? (await resolveCatalog({ dataDir }))
        if (!(resolved instanceof Error)) {
          const unknown = validateCatalogProvider({ catalog: resolved, provider: trimmedProvider })
          if (unknown) return unknown
        }
      }
      const account = await addPoolAccount({
        dataDir,
        poolId,
        provider: trimmedProvider,
        key: key.trim(),
        ...(baseURL && { baseURL }),
        ...(label && { label }),
      })
      if (account instanceof DuplicatePoolAccountError) return duplicateMessage(account, trimmedProvider, poolId)
      if (account instanceof Error) return account
      return await added(poolId, account)
    },

    async startOAuth({ poolId, provider, label }) {
      const invalid = invalidPool(poolId)
      if (invalid) return invalid
      if (!isPoolOAuthProvider(provider)) return new Error(`Unsupported OAuth provider: ${String(provider)}`)
      if (provider === 'xai') return new Error('Import an OpenCode xAI login with roadie credentials import-opencode; interactive xAI login is not supported.')
      const pkce = await generatePKCE()
      if (pkce instanceof Error) return pkce
      // Both providers redirect to a localhost page nothing listens on; the
      // user pastes the code (and state) from the address bar.
      const state = provider === 'openai-codex' ? crypto.randomBytes(16).toString('hex') : pkce.verifier
      const authorizeUrl =
        provider === 'openai-codex'
          ? buildCodexAuthorizeUrl({ challenge: pkce.challenge, state })
          : buildAuthorizeUrl({ challenge: pkce.challenge, state, redirectUri: ANTHROPIC_OAUTH_REDIRECT_URI })
      const flowId = crypto.randomBytes(16).toString('hex')
      pendingOAuthFlows.set(flowId, { poolId, provider, verifier: pkce.verifier, state, ...(label && { label }), createdAt: now() })
      setTimeout(() => pendingOAuthFlows.delete(flowId), POOL_OAUTH_FLOW_TTL_MS).unref()
      return { flowId, authorizeUrl }
    },

    async completeOAuth({ poolId, flowId, input }) {
      const flow = takeOAuthFlow(flowId, now())
      if (!flow) return new Error('This login expired. Start it again.')
      if (flow.poolId !== poolId) return new Error(`This login was started for pool ${flow.poolId}, not ${poolId}.`)
      const { code, state } = parseManualInput(input)
      if (!code.trim()) return new Error('Authorization code is required.')
      // The flow is single-use from here: a failed exchange burns the code.
      pendingOAuthFlows.delete(flowId)
      if (state && state !== flow.state) return new Error('Authorization failed: state mismatch. Start the login again.')
      const tokens =
        flow.provider === 'openai-codex'
          ? await exchangeCodexAuthorizationCode({ code, verifier: flow.verifier, ...(tokenFetch && { fetchImpl: tokenFetch }) })
          : await exchangeAuthorizationCode({
              code,
              state: state || flow.state,
              verifier: flow.verifier,
              redirectUri: ANTHROPIC_OAUTH_REDIRECT_URI,
              ...(tokenFetch && { fetchImpl: tokenFetch }),
            })
      if (tokens instanceof Error) return new Error(`Authorization failed: ${tokens.message}`)
      const account = await addPoolOAuthAccount({
        dataDir,
        poolId,
        provider: flow.provider,
        refresh: tokens.refresh,
        access: tokens.access,
        expires: tokens.expires,
        ...(flow.label && { label: flow.label }),
        ...(flow.provider === 'openai-codex' && {
          isDuplicate: (existing: PoolAccount) =>
            existing.provider === 'openai-codex' &&
            existing.type === 'oauth' &&
            codexAccountId(existing.access) !== undefined &&
            codexAccountId(existing.access) === codexAccountId(tokens.access),
        }),
      })
      if (account instanceof DuplicatePoolAccountError) return duplicateMessage(account, flow.provider, poolId)
      if (account instanceof Error) return account
      return await added(poolId, account)
    },

    async remove({ poolId, accountId }) {
      return await removePoolAccount({ dataDir, poolId, accountId })
    },

    async move({ poolId, accountId, position }) {
      const ordered = await movePoolAccount({ dataDir, poolId, accountId, position })
      if (ordered instanceof Error) return ordered
      const timestamp = now()
      return ordered.map((account, index) => toPoolAccountView({ account, position: index + 1, now: timestamp }))
    },

    async setRotation({ poolId, name, entries, description, hidden }) {
      const invalid = invalidPool(poolId)
      if (invalid) return invalid
      // Never 'exists': onlyIfAbsent is off, so a set replaces any existing rotation.
      const result = await setPoolRotation({ dataDir, poolId, name, entries, description, hidden })
      return result === 'exists' ? new Error(`Could not set rotation ${name}`) : result
    },
  }
}

// ── Resolution ──────────────────────────────────────────────────

/**
 * The seam for this process. No ROADIE_POOL_URL: the local pool. With one, the
 * pool host's admin API, authenticated by ROADIE_POOL_ADMIN_KEY_FILE; without
 * an admin key the result is an Error, so nothing is written to a local pool
 * the bot never reads.
 */
export function resolvePoolAccounts({
  env,
  dataDir,
  fetchImpl,
}: {
  env: NodeJS.ProcessEnv
  dataDir: string
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}): PoolAccounts | Error {
  const url = env['ROADIE_POOL_URL']?.trim()
  if (!url) return localPoolAccounts({ dataDir })
  const keyFile = env['ROADIE_POOL_ADMIN_KEY_FILE']?.trim()
  if (!keyFile) {
    return new Error(
      `This bot uses the pool host ${url}. To manage its accounts from here, register an admin client on the host (roadie credentials client add <name> --admin) and set ROADIE_POOL_ADMIN_KEY_FILE to a file holding its key.`,
    )
  }
  const config = readRemotePoolConfig(env, 'ROADIE_POOL_ADMIN_KEY_FILE')
  if (config instanceof Error) return config
  if (!config) return localPoolAccounts({ dataDir })
  return remotePoolAccounts({ ...config, ...(fetchImpl && { fetchImpl }) })
}
