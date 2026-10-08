// In-process HTTP server speaking the Hrana v2 protocol.
// Backed by the `libsql` npm package (better-sqlite3 API).
// Binds to the fixed lock port for single-instance enforcement.
//
// Protocol logic is implemented in the `libsqlproxy` package.
// This file handles: server lifecycle, single-instance enforcement,
// auth, and roadie-specific endpoints (/health, /roadie/opencode-port).
//
// Hrana v2 protocol spec ("Hrana over HTTP"):
//   https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'libsql'
import * as errore from 'errore'
import {
  createLibsqlHandler,
  createLibsqlNodeHandler,
  libsqlExecutor,
} from 'libsqlproxy'
import { createLogger, LogPrefix } from './logger.js'
import { ServerStartError, FetchError } from './errors.js'
import { getLockPort, getDataDir, readRoadieSecret } from './config.js'
import {
  buildRemoteSendArgs,
  getRemoteSendRunner,
  getSendToken,
  isAuthorizedSend,
  REMOTE_SEND_MAX_BODY_BYTES,
  type RemoteSendEvent,
} from './remote-send.js'
import { store } from './store.js'
// Circular import: opencode.ts → hrana-server.ts → opencode.ts.
// Safe because both sides only use lazy runtime function calls, never
// top-level initialization values. The cycle could be broken by moving
// the port into store.ts, but the current approach is simpler.
import { getOpencodeServerPort } from './opencode.js'

const hranaLogger = createLogger(LogPrefix.DB)

let db: Database.Database | null = null
let server: http.Server | null = null
let hranaUrl: string | null = null
let discordGatewayReady = false
let chatPlatform = 'discord'
let chatReady = false

export function markChatPlatformReady(platform: string, ready: boolean): void {
  chatPlatform = platform
  chatReady = ready
}

/** Record that the Discord connection is up (reported by /health consumers and tests). */
export function markDiscordGatewayReady(): void {
  discordGatewayReady = true
  markChatPlatformReady('discord', true)
}

export function isDiscordGatewayReady(): boolean {
  return discordGatewayReady
}

function getRequestAuthToken(req: http.IncomingMessage): string | null {
  const authorizationHeader = req.headers.authorization
  if (typeof authorizationHeader === 'string' && authorizationHeader.startsWith('Bearer ')) {
    return authorizationHeader.slice('Bearer '.length)
  }

  return null
}

// Timing-safe comparison of the service auth token.
function isAuthorizedRequest(req: http.IncomingMessage): boolean {
  const expectedToken = store.getState().gatewayToken
  if (!expectedToken) {
    return false
  }
  const providedToken = getRequestAuthToken(req)
  if (!providedToken) {
    return false
  }
  const expectedBuf = Buffer.from(expectedToken, 'utf8')
  const providedBuf = Buffer.from(providedToken, 'utf8')
  if (expectedBuf.length !== providedBuf.length) {
    return false
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf)
}

let automaticAuthTokenFile: string | null = null

function ensureServiceAuthTokenInStore(): string {
  const existingToken = store.getState().gatewayToken
  if (existingToken) {
    return existingToken
  }
  let token = readRoadieSecret('ROADIE_DB_AUTH_TOKEN')
  if (!token) {
    const file = path.join(getDataDir(), 'secrets', 'db-auth-token')
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      fs.writeFileSync(file, `${crypto.randomUUID()}:${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    process.env.ROADIE_DB_AUTH_TOKEN_FILE = file
    automaticAuthTokenFile = file
    token = readRoadieSecret('ROADIE_DB_AUTH_TOKEN')
  }
  if (!token) throw new Error('Roadie database service credential is unavailable')
  store.setState({ gatewayToken: token })
  return token
}

/**
 * Get the Hrana HTTP URL for injecting into plugin child processes.
 * Returns null if the server hasn't been started yet.
 * Only used for ROADIE_DB_URL env var in opencode.ts — the bot process
  * itself always uses direct file: access via Drizzle/libSQL.
 */
export function getHranaUrl(): string | null {
  return hranaUrl
}

/**
 * Start the in-process Hrana v2 server on the fixed lock port.
 * Handles single-instance enforcement: if the port is occupied, kills the
 * existing process first.
 */
export async function startHranaServer({
  dbPath,
}: {
  dbPath: string
}) {
  if (server && db && hranaUrl) return hranaUrl

  const port = getLockPort()
  const bindHost = '127.0.0.1'
  const serviceAuthToken = ensureServiceAuthTokenInStore()
  if (!process.env.ROADIE_DB_AUTH_TOKEN_FILE) process.env.ROADIE_DB_AUTH_TOKEN = serviceAuthToken

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  await evictExistingInstance({ port })

  hranaLogger.log(
    `Starting hrana server on ${bindHost}:${port} with db: ${dbPath}`,
  )

  const database = new Database(dbPath)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA busy_timeout = 5000')
  db = database

  // Create the Hrana handler using libsqlproxy
  const hranaFetchHandler = createLibsqlHandler(libsqlExecutor(database))
  const hranaNodeHandler = createLibsqlNodeHandler(hranaFetchHandler)

  // Combined handler: roadie-specific endpoints + hrana protocol
  const handler: http.RequestListener = async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname
    // Health check — no auth required
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', pid: process.pid, wrapperPid: getWrapperPid(), discordReady: discordGatewayReady, chatPlatform, chatReady }))
      return
    }
    // OpenCode server port discovery — no auth required (localhost only).
    // CLI subcommands query this to reuse the bot's running OpenCode server
    // instead of spawning a redundant second server process.
    if (pathname === '/roadie/opencode-port') {
      const port = getOpencodeServerPort()
      if (port === null) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'no_opencode_server' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ port }))
      return
    }
    // Cross-user send. Disabled unless the host configured a send token.
    if (pathname === '/roadie/send') {
      await handleRemoteSend(req, res)
      return
    }
    // Hrana routes: /v2, /v2/pipeline — require auth
    if (pathname === '/v2' || pathname === '/v2/pipeline') {
      if (!isAuthorizedRequest(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      hranaNodeHandler(req, res)
      return
    }
    res.writeHead(404)
    res.end()
  }

  const started = await new Promise<ServerStartError | true>((resolve) => {
    const srv = http.createServer(handler)

    srv.on('error', (err) => {
      const code = 'code' in err ? err.code : undefined
      resolve(
        new ServerStartError({
          port,
          reason:
            code === 'EADDRINUSE'
              ? `Port ${port} still in use after eviction`
              : err.message,
        }),
      )
    })
    srv.listen(port, bindHost, () => {
      server = srv
      resolve(true)
    })
  })
  if (started instanceof Error) {
    database.close()
    db = null
    return started
  }

  hranaUrl = `http://127.0.0.1:${port}`
  hranaLogger.log(`Hrana server ready at ${hranaUrl}`)
  return hranaUrl
}

/**
 * Stop the Hrana server and close the database.
 */
export async function stopHranaServer() {
  if (server) {
    hranaLogger.log('Stopping hrana server...')
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve()
      })
    })
    server = null
  }
  if (db) {
    db.close()
    db = null
  }
  hranaUrl = null
  discordGatewayReady = false
  chatReady = false
  if (automaticAuthTokenFile && process.env.ROADIE_DB_AUTH_TOKEN_FILE === automaticAuthTokenFile) {
    delete process.env.ROADIE_DB_AUTH_TOKEN_FILE
  }
  automaticAuthTokenFile = null
  hranaLogger.log('Hrana server stopped')
}

// ── Cross-user send ──────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | Error> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) return new Error(`Body exceeds ${limit} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function handleRemoteSend(req: http.IncomingMessage, res: http.ServerResponse) {
  const token = getSendToken()
  if (!token) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'send endpoint not configured' }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (!isAuthorizedSend(req.headers.authorization, token)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  const body = await readBody(req, REMOTE_SEND_MAX_BODY_BYTES)
  if (body instanceof Error) {
    res.writeHead(413, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: body.message }))
    return
  }
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-send-'))
  try {
    let args: string[]
    try {
      args = buildRemoteSendArgs(JSON.parse(body.toString('utf8')), fileDir)
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      return
    }
    hranaLogger.log(`Remote send: ${args.filter((arg) => !arg.startsWith('--prompt=')).join(' ')}`)
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const emit = (event: RemoteSendEvent) => {
      res.write(`${JSON.stringify(event)}\n`)
    }
    // `send --wait` can stay quiet for a long time; keep idle timeouts away.
    const keepalive = setInterval(() => emit({ keepalive: true }), 20_000)
    const exit = await getRemoteSendRunner()(args, emit).finally(() => clearInterval(keepalive))
    emit({ exit })
    res.end()
  } finally {
    fs.rmSync(fileDir, { recursive: true, force: true })
  }
}

// ── Single-instance enforcement ──────────────────────────────────────

/**
 * Evict a previous roadie instance on the lock port.
 * Fetches /health to get the running process PID, then kills it directly.
 * No lsof/netstat/spawnSync needed — the PID comes from the health response.
 *
 * SIGTERM first so the old bot can clean up. Its own shutdown deadline is
 * 15s, so after a longer grace period we SIGKILL: a stuck process must never
 * block every future start. Safe because the PID comes from our own /health.
 */
export async function evictExistingInstance({
  port,
  gracePeriodMs = 20_000,
}: {
  port: number
  gracePeriodMs?: number
}) {
  const url = `http://127.0.0.1:${port}/health`

  const probe = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(
    (e) => new FetchError({ url, cause: e }),
  )
  if (probe instanceof Error) return

  const body = await (probe.json() as Promise<{ pid?: number; wrapperPid?: number | null }>).catch(
    (e) => new FetchError({ url, cause: e }),
  )
  if (body instanceof Error || !body) return

  const targetPid = body.pid
  if (!targetPid || targetPid === process.pid) return
  // Signal the bin.ts wrapper, not only the child: killing just the child
  // looks like a crash and the old wrapper respawns it, which then evicts us.
  // The wrapper forwards SIGTERM and does not restart after it.
  const wrapperPid = body.wrapperPid && body.wrapperPid !== process.ppid
    ? body.wrapperPid
    : null

  hranaLogger.log(
    `Evicting existing roadie process (PID: ${targetPid}, wrapper: ${wrapperPid ?? 'none'}) on port ${port}`,
  )
  const killResult = errore.try(
    { try: () => {
      process.kill(wrapperPid ?? targetPid, 'SIGTERM')
    }, catch: (e) =>
      new Error('Failed to send SIGTERM to existing roadie process', {
        cause: e,
      }) },
  )
  if (killResult instanceof Error) {
    hranaLogger.log(`Failed to kill PID ${targetPid}: ${killResult.message}`)
    return
  }

  // Wait for process exit, not just a failed probe: a process that already
  // closed its HTTP server can still be alive and holding the socket briefly.
  if (await waitForProcessExit({ pid: targetPid, timeoutMs: gracePeriodMs })) {
    return
  }

  hranaLogger.log(
    `PID ${targetPid} still alive after ${gracePeriodMs / 1000}s SIGTERM grace period, sending SIGKILL`,
  )
  // Wrapper first so it cannot respawn the child we are about to kill.
  const wrapperKillResult = wrapperPid
    ? errore.try(
        { try: () => {
          process.kill(wrapperPid, 'SIGKILL')
        }, catch: (e) => new Error('Failed to send SIGKILL to roadie wrapper', { cause: e }) },
      )
    : null
  if (wrapperKillResult instanceof Error) {
    hranaLogger.log(`Failed to kill wrapper PID ${wrapperPid}: ${wrapperKillResult.message}`)
  }
  const forceKillResult = errore.try(
    { try: () => {
      process.kill(targetPid, 'SIGKILL')
    }, catch: (e) =>
      new Error('Failed to send SIGKILL to existing roadie process', {
        cause: e,
      }) },
  )
  if (forceKillResult instanceof Error) {
    hranaLogger.log(`Failed to kill PID ${targetPid}: ${forceKillResult.message}`)
    return
  }
  if (await waitForProcessExit({ pid: targetPid, timeoutMs: 5_000 })) {
    return
  }
  hranaLogger.log(`PID ${targetPid} still alive after SIGKILL`)
}

// PID of the bin.ts respawn wrapper, only while it is alive (IPC connected).
// Without the connected check an orphan would report ppid 1.
function getWrapperPid(): number | null {
  if (!process.env.__ROADIE_CHILD || !process.connected) {
    return null
  }
  return process.ppid
}

function isProcessAlive(pid: number): boolean {
  const result = errore.try(
    { try: () => {
      process.kill(pid, 0)
    }, catch: (e) => new Error('Process liveness check failed', { cause: e }) },
  )
  if (result instanceof Error) {
    // EPERM means the PID exists but belongs to another user.
    return result.cause instanceof Error && Reflect.get(result.cause, 'code') === 'EPERM'
  }
  return true
}

async function waitForProcessExit({
  pid,
  timeoutMs,
}: {
  pid: number
  timeoutMs: number
}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
  }
  return !isProcessAlive(pid)
}
