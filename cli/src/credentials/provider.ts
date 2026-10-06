// OpenCode provider module for roadie credential pools.
//
// OpenCode loads this through `provider.roadie.npm` (a file:// URL) and calls
// the first export whose name starts with `create` — so
// `createRoadiePoolProvider` must remain the only `create*` export here.
//
// Every LLM request goes through `poolFetch`, which:
//   1. reads the pool id the roadie plugin put in `x-roadie-pool`
//      (chat.headers hook),
//   2. strips every `x-roadie-*` header plus the SDK placeholder auth headers
//      so nothing internal reaches upstream,
//   3. resolves the pool's rotation into ordered candidates, skipping
//      cooled-down accounts,
//   4. sets the auth header per account (`x-api-key` for the Anthropic wire,
//      `authorization: Bearer` for OpenAI-compatible) and rewrites the body's
//      `model` to the candidate's real model id,
//   5. on HTTP 429 marks the account cooling down (`retry-after` when
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
  markUsed,
  readPoolAccounts,
  readPoolRotations,
  readPoolState,
} from './store.js'
import { markCooldown, resolveCandidates, type PoolCandidate } from './router.js'

export const POOL_HEADER = 'x-roadie-pool'
export const SESSION_HEADER = 'x-roadie-session'
export const ROADIE_INTERNAL_HEADER_PREFIX = 'x-roadie-'
export const POOL_MANAGED_API_KEY = 'roadie-pool-managed'
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1'

const DEFAULT_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000

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
  if (wireForProvider(candidate.provider) === 'anthropic') {
    headers.set('x-api-key', candidate.account.key)
    return
  }
  headers.set('authorization', `Bearer ${candidate.account.key}`)
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

    const accounts = readPoolAccounts({ dataDir, poolId: requestedPool })
    if (accounts instanceof Error) return jsonErrorResponse(401, accounts.message)
    if (accounts.length === 0) {
      return jsonErrorResponse(401, `pool ${requestedPool} has no accounts`)
    }
    const rotations = readPoolRotations({ dataDir, poolId: requestedPool })
    if (rotations instanceof Error) return jsonErrorResponse(401, rotations.message)
    const rotation = rotations[rotationName] ?? []
    if (rotation.length === 0) {
      return jsonErrorResponse(
        401,
        `pool ${requestedPool} has no rotation named ${rotationName}`,
      )
    }
    const state = readPoolState({ dataDir, poolId: requestedPool })
    if (state instanceof Error) return jsonErrorResponse(401, state.message)

    const candidates = resolveCandidates({
      poolId: requestedPool,
      rotation,
      accounts,
      cooldowns: state.cooldowns,
      now: timestamp,
    })
    if (candidates.length === 0) {
      return jsonErrorResponse(
        429,
        `all accounts in pool ${requestedPool} are cooling down`,
      )
    }

    const requestWire = wireFromRequestUrl(requestUrl)
    let lastResponse: Response | null = null
    for (const candidate of candidates) {
      // A request serialized on one wire can only be replayed to candidates
      // on the same wire; other-wire candidates are skipped untouched (their
      // cooldown state stays clean) and win on the next request.
      if (wireForProvider(candidate.provider) !== requestWire) continue
      applyAccountAuth({ headers, candidate })
      const response = await fetchImpl(input, rewriteBodyModel({ init, headers, modelId: candidate.modelId }))
      lastResponse = response
      if (response.status !== 429) {
        // Best-effort metadata: a failed last-used write never changes the
        // routing outcome, and cooldowns (the state that matters) are
        // persisted separately below.
        void markUsed({ dataDir, poolId: requestedPool, accountId: candidate.account.id, now: timestamp })
        return response
      }
      const cooldown = markCooldown({
        dataDir,
        poolId: requestedPool,
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
