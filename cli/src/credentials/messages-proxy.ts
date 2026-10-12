// Credential-pool proxy for backends that speak HTTP instead of AI SDK (Pi, #51).
//
// A loopback Anthropic Messages endpoint in the bot process. A client sends a
// normal `POST /v1/messages` whose `model` is a pool rotation name and whose
// `x-roadie-key` header is a key Roadie handed that client's process. The
// proxy maps the key to a session, resolves the session's pool list, and runs
// the same routing as the OpenCode pool provider (./provider.ts): ordered
// candidates per pool, the session's held route first, OAuth refresh,
// Anthropic OAuth shaping (Claude Code identity, betas, tool names), cooldown
// on 429 and the next candidate, route pin and last-used on success.
//
// Credentials never leave Roadie. Only `anthropic` candidates are served; any
// other provider in a rotation is skipped (it needs its own wire format).

import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { markCooldown, resolveCandidates } from './router.js'
import { markUsed, readPoolAccounts, readPoolState } from './store.js'
import { CODEX_RESPONSES_URL, codexAccountId } from './adapters/openai-codex-oauth.js'
import { setSessionRoute } from './routes.js'
import { parsePoolListHeader } from './person-pool.js'
import { poolClientSessionId, resolvePoolClient } from './pool-clients.js'
import {
  cooldownUntilFromRetryAfter,
  ensureFreshOAuthAccount,
  heldCandidate,
  makeAnthropicOAuthFetch,
  resolvePoolListCandidates,
  type PoolFetch,
} from './provider.js'

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
export const PROXY_KEY_HEADER = 'x-roadie-key'
/** Pool provider id for ChatGPT (Codex) subscription accounts. */
export const CODEX_PROVIDER = 'openai-codex'
/** Route-pin rotation name for Codex: accounts rotate, the model is the client's. */
const CODEX_ROTATION = 'codex'

/** Anthropic-shaped error body, so the client reports it like an upstream error. */
function errorResponse(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'authentication_error', message } }))
}

async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
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

async function pipeResponse(upstream: Response, res: http.ServerResponse) {
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
  codexUrl?: string
  now?: () => number
  /** Listen address. Defaults to 127.0.0.1 on an ephemeral port. */
  host?: string
  port?: number
}

export type MessagesProxy = {
  baseUrl: string
  /** A fresh key for one client process. `sessionId` is read per request (it can be set after spawn). */
  issueKey(sessionId: () => string | undefined): string
  revokeKey(key: string): void
  close(): Promise<void>
}

export async function startMessagesProxy(options: MessagesProxyOptions): Promise<MessagesProxy> {
  const keys = new Map<string, () => string | undefined>()
  const fetchImpl = options.fetchImpl ?? fetch
  const upstreamUrl = options.upstreamUrl ?? ANTHROPIC_MESSAGES_URL
  const codexUrl = options.codexUrl ?? CODEX_RESPONSES_URL
  const now = options.now ?? Date.now

  /**
   * Resolve a request's key to its session id and pool list. Session keys
   * (Pi channels) take their pools from the session; registered client keys
   * (#171) carry their own pools and a stable `client:<name>` session id.
   */
  async function authorize(req: http.IncomingMessage): Promise<{ sessionId: string; poolIds: string[] } | undefined> {
    const key = req.headers[PROXY_KEY_HEADER]
    if (typeof key !== 'string' || key === '') return undefined
    const sessionId = keys.get(key)?.()
    if (sessionId) {
      const poolHeader = await options.resolvePools(sessionId)
      return { sessionId, poolIds: poolHeader instanceof Error ? [] : parsePoolListHeader(poolHeader) }
    }
    const client = resolvePoolClient({ dataDir: options.dataDir, key })
    if (!client) return undefined
    return { sessionId: poolClientSessionId(client.name), poolIds: client.pools }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const pathname = req.url?.split('?')[0] ?? ''
    if (req.method === 'POST' && pathname.endsWith('/codex/responses')) {
      await handleCodex(req, res)
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
    const raw = await readBody(req)
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      errorResponse(res, 400, 'invalid JSON body')
      return
    }
    const rotationName = String(payload.model ?? '')
    const timestamp = now()
    const candidates = resolvePoolListCandidates({ poolIds, dataDir: options.dataDir, rotationName, now: timestamp })
      .flatMap((resolution) => resolution.candidates)
      .filter((candidate) => candidate.provider === 'anthropic')
    if (candidates.length === 0) {
      errorResponse(res, 401, `no usable anthropic account in pools ${poolIds.join(',')} for ${rotationName}`)
      return
    }
    const held = heldCandidate({ sessionId, rotationName, candidates, dataDir: options.dataDir, now: timestamp })
    const ordered = held ? [held, ...candidates.filter((candidate) => candidate !== held)] : candidates
    let lastRateLimited: Response | undefined
    let firstError: string | undefined
    for (const candidate of ordered) {
      const account = await ensureFreshOAuthAccount({ dataDir: options.dataDir, poolId: candidate.poolId, account: candidate.account, now: timestamp, fetchImpl })
      if (account instanceof Error) {
        firstError ??= account.message
        continue
      }
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
        firstError ??= cause instanceof Error ? cause.message : String(cause)
        continue
      }
      if (upstream.status === 429) {
        lastRateLimited = upstream
        await markCooldown({
          dataDir: options.dataDir,
          poolId: candidate.poolId,
          accountId: candidate.account.id,
          untilMs: cooldownUntilFromRetryAfter({ retryAfter: upstream.headers.get('retry-after'), now: timestamp }),
        }).catch(() => {})
        await upstream.body?.cancel().catch(() => {})
        continue
      }
      if (upstream.ok) {
        await setSessionRoute({
          dataDir: options.dataDir,
          sessionId,
          route: { poolId: candidate.poolId, accountId: account.id, provider: candidate.provider, modelId: candidate.modelId, rotation: rotationName, pinnedAt: timestamp },
          now: timestamp,
        }).catch(() => {})
        await markUsed({ dataDir: options.dataDir, poolId: candidate.poolId, accountId: account.id, now: timestamp }).catch(() => {})
      }
      await pipeResponse(upstream, res)
      return
    }
    if (lastRateLimited) {
      errorResponse(res, 429, 'every account in the pool is rate limited')
      return
    }
    errorResponse(res, 502, firstError ?? 'no candidate answered')
  }

  /**
   * ChatGPT (Codex) Responses requests: the body passes through untouched
   * (Pi compresses it); the pool picks a ChatGPT account per request and
   * supplies its bearer token and account id. Rotation is by account only.
   */
  async function handleCodex(req: http.IncomingMessage, res: http.ServerResponse) {
    const authorized = await authorize(req)
    if (!authorized) {
      errorResponse(res, 401, 'unknown or missing roadie key')
      return
    }
    const { sessionId, poolIds } = authorized
    const timestamp = now()
    const candidates = poolIds.flatMap((poolId) => {
      const accounts = readPoolAccounts({ dataDir: options.dataDir, poolId })
      const state = readPoolState({ dataDir: options.dataDir, poolId })
      if (accounts instanceof Error || state instanceof Error) return []
      return resolveCandidates({ poolId, rotation: [`${CODEX_PROVIDER}/${CODEX_ROTATION}`], accounts, cooldowns: state.cooldowns, now: timestamp })
    })
    if (candidates.length === 0) {
      errorResponse(res, 401, `no usable ChatGPT account in pools ${poolIds.join(',') || '(none)'}`)
      return
    }
    const held = heldCandidate({ sessionId, rotationName: CODEX_ROTATION, candidates, dataDir: options.dataDir, now: timestamp })
    const ordered = held ? [held, ...candidates.filter((candidate) => candidate !== held)] : candidates
    const body = await readRawBody(req)
    let rateLimited = false
    let firstError: string | undefined
    for (const candidate of ordered) {
      const account = await ensureFreshOAuthAccount({ dataDir: options.dataDir, poolId: candidate.poolId, account: candidate.account, now: timestamp, fetchImpl })
      if (account instanceof Error || account.type !== 'oauth') {
        firstError ??= account instanceof Error ? account.message : 'ChatGPT accounts must be OAuth'
        continue
      }
      const accountId = codexAccountId(account.access)
      if (!accountId) {
        firstError ??= `account ${account.id} has no ChatGPT account id`
        continue
      }
      const headers = forwardHeaders(req)
      const encoding = req.headers['content-encoding']
      if (typeof encoding === 'string') headers.set('content-encoding', encoding)
      headers.set('authorization', `Bearer ${account.access}`)
      headers.set('chatgpt-account-id', accountId)
      let upstream: Response
      try {
        upstream = await fetchImpl(codexUrl, { method: 'POST', headers, body })
      } catch (cause) {
        firstError ??= cause instanceof Error ? cause.message : String(cause)
        continue
      }
      if (upstream.status === 429) {
        rateLimited = true
        await markCooldown({
          dataDir: options.dataDir,
          poolId: candidate.poolId,
          accountId: candidate.account.id,
          untilMs: cooldownUntilFromRetryAfter({ retryAfter: upstream.headers.get('retry-after'), now: timestamp }),
        }).catch(() => {})
        await upstream.body?.cancel().catch(() => {})
        continue
      }
      if (upstream.ok) {
        await setSessionRoute({
          dataDir: options.dataDir,
          sessionId,
          route: { poolId: candidate.poolId, accountId: account.id, provider: candidate.provider, modelId: candidate.modelId, rotation: CODEX_ROTATION, pinnedAt: timestamp },
          now: timestamp,
        }).catch(() => {})
        await markUsed({ dataDir: options.dataDir, poolId: candidate.poolId, accountId: account.id, now: timestamp }).catch(() => {})
      }
      await pipeResponse(upstream, res)
      return
    }
    errorResponse(res, rateLimited ? 429 : 502, rateLimited ? 'every ChatGPT account in the pool is rate limited' : (firstError ?? 'no candidate answered'))
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
