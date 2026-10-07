// OpenCode provider module for roadie credential pools.
//
// OpenCode loads this through `provider.roadie.npm` (a file:// URL) and calls
// the first export whose name starts with `create` — so
// `createRoadiePoolProvider` must remain the only `create*` export here.
//
// Every LLM request goes through `poolFetch`, which:
//   1. reads the ordered pool list the roadie plugin put in `x-roadie-pool`
//      (chat.headers hook; global mode sends the single `shared` pool, and a
//      single id behaves exactly as before),
//   2. strips every `x-roadie-*` header plus the SDK placeholder auth headers
//      so nothing internal reaches upstream,
//   3. resolves the pool's rotation into ordered candidates, skipping
//      cooled-down accounts,
//   4. refreshes OAuth accounts whose access token expires within 60s (under
//      the pool lock, so concurrent requests refresh only once; a permanent
//      refresh failure cools the account down for 1h and skips it),
//   5. sets the auth header per account (`x-api-key` for api keys on the
//      Anthropic wire, `authorization: Bearer` for OAuth and
//      OpenAI-compatible) and rewrites the body's `model` to the candidate's
//      real model id; Anthropic OAuth candidates additionally get the Claude
//      Code payload shaping (system prefix, tool names) with the response
//      stream's tool names reversed,
//   6. on HTTP 429 marks the account cooling down (`retry-after` when
//      present, else 60s) and tries the next candidate.
//
// A missing pool tag or an empty pool fails closed with a 401 JSON error; the
// request never reaches upstream. State lives in <dataDir>/credentials/ via
// credentials/store.ts; the data directory comes from ROADIE_DATA_DIR, which
// opencode.ts sets on the server process.

import os from 'node:os'
import path from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
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
import {
  applyAnthropicOAuthRequestHeaders,
  isPermanentRefreshFailure,
  refreshAnthropicToken,
  rewriteRequestPayload,
  wrapResponseStream,
} from './adapters/anthropic-oauth.js'

// OpenCode provider id the pool provider is registered under (`provider.roadie`).
export const ROADIE_PROVIDER_ID = 'roadie'
export const POOL_HEADER = 'x-roadie-pool'
export const SESSION_HEADER = 'x-roadie-session'
export const ROADIE_INTERNAL_HEADER_PREFIX = 'x-roadie-'
export const POOL_MANAGED_API_KEY = 'roadie-pool-managed'
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1'

const DEFAULT_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** Refresh an OAuth access token when it expires within this window. */
export const OAUTH_REFRESH_LEAD_MS = 60_000
/** Cooldown after a permanent (HTTP 400/401) refresh failure. */
export const OAUTH_REFRESH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000

/** 'anthropic' speaks the Anthropic Messages wire; anything else is treated as OpenAI-compatible. */
export type RequestWire = 'anthropic' | 'openai-compatible'

export function wireForProvider(provider: string): RequestWire {
  return provider === 'anthropic' ? 'anthropic' : 'openai-compatible'
}

/** The request URL path tells which wire serialized the body. */
export function wireFromRequestUrl(input: string | URL): RequestWire {
  const { pathname } = new URL(input.toString())
  return pathname.endsWith('/messages') ? 'anthropic' : 'openai-compatible'
}

/** `retry-after` seconds when parseable (capped), else the 60s default. */
export function cooldownUntilFromRetryAfter({ retryAfter, now }: { retryAfter: string | null; now: number }): number {
  const seconds = Number.parseFloat(retryAfter ?? '')
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(now + Math.round(seconds * 1000), now + MAX_COOLDOWN_MS)
  }
  return now + DEFAULT_COOLDOWN_MS
}

export function resolvePoolDataDir(dataDir?: string): string {
  return dataDir ?? process.env.ROADIE_DATA_DIR ?? path.join(os.homedir(), '.roadie')
}

function jsonErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

/**
 * Rewrite the serialized request body's `model` field to the candidate's real
 * upstream model id: the SDK model id is the rotation name (`default`), which
 * upstream would reject. Only string JSON bodies are rewritten; anything else
 * passes through untouched.
 */
function rewriteBodyModel({
  init,
  headers,
  modelId,
}: {
  init: RequestInit
  headers: Headers
  modelId: string
}): RequestInit {
  if (typeof init.body !== 'string') return { ...init, headers }
  const parsed = (() => {
    try {
      return JSON.parse(init.body) as unknown
    } catch {
      return null
    }
  })()
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...init, headers }
  const body = parsed as Record<string, unknown>
  if (typeof body.model !== 'string' || body.model === modelId) return { ...init, headers }
  const rewritten = new Headers(headers)
  // The previous content-length no longer matches the rewritten body; let the
  // runtime recompute it.
  rewritten.delete('content-length')
  return { ...init, headers: rewritten, body: JSON.stringify({ ...body, model: modelId }) }
}

function applyAccountAuth({ headers, candidate }: { headers: Headers; candidate: PoolCandidate }): void {
  if (candidate.account.type === 'oauth') {
    if (wireForProvider(candidate.provider) === 'anthropic') {
      applyAnthropicOAuthRequestHeaders({
        headers,
        accessToken: candidate.account.access,
        modelId: candidate.modelId,
      })
      return
    }
    headers.set('authorization', `Bearer ${candidate.account.access}`)
    return
  }
  if (wireForProvider(candidate.provider) === 'anthropic') {
    // An earlier oauth candidate on this wire may have set Bearer auth; api
    // keys never carry it.
    headers.delete('authorization')
    headers.set('x-api-key', candidate.account.key)
    return
  }
  headers.set('authorization', `Bearer ${candidate.account.key}`)
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

type ShapedCandidateRequest = {
  init: RequestInit
  wrapResponse: (response: Response) => Response
}

/**
 * Auth headers + body for one candidate. API-key candidates get exactly the
 * phase 1a treatment (auth header per wire, model rewrite) so their requests
 * stay byte-for-byte unchanged. Anthropic OAuth candidates additionally send
 * Bearer auth with the merged beta header and get the Claude Code payload
 * shaping (system prefix, tool names), reversed in the streamed response.
 */
function shapeCandidateRequest({
  init,
  headers,
  candidate,
}: {
  init: RequestInit
  headers: Headers
  candidate: PoolCandidate
}): ShapedCandidateRequest {
  applyAccountAuth({ headers, candidate })
  const withModel = rewriteBodyModel({ init, headers, modelId: candidate.modelId })
  if (candidate.account.type !== 'oauth' || wireForProvider(candidate.provider) !== 'anthropic') {
    return { init: withModel, wrapResponse: (response) => response }
  }
  if (typeof withModel.body !== 'string') {
    return { init: withModel, wrapResponse: (response) => response }
  }
  const rewritten = rewriteRequestPayload(withModel.body)
  const shapedHeaders = new Headers(withModel.headers)
  // The rewritten body's old content-length no longer matches.
  shapedHeaders.delete('content-length')
  return {
    init: { ...withModel, headers: shapedHeaders, body: rewritten.body },
    wrapResponse: (response) => wrapResponseStream(response, rewritten.reverseToolNameMap),
  }
}

export type PoolFetchOptions = {
  /** Roadie data directory holding <dataDir>/credentials/. */
  dataDir: string
  /** Rotation (opencode model id) to resolve candidates from. */
  rotationName: string
  /** Pool to draw accounts from. Phase 1a is global mode: `shared`. */
  poolId?: string
  now?: () => number
  fetchImpl?: PoolFetch
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
    `add one with roadie credentials add-key --pool ${firstPoolId} ` +
    `or roadie credentials login anthropic --pool ${firstPoolId}`
  )
}

/** The global fetch type (bun-types) carries a preconnect member; match it so the fetch installs cleanly on the AI SDK providers. */
export type PoolFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type PoolFetchWithPreconnect = PoolFetch & {
  preconnect: (
    url: string | URL,
    options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean },
  ) => void
}

/**
 * Build the pool-aware fetch installed on both wire providers. Dependencies
 * are injectable so unit tests can stub time and upstream.
 */
export function makePoolFetch({
  dataDir,
  rotationName,
  poolId = SHARED_POOL_ID,
  now = Date.now,
  fetchImpl = fetch,
}: PoolFetchOptions): PoolFetchWithPreconnect {
  const poolFetch: PoolFetch = async (input, init = {}): Promise<Response> => {
    const requestUrl = input instanceof Request ? input.url : input.toString()
    const timestamp = now()
    const headers = new Headers(init.headers)
    const requestedPool = headers.get(POOL_HEADER)
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith(ROADIE_INTERNAL_HEADER_PREFIX)) headers.delete(name)
    }
    headers.delete('x-api-key')
    headers.delete('authorization')
    if (!requestedPool) {
      return jsonErrorResponse(401, 'no credential pool on request')
    }
    // `x-roadie-pool` carries an ordered comma-separated list (per-person
    // fallback appends `shared`); a single pool id behaves exactly as before.
    const poolIds = parsePoolListHeader(requestedPool)
    if (poolIds.length === 0) {
      return jsonErrorResponse(401, 'no credential pool on request')
    }

    const resolutions = resolvePoolListCandidates({
      poolIds,
      dataDir,
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
        return jsonErrorResponse(
          401,
          noUsableAccountsMessage({ requestedPool, firstPoolId: poolIds[0]! }),
        )
      }
      const first = resolutions[0]
      if (poolIds.length === 1 && first && 'skipped' in first) {
        return jsonErrorResponse(401, first.skipped)
      }
      return jsonErrorResponse(
        401,
        noUsableAccountsMessage({ requestedPool, firstPoolId: poolIds[0]! }),
      )
    }

    const requestWire = wireFromRequestUrl(requestUrl)
    let lastResponse: Response | null = null
    for (const candidate of candidates) {
      // A request serialized on one wire can only be replayed to candidates
      // on the same wire; other-wire candidates are skipped untouched (their
      // cooldown state stays clean) and win on the next request.
      if (wireForProvider(candidate.provider) !== requestWire) continue
      const account = await ensureFreshOAuthAccount({
        dataDir,
        poolId: candidate.poolId,
        account: candidate.account,
        now: timestamp,
        fetchImpl,
      })
      if (account instanceof Error) continue
      const shaped = shapeCandidateRequest({ init, headers, candidate: { ...candidate, account } })
      const response = await fetchImpl(input, shaped.init)
      lastResponse = response
      if (response.status !== 429) {
        // Best-effort metadata: a failed last-used write never changes the
        // routing outcome, and cooldowns (the state that matters) are
        // persisted separately below.
        void markUsed({ dataDir, poolId: candidate.poolId, accountId: account.id, now: timestamp })
        return shaped.wrapResponse(response)
      }
      // Cooldowns are per pool: a rate-limited account in the billed pool
      // never cools down the same provider's account in another pool.
      const cooldown = markCooldown({
        dataDir,
        poolId: candidate.poolId,
        accountId: candidate.account.id,
        untilMs: cooldownUntilFromRetryAfter({
          retryAfter: response.headers.get('retry-after'),
          now: timestamp,
        }),
      })
      if (cooldown instanceof Error) {
        // Swallowed on purpose: losing one cooldown write only means the same
        // account may be retried on the next request.
      }
      if (lastResponse.body) discardResponseBody(lastResponse)
    }
    if (!lastResponse) {
      return jsonErrorResponse(
        401,
        `no account in pool ${requestedPool} matches the ${requestWire} endpoint`,
      )
    }
    return lastResponse
  }
  return Object.assign(poolFetch, {
    preconnect: (
      _url: string | URL,
      _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean },
    ): void => {},
  })
}

export type RoadiePoolProviderOptions = {
  /** Fixed upstream base URL (gateway/proxy). Default: the official endpoints per wire. */
  baseURL?: string
  /** Roadie data directory. Default: ROADIE_DATA_DIR, then ~/.roadie. */
  dataDir?: string
  now?: () => number
  fetchImpl?: typeof fetch
}

/**
 * Pool-dispatching provider: picks the wire per model id from the pool's
 * rotation (first available candidate wins) and returns that wire's AI SDK
 * language model, wired to the pool fetch.
 */
export function createRoadiePoolProvider(options: RoadiePoolProviderOptions = {}): {
  languageModel: (modelId: string) => ReturnType<ReturnType<typeof createAnthropic>['languageModel']>
  chatModel: (modelId: string) => ReturnType<ReturnType<typeof createAnthropic>['languageModel']>
} {
  const dataDir = resolvePoolDataDir(options.dataDir)
  const poolFetchDeps = { dataDir, now: options.now, fetchImpl: options.fetchImpl }
  let anthropicWire: ReturnType<typeof createAnthropic> | null = null
  let openaiWire: ReturnType<typeof createOpenAICompatible> | null = null

  const resolveWireModelId = (modelId: string): RequestWire => {
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    const rotations = readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })
    const state = readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    if (
      accounts instanceof Error ||
      rotations instanceof Error ||
      state instanceof Error
    ) {
      return 'openai-compatible'
    }
    const candidates = resolveCandidates({
      poolId: SHARED_POOL_ID,
      rotation: rotations[modelId] ?? [],
      accounts,
      cooldowns: state.cooldowns,
      now: options.now ? options.now() : Date.now(),
    })
    const first = candidates[0] ?? (() => {
      const firstEntry = (rotations[modelId] ?? [])[0]
      if (!firstEntry) return null
      const provider = firstEntry.split('/')[0]
      return provider ? { provider } : null
    })()
    return first ? wireForProvider(first.provider) : 'openai-compatible'
  }

  const languageModelFor = (modelId: string) => {
    const wire = resolveWireModelId(modelId)
    if (wire === 'anthropic') {
      anthropicWire ??= createAnthropic({
        // poolFetch replaces auth per account; the SDK only needs a placeholder.
        apiKey: POOL_MANAGED_API_KEY,
        baseURL: options.baseURL,
        fetch: makePoolFetch({ rotationName: modelId, ...poolFetchDeps }),
      })
      return anthropicWire.languageModel(modelId)
    }
    openaiWire ??= createOpenAICompatible({
      name: 'roadie',
      baseURL: options.baseURL ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
      fetch: makePoolFetch({ rotationName: modelId, ...poolFetchDeps }),
    })
    return openaiWire.languageModel(modelId)
  }

  return {
    languageModel: languageModelFor,
    chatModel: languageModelFor,
  }
}
