// OpenCode provider module for roadie credential pools.
//
// OpenCode loads this through `provider.roadie.npm` (a file:// URL) and calls
// the first export whose name starts with `create` — so
// `createRoadiePoolProvider` must remain the only `create*` export here.
//
// `createRoadiePoolProvider().languageModel(rotationName)` returns ONE
// delegating LanguageModel (AI SDK `LanguageModelV3`). Its `doGenerate` and
// `doStream`:
//   1. read the ordered pool list the roadie plugin put in `x-roadie-pool`
//      (chat.headers hook; global mode sends the single `shared` pool, and a
//      single id behaves exactly as before) and strip every `x-roadie-*`
//      header from the call options so nothing internal reaches upstream,
//   2. resolve the pool's rotation into ordered candidates with the existing
//      router (per-pool rotation, per-pool cooldowns, OAuth refresh), then
//      apply turn affinity: when `x-roadie-session` names a held route
//      (credentials/routes.ts) whose candidate is still in the resolved list,
//      that candidate is tried first, so tool follow-ups stay on one account
//      until the session is idle (the plugin's event hook clears the route on
//      session.idle / session.deleted; a TTL bounds a missed idle). Only the
//      held account itself failing (429 cooldown or a failed refresh) moves
//      the turn to the next candidate, and success re-pins the route,
//   3. per candidate, build that provider's SDK language model for the
//      candidate's real model id with the account's credentials — the
//      provider comes from the models.dev catalog
//      (credentials/provider-catalog.ts): bundled SDK when known, else
//      OpenAI-compatible against the catalog base URL, else the account's own
//      `baseURL` override — and call its `doGenerate`/`doStream` with the same
//      options,
//   4. skip a candidate whose catalog context-window limit is smaller than
//      the request's estimated input size (a thread that fits one model may
//      not fit the next payer's; unknown limits and a failed catalog load
//      never skip), and
//   5. on an `APICallError` with status 429 mark the account cooling down
//      (`retry-after` when present, else 60s) and try the next candidate; any
//      other error is returned as-is. `markUsed` runs on success.
//
// Because routing happens per candidate, one rotation can mix providers
// (e.g. `anthropic/claude-sonnet-5-5` then `zai-coding-plan/glm-5.3-flash`).
// OAuth accounts keep per-provider adapters (credentials/adapters/): the
// Anthropic adapter builds `@ai-sdk/anthropic` with a shaping fetch that
// carries the existing Bearer/beta/system-prefix/tool-name round-trip.
// Unknown OAuth providers are unsupported with a clear error.
//
// A missing pool tag or an empty pool fails closed with a 401 APICallError;
// the request never reaches upstream. State lives in <dataDir>/credentials/
// via credentials/store.ts; the data directory comes from ROADIE_DATA_DIR,
// which opencode.ts sets on the server process.

import os from 'node:os'
import path from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import {
  SHARED_POOL_ID,
  markCooldownLocked,
  markUsed,
  readPoolAccounts,
  readPoolRotations,
  readPoolState,
  updatePoolAccountLocked,
  withPoolLock,
  type PoolAccount,
} from './store.js'
import { markCooldown, resolveCandidates, type PoolCandidate } from './router.js'
import { parsePoolListHeader } from './person-pool.js'
import { readSessionRoute, setSessionRoute } from './routes.js'
import {
  catalogModelContextLimit,
  resolveCandidateModelFactory,
  resolveCatalog,
  type CandidateModelFactory,
  type ModelsDevCatalog,
} from './provider-catalog.js'
import {
  applyAnthropicOAuthRequestHeaders,
  isPermanentRefreshFailure,
  refreshAnthropicToken,
  rewriteRequestPayload,
  wrapResponseStream,
} from './adapters/anthropic-oauth.js'

// OpenCode provider id the pool provider is registered under (`provider.roadie`).
export const ROADIE_PROVIDER_ID = 'roadie'
/**
 * After the subrouter handoff, `subrouter/<rotation>` is served by this same
 * pool provider so host configs that still name subrouter models keep working
 * without subrouter refreshing tokens the pool now owns.
 */
export const SUBROUTER_ALIAS_PROVIDER_ID = 'subrouter'
export const SUBROUTER_ALIAS_ENV = 'ROADIE_SUBROUTER_ALIAS'

/** Provider ids whose requests the pool handles (and the plugin tags). */
export function isPoolProviderId(providerID: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return providerID === ROADIE_PROVIDER_ID || (providerID === SUBROUTER_ALIAS_PROVIDER_ID && env[SUBROUTER_ALIAS_ENV] === '1')
}
export const POOL_HEADER = 'x-roadie-pool'
export const SESSION_HEADER = 'x-roadie-session'
export const ROADIE_INTERNAL_HEADER_PREFIX = 'x-roadie-'
export const POOL_MANAGED_API_KEY = 'roadie-pool-managed'

const DEFAULT_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** Refresh an OAuth access token when it expires within this window. */
export const OAUTH_REFRESH_LEAD_MS = 60_000
/** Cooldown after a permanent (HTTP 400/401) refresh failure. */
export const OAUTH_REFRESH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000

/** `retry-after` seconds when parseable (capped), else the 60s default. */
export function cooldownUntilFromRetryAfter({ retryAfter, now }: { retryAfter: string | null; now: number }): number {
  const seconds = Number.parseFloat(retryAfter ?? '')
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(now + Math.round(seconds * 1000), now + MAX_COOLDOWN_MS)
  }
  return now + DEFAULT_COOLDOWN_MS
}

/**
 * Rough token estimate for the context-window check: 1 token ≈ 4 characters
 * of the serialized prompt and tool definitions. Deliberately coarse — it
 * only decides whether a candidate's context window is worth trying, never
 * the request shape itself. 0 disables the check.
 *
 * Binary payloads are excluded: a file part's `data` (a Uint8Array, which
 * JSON.stringify expands to `{"0":137,...}`, or a base64 string) would count
 * an ordinary screenshot as millions of tokens and skip every candidate.
 * Providers bill images and files by their own rules, not by byte length.
 */
function withoutBinaryPayloads(this: unknown, key: string, value: unknown): unknown {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return undefined
  if (
    key === 'data' &&
    typeof this === 'object' &&
    this !== null &&
    'type' in this &&
    (this.type === 'file' || this.type === 'image')
  ) {
    return undefined
  }
  return value
}

export function estimatePromptTokens({ prompt, tools }: { prompt: unknown; tools?: unknown }): number {
  try {
    let chars = JSON.stringify(prompt, withoutBinaryPayloads)?.length ?? 0
    if (tools !== undefined) chars += JSON.stringify(tools)?.length ?? 0
    return Math.ceil(chars / 4)
  } catch {
    // An unserializable prompt only means "estimate unknown": never skip.
    return 0
  }
}

export function resolvePoolDataDir(dataDir?: string): string {
  return dataDir ?? process.env.ROADIE_DATA_DIR ?? path.join(os.homedir(), '.roadie')
}

/** The fail-closed 401 the delegating model throws; messages match the old wire-level bodies. */
function poolAuthError(message: string): APICallError {
  return new APICallError({
    message,
    url: 'roadie://credential-pools',
    requestBodyValues: undefined,
    statusCode: 401,
    isRetryable: false,
  })
}

/** The global fetch type (bun-types) carries a preconnect member; match it so the fetch installs cleanly on the AI SDK providers. */
export type PoolFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type PoolFetchWithPreconnect = PoolFetch & {
  preconnect: (
    url: string | URL,
    options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean },
  ) => void
}

function fetchWithPreconnect(fetchImpl: PoolFetch): PoolFetchWithPreconnect {
  return Object.assign(fetchImpl, {
    preconnect: (
      _url: string | URL,
      _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean },
    ): void => {},
  })
}

/**
 * Refresh an Anthropic OAuth account whose access token expires within
 * OAUTH_REFRESH_LEAD_MS. The check-and-refresh runs inside withPoolLock and
 * re-reads the account under the lock, so concurrent requests on one pool
 * trigger at most one refresh and every request sees the rotated tokens
 * (including the rotated refresh token, written back with
 * updatePoolAccountLocked while the lock is held).
 *
 * A refresh rejected with HTTP 400/401 (revoked or expired refresh token)
 * cools the account down for OAUTH_REFRESH_FAILURE_COOLDOWN_MS and the caller
 * moves on to the next candidate. Any other failure skips the candidate for
 * this request without a cooldown. A returned Error never escapes as a crash;
 * it only means "skip this candidate".
 */
async function ensureFreshOAuthAccount({
  dataDir,
  poolId,
  account,
  now,
  fetchImpl,
}: {
  dataDir: string
  poolId: string
  account: PoolAccount
  now: number
  fetchImpl: PoolFetch
}): Promise<PoolAccount | Error> {
  try {
    // Shaping and refresh are Anthropic-specific; other oauth providers have
    // no adapter yet and are dispatched with the stored access token as-is.
    if (account.type !== 'oauth' || account.provider !== 'anthropic') return account
    if (account.expires > now + OAUTH_REFRESH_LEAD_MS) return account
    return await withPoolLock(poolId, async () => {
      // Re-read under the lock: a concurrent request may have refreshed already.
      const accounts = readPoolAccounts({ dataDir, poolId })
      if (accounts instanceof Error) return accounts
      const latest = accounts.find((entry) => entry.id === account.id)
      if (!latest) {
        return new Error(`oauth account ${account.id} disappeared from pool ${poolId}`)
      }
      if (latest.type !== 'oauth') {
        return new Error(`account ${latest.id} is no longer an oauth account`)
      }
      if (latest.expires > now + OAUTH_REFRESH_LEAD_MS) return latest
      const refreshed = await refreshAnthropicToken({ refreshToken: latest.refresh, fetchImpl })
      if (refreshed instanceof Error) {
        if (isPermanentRefreshFailure(refreshed)) {
          const cooldown = markCooldownLocked({
            dataDir,
            poolId,
            accountId: latest.id,
            untilMs: now + OAUTH_REFRESH_FAILURE_COOLDOWN_MS,
          })
          if (cooldown instanceof Error) {
            // Swallowed on purpose: losing the cooldown write only means the
            // dead account is retried on a later request.
          }
        }
        return refreshed
      }
      return updatePoolAccountLocked({
        dataDir,
        poolId,
        accountId: latest.id,
        refresh: refreshed.refresh,
        access: refreshed.access,
        expires: refreshed.expires,
      })
    })
  } catch (cause) {
    // A store write failure or anything else unexpected must never crash the
    // request: the caller just skips to the next candidate.
    return new Error(`oauth refresh for account ${account.id} failed`, { cause })
  }
}

/**
 * Resolved candidates for one pool in the request's list, or why the pool was
 * skipped. An unusable pool (empty, cooling down, or missing the rotation)
 * never fails the request on its own: the next pool answers, and only when
 * every listed pool is unusable does the request fail.
 */
type PoolResolution =
  | { poolId: string; candidates: PoolCandidate[] }
  | { poolId: string; candidates: PoolCandidate[]; skipped: string }

function resolvePoolListCandidates({
  poolIds,
  dataDir,
  rotationName,
  now,
}: {
  poolIds: string[]
  dataDir: string
  rotationName: string
  now: number
}): PoolResolution[] {
  return poolIds.map((poolId) => {
    const accounts = readPoolAccounts({ dataDir, poolId })
    if (accounts instanceof Error) {
      return { poolId, candidates: [], skipped: accounts.message }
    }
    if (accounts.length === 0) {
      return { poolId, candidates: [], skipped: `pool ${poolId} has no accounts` }
    }
    const rotations = readPoolRotations({ dataDir, poolId })
    if (rotations instanceof Error) {
      return { poolId, candidates: [], skipped: rotations.message }
    }
    const rotation = rotations[rotationName] ?? []
    if (rotation.length === 0) {
      return {
        poolId,
        candidates: [],
        skipped: `pool ${poolId} has no rotation named ${rotationName}`,
      }
    }
    const state = readPoolState({ dataDir, poolId })
    if (state instanceof Error) {
      return { poolId, candidates: [], skipped: state.message }
    }
    return {
      poolId,
      candidates: resolveCandidates({
        poolId,
        rotation,
        accounts,
        cooldowns: state.cooldowns,
        now,
      }),
    }
  })
}

/** The 401 body when every pool in the request's list is unusable. */
export function noUsableAccountsMessage({
  requestedPool,
  firstPoolId,
}: {
  requestedPool: string
  firstPoolId: string
}): string {
  return (
    `no usable accounts in pool ${requestedPool}; ` +
    `add one with /credentials add-key or /credentials login-anthropic ` +
    `(operators: roadie credentials add-key --pool ${firstPoolId} ` +
    `or roadie credentials login anthropic --pool ${firstPoolId})`
  )
}

/**
 * Strip every `x-roadie-*` header from the call options and return the pool
 * list and session id they carried, so nothing internal reaches the upstream
 * provider. The session id is read here, before the header is stripped, and
 * only ever keys the route store — it never reaches upstream.
 */
function stripRoadieHeaders(
  headers: Record<string, string | undefined> | undefined,
): {
  headers: Record<string, string | undefined>
  requestedPool: string | null
  sessionId: string | null
} {
  const clean: Record<string, string | undefined> = {}
  let requestedPool: string | null = null
  let sessionId: string | null = null
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase().startsWith(ROADIE_INTERNAL_HEADER_PREFIX)) {
      if (name.toLowerCase() === POOL_HEADER) requestedPool = value ?? null
      if (name.toLowerCase() === SESSION_HEADER) sessionId = value ?? null
      continue
    }
    clean[name] = value
  }
  return { headers: clean, requestedPool, sessionId }
}

/**
 * Anthropic OAuth shaping fetch, ported from the old wire-level candidate
 * shaping: `authorization: Bearer` with `x-api-key` removed, the merged beta
 * header, the Claude Code system prefix and tool-name rewrite in the request
 * body, and the tool-name reversal in the streamed response.
 */
function makeAnthropicOAuthFetch({
  accessToken,
  modelId,
  fetchImpl,
}: {
  accessToken: string
  modelId: string
  fetchImpl: PoolFetch
}): PoolFetchWithPreconnect {
  const oauthFetch: PoolFetch = async (input, init = {}) => {
    // Mirrors @subrouter/cli's anthropic buildFetch: the body may arrive on a
    // Request rather than init.body, and must be shaped either way or the
    // request goes out without the Claude Code signature.
    const originalBody =
      typeof init.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input
              .clone()
              .text()
              .catch(() => undefined)
          : undefined
    const shaped = rewriteRequestPayload(originalBody)
    const headers = new Headers(init.headers)
    if (input instanceof Request) {
      input.headers.forEach((value, name) => {
        if (!headers.has(name)) headers.set(name, value)
      })
    }
    applyAnthropicOAuthRequestHeaders({ headers, accessToken, modelId: shaped.modelId ?? modelId })
    headers.delete('content-length')
    const response = await fetchImpl(input, { ...init, headers, body: shaped.body ?? init.body })
    return wrapResponseStream(response, shaped.reverseToolNameMap)
  }
  return fetchWithPreconnect(oauthFetch)
}

type CandidateModelDeps = {
  dataDir: string
  /** Fixed upstream base URL (gateway/proxy); wins over the catalog and accounts. */
  gatewayBaseURL?: string
  now: () => number
  fetchImpl: typeof fetch
  getCatalog: () => Promise<ModelsDevCatalog | Error>
}

/**
 * The provider's SDK language model for one candidate. OAuth accounts use the
 * per-provider adapter (anthropic only; anything else is unsupported with a
 * clear error); API-key accounts resolve through the models.dev catalog with
 * the account's `baseURL` override when present.
 */
async function buildCandidateModel({
  candidate,
  account,
  deps,
}: {
  candidate: PoolCandidate
  account: PoolAccount
  deps: CandidateModelDeps
}): Promise<LanguageModelV3 | Error> {
  if (account.type === 'oauth') {
    if (candidate.provider !== 'anthropic') {
      return new Error(
        `no OAuth adapter for ${candidate.provider}; only anthropic subscriptions are supported`,
      )
    }
    const anthropic = createAnthropic({
      // The shaping fetch replaces auth per account; the SDK only needs a placeholder.
      apiKey: POOL_MANAGED_API_KEY,
      ...(deps.gatewayBaseURL && { baseURL: deps.gatewayBaseURL }),
      fetch: makeAnthropicOAuthFetch({
        accessToken: account.access,
        modelId: candidate.modelId,
        fetchImpl: deps.fetchImpl,
      }),
    })
    return anthropic.languageModel(candidate.modelId)
  }
  const catalog = await deps.getCatalog()
  if (catalog instanceof Error) return catalog
  const factory: CandidateModelFactory | Error = resolveCandidateModelFactory({
    catalog,
    provider: candidate.provider,
    apiKey: account.key,
    baseURL: deps.gatewayBaseURL ?? account.baseURL,
    fetchImpl: deps.fetchImpl,
  })
  if (factory instanceof Error) return factory
  return factory(candidate.modelId)
}

/**
 * The resolved candidate a session's held route points at, or null. The route
 * only applies when it was pinned under this rotation and its exact
 * (pool, account, provider, model) is still in the resolved candidate list:
 * a cooling-down or removed account never pins, a pool that fell out of the
 * request's list never pins, and a /model switch (a different rotation name)
 * starts a fresh resolution. The candidate set itself is never expanded, so
 * fail-closed 401s and fallback lists behave exactly as without affinity.
 */
function heldCandidate({
  sessionId,
  rotationName,
  candidates,
  dataDir,
  now,
}: {
  sessionId: string | null
  rotationName: string
  candidates: PoolCandidate[]
  dataDir: string
  now: number
}): PoolCandidate | null {
  if (!sessionId) return null
  const route = readSessionRoute({ dataDir, sessionId, now })
  if (!route || route.rotation !== rotationName) return null
  return (
    candidates.find(
      (candidate) =>
        candidate.poolId === route.poolId &&
        candidate.account.id === route.accountId &&
        candidate.provider === route.provider &&
        candidate.modelId === route.modelId,
    ) ?? null
  )
}

/**
 * Route one doGenerate/doStream call: resolve the pool list from the (then
 * stripped) x-roadie-* headers, hold the session's live route so a turn never
 * splits across accounts, skip candidates whose catalog context window is
 * smaller than the request's estimated input size, try the candidates in
 * order, cool accounts down on a 429 and serve from the first candidate that
 * answers.
 */
async function routeLanguageModelCall<TResult>({
  rotationName,
  options,
  deps,
  call,
}: {
  rotationName: string
  options: LanguageModelV3CallOptions
  deps: CandidateModelDeps
  /** Invoke one candidate model with the stripped call options. */
  call: (model: LanguageModelV3, callOptions: LanguageModelV3CallOptions) => Promise<TResult>
}): Promise<TResult> {
  const { headers, requestedPool, sessionId } = stripRoadieHeaders(options.headers)
  const timestamp = deps.now()
  if (!requestedPool?.trim()) {
    throw poolAuthError('no credential pool on request')
  }
  // `x-roadie-pool` carries an ordered comma-separated list (per-person
  // fallback appends `shared`); a single pool id behaves exactly as before.
  const poolIds = parsePoolListHeader(requestedPool)
  if (poolIds.length === 0) {
    throw poolAuthError('no credential pool on request')
  }

  const resolutions = resolvePoolListCandidates({
    poolIds,
    dataDir: deps.dataDir,
    rotationName,
    now: timestamp,
  })
  const candidates = resolutions.flatMap((resolution) => resolution.candidates)
  if (candidates.length === 0) {
    // Every listed pool is empty, cooling down, or otherwise unusable.
    // Empty/cooling pools (the "nothing to bill" case, including a
    // per-person pool) always get the actionable message; other reasons
    // (e.g. a missing rotation on the only listed pool) keep their
    // specific text, as before lists existed.
    const isEmptyOrCooling = (resolution: PoolResolution): boolean =>
      'skipped' in resolution
        ? resolution.skipped.includes('has no accounts')
        : resolution.candidates.length === 0
    if (resolutions.every(isEmptyOrCooling)) {
      throw poolAuthError(noUsableAccountsMessage({ requestedPool, firstPoolId: poolIds[0]! }))
    }
    const first = resolutions[0]
    if (poolIds.length === 1 && first && 'skipped' in first) {
      throw poolAuthError(first.skipped)
    }
    throw poolAuthError(noUsableAccountsMessage({ requestedPool, firstPoolId: poolIds[0]! }))
  }

  // Turn affinity: hold the live route per session so tool follow-ups stay on
  // one account until the session is idle. The held candidate is only moved
  // ahead of the resolved order — never added to it.
  const held = heldCandidate({
    sessionId,
    rotationName,
    candidates,
    dataDir: deps.dataDir,
    now: timestamp,
  })
  const orderedCandidates = held
    ? [held, ...candidates.filter((candidate) => candidate !== held)]
    : candidates

  // Context-window check (credential pools phase 2c): a candidate whose
  // catalog context limit is smaller than the request's estimated input size
  // is skipped — a thread that fits one model may not fit the next payer's.
  // Unknown limits (model or provider missing from the catalog) and a failed
  // catalog load never skip anything.
  const estimatedInputTokens = estimatePromptTokens({ prompt: options.prompt, tools: options.tools })
  const contextCatalog: ModelsDevCatalog | Error | undefined =
    estimatedInputTokens > 0 ? await deps.getCatalog() : undefined
  const contextLimitFor = (candidate: PoolCandidate): number | undefined =>
    contextCatalog === undefined || contextCatalog instanceof Error
      ? undefined
      : catalogModelContextLimit({
          catalog: contextCatalog,
          provider: candidate.provider,
          modelId: candidate.modelId,
        })

  const callOptions: LanguageModelV3CallOptions = { ...options, headers }
  let lastRateLimitError: APICallError | null = null
  let firstCandidateError: Error | null = null
  let contextSkipped = 0
  for (const candidate of orderedCandidates) {
    const contextLimit = contextLimitFor(candidate)
    if (contextLimit !== undefined && contextLimit < estimatedInputTokens) {
      contextSkipped++
      continue
    }
    const account = await ensureFreshOAuthAccount({
      dataDir: deps.dataDir,
      poolId: candidate.poolId,
      account: candidate.account,
      now: timestamp,
      fetchImpl: deps.fetchImpl,
    })
    if (account instanceof Error) {
      firstCandidateError ??= account
      continue
    }
    const model = await buildCandidateModel({
      candidate,
      account,
      deps,
    })
    if (model instanceof Error) {
      firstCandidateError ??= model
      continue
    }
    try {
      const result = await call(model, callOptions)
      if (sessionId) {
        // Pin (or re-pin) the turn's route so the rest of the turn stays on
        // this account. The route only moves here when the held account
        // itself failed (429 cooldown or a failed refresh). Best-effort like
        // markUsed: a failed write only means the next request of the turn
        // re-resolves candidates fresh.
        try {
          const pinned = await setSessionRoute({
            dataDir: deps.dataDir,
            sessionId,
            route: {
              poolId: candidate.poolId,
              accountId: account.id,
              provider: candidate.provider,
              modelId: candidate.modelId,
              rotation: rotationName,
              pinnedAt: timestamp,
            },
            now: timestamp,
          })
          if (pinned instanceof Error) {
            // Swallowed on purpose.
          }
        } catch {
          // Swallowed on purpose.
        }
      }
      // Best-effort metadata: a failed last-used write never changes the
      // routing outcome (markUsed can also reject on an fs error, so this has
      // its own guard), and cooldowns (the state that matters) are persisted
      // separately below.
      try {
        const used = await markUsed({
          dataDir: deps.dataDir,
          poolId: candidate.poolId,
          accountId: account.id,
          now: timestamp,
        })
        if (used instanceof Error) {
          // Swallowed on purpose.
        }
      } catch {
        // Swallowed on purpose.
      }
      return result
    } catch (error) {
      if (APICallError.isInstance(error) && error.statusCode === 429) {
        lastRateLimitError = error
        // Cooldowns are per pool: a rate-limited account in the billed pool
        // never cools down the same provider's account in another pool.
        const cooldown = markCooldown({
          dataDir: deps.dataDir,
          poolId: candidate.poolId,
          accountId: candidate.account.id,
          untilMs: cooldownUntilFromRetryAfter({
            retryAfter: error.responseHeaders?.['retry-after'] ?? null,
            now: timestamp,
          }),
        })
        if (cooldown instanceof Error) {
          // Swallowed on purpose: losing one cooldown write only means the
          // same account may be retried on the next request.
        }
        continue
      }
      throw error
    }
  }
  if (lastRateLimitError) {
    // Every candidate answered 429: surface the last rate limit, exactly as
    // the old wire-level loop returned the last 429 response.
    throw lastRateLimitError
  }
  if (firstCandidateError) {
    throw poolAuthError(
      `no usable account in pool ${requestedPool}: ${firstCandidateError.message}`,
    )
  }
  if (contextSkipped > 0) {
    // Every candidate was skipped for being too small for this request.
    throw poolAuthError(
      `no usable account in pool ${requestedPool}: every candidate's context window is ` +
        `smaller than the request (~${estimatedInputTokens} tokens estimated); ` +
        'compact the session or use a model with a larger context window',
    )
  }
  throw poolAuthError(noUsableAccountsMessage({ requestedPool, firstPoolId: poolIds[0]! }))
}

function makePoolLanguageModel({ rotationName, deps }: { rotationName: string; deps: CandidateModelDeps }): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: ROADIE_PROVIDER_ID,
    modelId: rotationName,
    supportedUrls: {},
    doGenerate: (options) =>
      routeLanguageModelCall<LanguageModelV3GenerateResult>({
        rotationName,
        options,
        deps,
        call: (model, callOptions) => Promise.resolve(model.doGenerate(callOptions)),
      }),
    doStream: (options) =>
      routeLanguageModelCall<LanguageModelV3StreamResult>({
        rotationName,
        options,
        deps,
        call: (model, callOptions) => Promise.resolve(model.doStream(callOptions)),
      }),
  }
}

export type RoadiePoolProviderOptions = {
  /** Fixed upstream base URL (gateway/proxy). Default: the catalog/SDK endpoints per provider. */
  baseURL?: string
  /** Roadie data directory. Default: ROADIE_DATA_DIR, then ~/.roadie. */
  dataDir?: string
  /** Pre-resolved models.dev catalog (tests). Default: resolveCatalog. */
  catalog?: ModelsDevCatalog
  now?: () => number
  fetchImpl?: typeof fetch
}

/**
 * Pool-dispatching provider: one delegating LanguageModel per rotation name
 * (`roadie/<rotation>`), resolving each request's candidates at the
 * LanguageModel level so a rotation can mix providers.
 */
export function createRoadiePoolProvider(options: RoadiePoolProviderOptions = {}): {
  languageModel: (modelId: string) => LanguageModelV3
  chatModel: (modelId: string) => LanguageModelV3
} {
  const dataDir = resolvePoolDataDir(options.dataDir)
  const getCatalog = async (): Promise<ModelsDevCatalog | Error> =>
    options.catalog ?? (await resolveCatalog({ dataDir, fetchImpl: options.fetchImpl }))
  const deps: CandidateModelDeps = {
    dataDir,
    ...(options.baseURL && { gatewayBaseURL: options.baseURL }),
    now: options.now ?? Date.now,
    fetchImpl: options.fetchImpl ?? fetch,
    getCatalog,
  }
  const languageModelFor = (modelId: string): LanguageModelV3 =>
    makePoolLanguageModel({ rotationName: modelId, deps })
  return {
    languageModel: languageModelFor,
    chatModel: languageModelFor,
  }
}
