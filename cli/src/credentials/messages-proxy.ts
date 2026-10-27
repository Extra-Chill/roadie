// Credential-pool proxy for backends that speak HTTP instead of AI SDK (Pi, #51).
//
// One loopback endpoint, `POST /v1/messages` (Anthropic Messages), in the bot
// process or on a pool host. The client's `model` is a pool rotation name and
// its key (`x-roadie-key`, or a standard `x-api-key` / `Authorization: Bearer`)
// is one Roadie handed that client's process. The
// proxy maps the key to a session, resolves the session's pool list, and walks
// the rotation's candidates in order, whatever their provider (#276):
//   - `anthropic/*`: forwarded as Anthropic Messages, with OAuth refresh and
//     Claude Code shaping (identity, betas, tool names).
//   - API-key providers (models.dev catalog providers like z.ai, or an
//     account's own `baseURL`): translated to OpenAI-compatible chat
//     completions with the pool account's key.
//   - `openai/*` on ChatGPT subscription accounts: translated to Codex
//     Responses with the account's token.
// Translation goes through pi-ai (./messages-translate.ts). A candidate that
// fails before the response starts (429, auth or quota, 5xx, network) falls
// through to the next one; 429 also cools the account down. The session's
// held route is tried first, and success pins the route, on every format.

import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { stream as piStream } from '@earendil-works/pi-ai/compat'
import type { Api, Model } from '@earendil-works/pi-ai'
import { markCooldown, type PoolCandidate } from './router.js'
import { markUsed, readPoolRotationRecords, type PoolRotations, type PoolAccount } from './store.js'
import { CODEX_RESPONSES_BASE_URL } from './adapters/openai-codex-oauth.js'
import { XAI_API_BASE_URL } from './adapters/xai-oauth.js'
import { clearSessionRoute, setSessionRoute } from './routes.js'
import { parsePoolListHeader } from './person-pool.js'
import { POOL_CLIENT_SCOPE_PATTERN, poolClientSessionId, resolvePoolClient } from './pool-clients.js'
import { adaptiveAnthropicRotations } from '../agent-backend/pi/pool.js'
import { resolveCatalog, type ModelsDevCatalog } from './provider-catalog.js'
import {
  cooldownUntilFromRetryAfter,
  ensureFreshOAuthAccount,
  heldCandidate,
  makeAnthropicOAuthFetch,
  resolvePoolListCandidates,
  type PoolFetch,
} from './pool-routing.js'
import { anthropicMessage, anthropicRequestToContext, anthropicStreamWriter, piModelFor, type TranslatedRequest } from './messages-translate.js'

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
export const PROXY_KEY_HEADER = 'x-roadie-key'

/**
 * The Roadie key a request carries: `x-roadie-key`, or else the API key header
 * a standard client sends (`x-api-key`, or `Authorization: Bearer`), so any
 * Anthropic- or OpenAI-style client can use its key setting as is.
 */
export function proxyKey(req: http.IncomingMessage): string | undefined {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
  const key = req.headers[PROXY_KEY_HEADER] || req.headers['x-api-key'] || bearer
  return typeof key === 'string' ? key : undefined
}
/** Optional client session scope (#226): per-session route pins for a remote bot. */
export const PROXY_SESSION_HEADER = 'x-roadie-session'
/** Pool catalog for registered clients: the rotations their pools serve. */
export const POOL_CATALOG_PATH = '/roadie/pool/catalog'
/** End a client session's turn: release its route pin. */
export const POOL_END_TURN_PATH = '/roadie/pool/end-turn'
/** Account management on a pool host, for admin clients (#238, credentials/pool-admin.ts). */
export const POOL_ADMIN_PATH = '/roadie/pool/admin/'

/**
 * What a client's pools can serve; a bot writes its Pi models from it.
 * `adaptiveRotations` travels with the rotations because only the pool host
 * holds their entries, and Opus 5.x returns no thinking or narration text
 * unless Pi requests adaptive thinking.
 */
export type PoolCatalog = { rotations: PoolRotations; adaptiveRotations: string[] }

export function poolCatalog({ dataDir, poolIds }: { dataDir: string; poolIds: string[] }): PoolCatalog {
  const rotations: PoolRotations = {}
  for (const poolId of poolIds) {
    const records = readPoolRotationRecords({ dataDir, poolId })
    if (records instanceof Error) continue
    for (const name of Object.keys(records).sort()) {
      const rotation = records[name]!
      // Pool order is routing priority; use the first pool's menu metadata.
      if (rotation.entries.length && !Object.hasOwn(rotations, name)) rotations[name] = rotation
    }
  }
  return { rotations, adaptiveRotations: adaptiveAnthropicRotations({ dataDir, poolIds, rotations: Object.keys(rotations) }) }
}

/** Pool provider id for ChatGPT (Codex) subscription accounts. */
export const CODEX_PROVIDER = 'openai-codex'

/**
 * Upstream statuses that end this candidate but not the request: rate limits,
 * auth and quota failures, and server errors. Any other status is the
 * request's own problem and goes back to the client.
 */
function fallsThrough(status: number): boolean {
  return status === 429 || status === 401 || status === 402 || status === 403 || status >= 500
}

/** Anthropic-shaped error body, so the client reports it like an upstream error. */
function errorResponse(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error', message } }))
}

export async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Request headers worth forwarding upstream; auth and hop-by-hop headers are rebuilt. */
function forwardHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (['host', 'connection', 'content-length', 'authorization', 'x-api-key', 'accept-encoding', PROXY_KEY_HEADER].includes(lower)) continue
    if (lower.startsWith('x-roadie-')) continue
    headers.set(lower, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('content-type', 'application/json')
  return headers
}

export async function pipeResponse(upstream: Response, res: http.ServerResponse) {
  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) headers[name] = value
  })
  res.writeHead(upstream.status, headers)
  if (!upstream.body) {
    res.end()
    return
  }
  await new Promise<void>((resolve) => {
    const stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
    stream.on('error', () => {
      res.destroy()
      resolve()
    })
    res.on('close', () => {
      stream.destroy()
      resolve()
    })
    stream.pipe(res)
  })
}

export type MessagesProxyOptions = {
  dataDir: string
  /** The session's comma-separated pool list; an Error fails the request closed. */
  resolvePools: (sessionId: string) => Promise<string | Error>
  fetchImpl?: PoolFetch
  upstreamUrl?: string
  /** Pre-resolved models.dev catalog for API-key base URLs (tests). Default: resolveCatalog. */
  catalog?: ModelsDevCatalog
  now?: () => number
  /** Serves POOL_ADMIN_PATH; only a pool host mounts it (credentials/serve.ts). */
  admin?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
  /** Listen address. Defaults to 127.0.0.1 on an ephemeral port. */
  host?: string
  port?: number
  /** Time to let active requests finish when closing the listener. */
  shutdownGraceMs?: number
}

export type MessagesProxy = {
  baseUrl: string
  /** A fresh key for one client process. `sessionId` is read per request (it can be set after spawn). */
  issueKey(sessionId: () => string | undefined): string
  revokeKey(key: string): void
  close(): Promise<void>
}

/** One candidate's outcome: it answered the client, or it failed before the response started. */
type Attempt = { served: true } | { served: false; status?: number; retryAfter?: string | null; message: string }

/** How a non-Anthropic candidate is reached through pi-ai. */
type TranslatedTarget = { model: Model<Api>; apiKey: string; headers: Record<string, string> }

export async function startMessagesProxy(options: MessagesProxyOptions): Promise<MessagesProxy> {
  const keys = new Map<string, () => string | undefined>()
  const fetchImpl = options.fetchImpl ?? fetch
  const upstreamUrl = options.upstreamUrl ?? ANTHROPIC_MESSAGES_URL
  const now = options.now ?? Date.now
  const getCatalog = async (): Promise<ModelsDevCatalog | Error> =>
    options.catalog ?? (await resolveCatalog({ dataDir: options.dataDir }))

  /**
   * Resolve a request's key to its session id and pool list. Session keys
   * (Pi channels) take their pools from the session; registered client keys
   * (#171) carry their own pools and a stable `client:<name>` session id.
   */
  async function authorize(req: http.IncomingMessage): Promise<{ sessionId: string; poolIds: string[]; client: boolean } | undefined> {
    const key = proxyKey(req)
    if (!key) return undefined
    const sessionId = keys.get(key)?.()
    if (sessionId) {
      const poolHeader = await options.resolvePools(sessionId)
      return { sessionId, poolIds: poolHeader instanceof Error ? [] : parsePoolListHeader(poolHeader), client: false }
    }
    const client = resolvePoolClient({ dataDir: options.dataDir, key })
    if (!client) return undefined
    // A malformed scope is ignored rather than trusted: it falls back to the
    // client's shared route, never to another client's.
    const rawScope = req.headers[PROXY_SESSION_HEADER]
    const scope = typeof rawScope === 'string' && POOL_CLIENT_SCOPE_PATTERN.test(rawScope) ? rawScope : undefined
    return { sessionId: poolClientSessionId(client.name, scope), poolIds: client.pools, client: true }
  }

  function json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const pathname = req.url?.split('?')[0] ?? ''
    if (options.admin && pathname.startsWith(POOL_ADMIN_PATH)) {
      await options.admin(req, res)
      return
    }
    if (pathname === POOL_CATALOG_PATH || pathname === POOL_END_TURN_PATH) {
      // Pool-management endpoints are for registered clients only; a Pi
      // process's session key has no business with them.
      const authorized = await authorize(req)
      if (!authorized?.client) {
        errorResponse(res, 401, 'unknown or missing roadie client key')
        return
      }
      if (pathname === POOL_CATALOG_PATH && req.method === 'GET') {
        json(res, 200, poolCatalog({ dataDir: options.dataDir, poolIds: authorized.poolIds }))
        return
      }
      if (pathname === POOL_END_TURN_PATH && req.method === 'POST') {
        await clearSessionRoute({ dataDir: options.dataDir, sessionId: authorized.sessionId }).catch(() => {})
        json(res, 200, { ok: true })
        return
      }
      errorResponse(res, 405, 'method not allowed')
      return
    }
    if (req.method !== 'POST' || !pathname.endsWith('/v1/messages')) {
      errorResponse(res, 404, 'not found')
      return
    }
    const authorized = await authorize(req)
    if (!authorized) {
      errorResponse(res, 401, 'unknown or missing roadie key')
      return
    }
    const { sessionId, poolIds } = authorized
    if (poolIds.length === 0) {
      errorResponse(res, 401, 'no credential pool for this session')
      return
    }
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse((await readRawBody(req)).toString('utf8')) as Record<string, unknown>
    } catch {
      errorResponse(res, 400, 'invalid JSON body')
      return
    }
    const rotationName = String(payload.model ?? '')
    const timestamp = now()
    const candidates = resolvePoolListCandidates({ poolIds, dataDir: options.dataDir, rotationName, now: timestamp })
      .flatMap((resolution) => resolution.candidates)
    if (candidates.length === 0) {
      errorResponse(res, 401, `no usable account in pools ${poolIds.join(',')} for ${rotationName}`)
      return
    }
    const held = heldCandidate({ sessionId, rotationName, candidates, dataDir: options.dataDir, now: timestamp })
    const ordered = held ? [held, ...candidates.filter((candidate) => candidate !== held)] : candidates
    // Translated candidates share one parse of the request.
    let translated: TranslatedRequest | undefined
    let rateLimited = false
    let firstError: string | undefined
    for (const candidate of ordered) {
      const account = await ensureFreshOAuthAccount({ dataDir: options.dataDir, poolId: candidate.poolId, account: candidate.account, now: timestamp, fetchImpl })
      if (account instanceof Error) {
        firstError ??= account.message
        continue
      }
      const pin = async () => {
        await setSessionRoute({
          dataDir: options.dataDir,
          sessionId,
          route: { poolId: candidate.poolId, accountId: account.id, provider: candidate.provider, modelId: candidate.modelId, rotation: rotationName, pinnedAt: timestamp },
          now: timestamp,
        }).catch(() => {})
        await markUsed({ dataDir: options.dataDir, poolId: candidate.poolId, accountId: account.id, now: timestamp }).catch(() => {})
      }
      let attempt: Attempt
      if (candidate.provider === 'anthropic') {
        attempt = await forwardAnthropic({ req, res, payload, candidate, account, pin })
      } else {
        const target = await translatedTarget({ candidate, account, sessionId })
        if (target instanceof Error) {
          firstError ??= target.message
          continue
        }
        translated ??= anthropicRequestToContext(payload, timestamp)
        attempt = await serveTranslated({ res, request: translated, target, pin })
      }
      if (attempt.served) return
      const xaiExhausted = candidate.provider === 'xai' && (
        (attempt.status === 402 && /Grok Build usage balance exhausted/i.test(attempt.message)) ||
        (attempt.status === 403 && /personal-team-blocked:spending-limit/i.test(attempt.message))
      )
      if (attempt.status === 429 || xaiExhausted) {
        rateLimited = true
        await markCooldown({
          dataDir: options.dataDir,
          poolId: candidate.poolId,
          accountId: candidate.account.id,
          untilMs: cooldownUntilFromRetryAfter({ retryAfter: attempt.retryAfter ?? null, now: timestamp }),
        }).catch(() => {})
        continue
      }
      firstError ??= `${candidate.provider}/${candidate.modelId}: ${attempt.message}`
      if (attempt.status !== undefined && !fallsThrough(attempt.status)) {
        errorResponse(res, attempt.status, attempt.message)
        return
      }
    }
    if (rateLimited && firstError === undefined) {
      errorResponse(res, 429, 'every account in the pool is rate limited')
      return
    }
    errorResponse(res, 502, firstError ?? 'no candidate answered')
  }

  /** An Anthropic candidate: the request goes upstream as is, with the account's auth. */
  async function forwardAnthropic({ req, res, payload, candidate, account, pin }: {
    req: http.IncomingMessage
    res: http.ServerResponse
    payload: Record<string, unknown>
    candidate: PoolCandidate
    account: PoolAccount
    pin: () => Promise<void>
  }): Promise<Attempt> {
    const body = JSON.stringify({ ...payload, model: candidate.modelId })
    const headers = forwardHeaders(req)
    let upstream: Response
    try {
      if (account.type === 'oauth') {
        const oauthFetch = makeAnthropicOAuthFetch({ accessToken: account.access, modelId: candidate.modelId, fetchImpl })
        upstream = await oauthFetch(upstreamUrl, { method: 'POST', headers, body })
      } else {
        headers.set('x-api-key', account.key)
        upstream = await fetchImpl(upstreamUrl, { method: 'POST', headers, body })
      }
    } catch (cause) {
      return { served: false, message: cause instanceof Error ? cause.message : String(cause) }
    }
    if (fallsThrough(upstream.status)) {
      const message = (await upstream.text().catch(() => '')).slice(0, 500) || `HTTP ${upstream.status}`
      return { served: false, status: upstream.status, retryAfter: upstream.headers.get('retry-after'), message }
    }
    if (upstream.ok) await pin()
    await pipeResponse(upstream, res)
    return { served: true }
  }

  /** Where a non-Anthropic candidate is served: its pi-ai model, credential and headers. */
  async function translatedTarget({ candidate, account, sessionId }: { candidate: PoolCandidate; account: PoolAccount; sessionId: string }): Promise<TranslatedTarget | Error> {
    if (candidate.provider === CODEX_PROVIDER) {
      if (account.type !== 'oauth') return new Error(`account ${account.id}: ChatGPT accounts must be OAuth`)
      return {
        model: piModelFor({ api: 'openai-codex-responses', provider: CODEX_PROVIDER, modelId: candidate.modelId, baseUrl: CODEX_RESPONSES_BASE_URL }),
        apiKey: account.access,
        headers: {},
      }
    }
    const xaiOAuth = candidate.provider === 'xai' && account.type === 'oauth'
    if (account.type !== 'api' && !xaiOAuth) return new Error(`account ${account.id}: ${candidate.provider} OAuth accounts are not routable through the pool proxy`)
    const catalog = xaiOAuth ? undefined : await getCatalog()
    const baseUrl = xaiOAuth ? XAI_API_BASE_URL : (account.type === 'api' ? account.baseURL : undefined) ?? (catalog instanceof Error ? undefined : catalog?.[candidate.provider]?.api)
    if (!baseUrl) return new Error(`provider ${candidate.provider} has no base URL in the models.dev catalog; add the account with a --base-url to route it as OpenAI-compatible`)
    return {
      model: piModelFor({ api: 'openai-completions', provider: candidate.provider, modelId: candidate.modelId, baseUrl: baseUrl.replace(/\/+$/, '') }),
      apiKey: account.type === 'oauth' ? account.access : account.key,
      // OpenCode Go keys its prompt cache by session; derive a stable opaque one.
      headers: candidate.provider === 'opencode-go' ? { 'x-opencode-session': crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32) } : {},
    }
  }

  /**
   * A non-Anthropic candidate through pi-ai, written back as Anthropic
   * Messages. Nothing reaches the client until the first content event, so a
   * failure before then is still the next candidate's to answer.
   */
  async function serveTranslated({ res, request, target, pin }: {
    res: http.ServerResponse
    request: TranslatedRequest
    target: TranslatedTarget
    pin: () => Promise<void>
  }): Promise<Attempt> {
    // A client that goes away mid-answer cancels the upstream call.
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) controller.abort()
    }
    res.once('close', onClose)
    // The upstream status, seen at the fetch: pi-ai's SDK clients raise on an
    // error status before any response callback, and a status is what decides
    // fall-through and cooldown.
    let response: Response | undefined
    const observedFetch = async (input: string | URL | Request, init?: RequestInit) => {
      response = await fetchImpl(input, init)
      return response
    }
    const events = piStream(target.model, request.context, {
      apiKey: target.apiKey,
      headers: target.headers,
      fetch: observedFetch as typeof fetch,
      signal: controller.signal,
      maxRetries: 0,
      transport: 'sse',
      ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.reasoningEffort && { reasoningEffort: request.reasoningEffort }),
    } as Parameters<typeof piStream>[2])
    const failure = (message: string): Attempt => ({
      served: false,
      ...(response && response.status >= 400 && { status: response.status, retryAfter: response.headers.get('retry-after') }),
      message,
    })
    if (!request.stream) {
      for await (const event of events) {
        if (event.type === 'error') return failure(event.error.errorMessage ?? 'upstream error')
        if (event.type === 'done') {
          await pin()
          json(res, 200, anthropicMessage({ message: event.message, model: target.model.id }))
          return { served: true }
        }
      }
      return failure('upstream stream ended without a response')
    }
    const writer = anthropicStreamWriter({ res, model: target.model.id })
    for await (const event of events) {
      if (!writer.started) {
        if (event.type === 'error') return failure(event.error.errorMessage ?? 'upstream error')
        if (event.type === 'start' || event.type === 'toolcall_start' || event.type === 'toolcall_delta') continue
        await pin()
      }
      if (writer.write(event)) return { served: true }
    }
    if (!writer.started) return failure('upstream stream ended without a response')
    res.end()
    return { served: true }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) errorResponse(res, 500, error instanceof Error ? error.message : String(error))
      else res.destroy()
    })
  })
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    issueKey(sessionId) {
      const key = crypto.randomBytes(24).toString('hex')
      keys.set(key, sessionId)
      return key
    },
    revokeKey(key) {
      keys.delete(key)
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      const timer = setTimeout(() => server.closeAllConnections(), options.shutdownGraceMs ?? 3_000)
      timer.unref()
    }),
  }
}
