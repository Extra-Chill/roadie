// Remote credential pool for a Roadie bot (#226).
//
// With ROADIE_POOL_URL set, the bot keeps no accounts of its own: a headless
// pool host (`roadie credentials serve`) owns them, and this bot is one of its
// registered clients. Pi processes are configured exactly as with a local
// pool: a loopback endpoint and a per-process key. Only what sits behind that
// endpoint changes. Instead of resolving accounts, this relay maps the key to
// the bot session and forwards the request to the pool host with the bot's
// client key and the session as its scope, so each session keeps its own
// route pin on the host. Credentials never reach this machine.
//
//   ROADIE_POOL_URL       pool host base URL, e.g. http://100.101.19.112:47120
//   ROADIE_POOL_KEY_FILE  file holding this bot's client key (`client add`)

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  POOL_CATALOG_PATH,
  POOL_END_TURN_PATH,
  PROXY_KEY_HEADER,
  PROXY_SESSION_HEADER,
  pipeResponse,
  readRawBody,
  type PoolCatalog,
} from './messages-proxy.js'
import { POOL_CLIENT_SCOPE_PATTERN } from './pool-clients.js'

export type RemotePoolConfig = { url: string; key: string }
type RelayFetch = (input: string, init?: RequestInit) => Promise<Response>

/** The configured remote pool, undefined when this bot uses its local pool. */
export function readRemotePoolConfig(env: NodeJS.ProcessEnv = process.env): RemotePoolConfig | undefined | Error {
  const url = env['ROADIE_POOL_URL']?.trim()
  if (!url) return undefined
  if (!/^https?:\/\/[^\s]+$/.test(url)) return new Error(`ROADIE_POOL_URL must be an http(s) URL, got "${url}"`)
  const keyFile = env['ROADIE_POOL_KEY_FILE']?.trim()
  if (!keyFile) return new Error('ROADIE_POOL_URL is set but ROADIE_POOL_KEY_FILE is not: the bot needs its pool client key')
  let key: string
  try {
    key = fs.readFileSync(keyFile, 'utf8').trim()
  } catch (cause) {
    return new Error(`cannot read ROADIE_POOL_KEY_FILE ${keyFile}`, { cause })
  }
  if (!key) return new Error(`ROADIE_POOL_KEY_FILE ${keyFile} is empty`)
  return { url: url.replace(/\/+$/, ''), key }
}

/** The rotations and models the pool host serves this client. */
export async function fetchRemotePoolCatalog({ config, fetchImpl = fetch }: { config: RemotePoolConfig; fetchImpl?: RelayFetch }): Promise<PoolCatalog | Error> {
  const response = await fetchImpl(`${config.url}${POOL_CATALOG_PATH}`, { headers: { [PROXY_KEY_HEADER]: config.key } })
    .catch((cause: unknown) => new Error(`pool host ${config.url} is unreachable`, { cause }))
  if (response instanceof Error) return response
  if (!response.ok) return new Error(`pool host ${config.url} refused the catalog request (HTTP ${response.status}); check this bot's client key`)
  const body = (await response.json().catch(() => undefined)) as Partial<PoolCatalog> | undefined
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  return { rotations: list(body?.rotations), openaiRotations: list(body?.openaiRotations), codexModels: list(body?.codexModels) }
}

export type RemotePoolRelay = {
  baseUrl: string
  issueKey(sessionId: () => string | undefined): string
  revokeKey(key: string): void
  /** Release the session's route pin on the pool host. */
  endTurn(sessionId: string): Promise<void>
  close(): Promise<void>
}

const MODEL_PATHS = ['/v1/messages', '/chat/completions', '/codex/responses']
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'])

function sessionHeader(sessionId: string): Record<string, string> {
  return POOL_CLIENT_SCOPE_PATTERN.test(sessionId) ? { [PROXY_SESSION_HEADER]: sessionId } : {}
}

export async function startRemotePoolRelay({
  config,
  fetchImpl = fetch,
}: {
  config: RemotePoolConfig
  fetchImpl?: RelayFetch
}): Promise<RemotePoolRelay> {
  const keys = new Map<string, () => string | undefined>()

  function reject(res: http.ServerResponse, status: number, message: string) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message } }))
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const pathname = req.url?.split('?')[0] ?? ''
    if (req.method !== 'POST' || !MODEL_PATHS.some((path) => pathname.endsWith(path))) {
      reject(res, 404, 'not found')
      return
    }
    const key = req.headers[PROXY_KEY_HEADER]
    const sessionId = typeof key === 'string' ? keys.get(key)?.() : undefined
    if (!sessionId) {
      reject(res, 401, 'unknown or missing roadie key')
      return
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase()
      if (value === undefined || HOP_HEADERS.has(lower) || lower.startsWith('x-roadie-')) continue
      headers[lower] = Array.isArray(value) ? value.join(', ') : value
    }
    Object.assign(headers, { [PROXY_KEY_HEADER]: config.key }, sessionHeader(sessionId))
    const body = await readRawBody(req)
    const upstream = await fetchImpl(`${config.url}${req.url ?? pathname}`, { method: 'POST', headers, body })
      .catch((cause: unknown) => new Error(cause instanceof Error ? cause.message : String(cause)))
    if (upstream instanceof Error) {
      reject(res, 502, `pool host ${config.url} is unreachable: ${upstream.message}`)
      return
    }
    await pipeResponse(upstream, res)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) reject(res, 500, error instanceof Error ? error.message : String(error))
      else res.destroy()
    })
  })
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    issueKey(sessionId) {
      const issued = crypto.randomBytes(24).toString('hex')
      keys.set(issued, sessionId)
      return issued
    },
    revokeKey(issued) {
      keys.delete(issued)
    },
    async endTurn(sessionId) {
      await fetchImpl(`${config.url}${POOL_END_TURN_PATH}`, { method: 'POST', headers: { [PROXY_KEY_HEADER]: config.key, ...sessionHeader(sessionId) } })
        .then((response) => response.body?.cancel())
        .catch(() => {})
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
