// Remote credential pool (#226): a bot with no accounts relays Pi requests to
// a pool host under its client key, with per-session route pins on the host.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { POOL_CATALOG_PATH, POOL_END_TURN_PATH, startMessagesProxy, type MessagesProxy } from './messages-proxy.js'
import { addPoolClient } from './pool-clients.js'
import { addPoolOAuthAccount, setPoolRotation, SHARED_POOL_ID } from './store.js'
import { readSessionRoute } from './routes.js'
import { fetchRemotePoolCatalog, readRemotePoolConfig, startRemotePoolRelay, type RemotePoolRelay } from './remote-pool.js'

const tempDir = () => fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'remote-pool-'))

let host: MessagesProxy | undefined
let relay: RemotePoolRelay | undefined
afterEach(async () => {
  await relay?.close()
  await host?.close()
  relay = undefined
  host = undefined
})

/** A pool host with one Anthropic account, a rotation and a registered `mac-bot` client. */
async function poolHost() {
  const dataDir = tempDir()
  const account = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', label: 'a', refresh: 'refresh-a', access: 'access-a', expires: Date.now() + 3_600_000 })
  if (account instanceof Error) throw account
  await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'claude-best', entries: ['anthropic/claude-opus-4-8'] })
  const client = addPoolClient({ dataDir, name: 'mac-bot' })
  if (client instanceof Error) throw client
  const upstream: Array<{ url: string; headers: Headers }> = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    upstream.push({ url: String(input), headers: new Headers(init?.headers) })
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  // Headless: no sessions resolve on the host, only client keys.
  host = await startMessagesProxy({ dataDir, resolvePools: async () => new Error('no sessions'), fetchImpl })
  return { dataDir, key: client.key, upstream, host }
}

const ask = (baseUrl: string, key: string) =>
  fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-roadie-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-best', max_tokens: 8, messages: [] }) })

describe('readRemotePoolConfig', () => {
  test('unset means a local pool', () => {
    expect(readRemotePoolConfig({})).toBeUndefined()
  })

  test('requires a URL and a readable, non-empty key file', () => {
    const dir = tempDir()
    const keyFile = path.join(dir, 'pool-key')
    expect(readRemotePoolConfig({ ROADIE_POOL_URL: 'not a url' })).toBeInstanceOf(Error)
    expect(readRemotePoolConfig({ ROADIE_POOL_URL: 'http://100.64.0.1:47120' })).toBeInstanceOf(Error)
    expect(readRemotePoolConfig({ ROADIE_POOL_URL: 'http://100.64.0.1:47120', ROADIE_POOL_KEY_FILE: keyFile })).toBeInstanceOf(Error)
    fs.writeFileSync(keyFile, '  \n')
    expect(readRemotePoolConfig({ ROADIE_POOL_URL: 'http://100.64.0.1:47120', ROADIE_POOL_KEY_FILE: keyFile })).toBeInstanceOf(Error)
    fs.writeFileSync(keyFile, 'rpk_test\n')
    expect(readRemotePoolConfig({ ROADIE_POOL_URL: 'http://100.64.0.1:47120/', ROADIE_POOL_KEY_FILE: keyFile })).toEqual({ url: 'http://100.64.0.1:47120', key: 'rpk_test' })
  })
})

describe('pool host client endpoints', () => {
  test('the catalog lists what the client pools serve, for client keys only', async () => {
    const { key, host } = await poolHost()
    expect(await fetchRemotePoolCatalog({ config: { url: host.baseUrl, key } })).toEqual({ rotations: ['claude-best'] })
    expect(await fetchRemotePoolCatalog({ config: { url: host.baseUrl, key: 'wrong' } })).toBeInstanceOf(Error)
    // A Pi process's session key is not a client key.
    const sessionKey = host.issueKey(() => 'sess')
    expect((await fetch(`${host.baseUrl}${POOL_CATALOG_PATH}`, { headers: { 'x-roadie-key': sessionKey } })).status).toBe(401)
  })
})

describe('startRemotePoolRelay', () => {
  test('forwards a session request under the client key and pins the route per session on the host', async () => {
    const { dataDir, key, upstream, host } = await poolHost()
    relay = await startRemotePoolRelay({ config: { url: host.baseUrl, key } })
    const one = relay.issueKey(() => 'session-one')
    const two = relay.issueKey(() => 'session-two')

    const first = await ask(relay.baseUrl, one)
    expect(first.status).toBe(200)
    await first.text()
    const second = await ask(relay.baseUrl, two)
    expect(second.status).toBe(200)
    await second.text()

    expect(upstream).toHaveLength(2)
    // Pool credentials go upstream from the host; the relay's keys never do.
    for (const call of upstream) {
      expect(call.headers.get('x-roadie-key')).toBeNull()
      expect(call.headers.get('x-roadie-session')).toBeNull()
    }
    const routeOf = (sessionId: string) => {
      const route = readSessionRoute({ dataDir, sessionId, now: Date.now() })
      return route instanceof Error ? undefined : route
    }
    expect(routeOf('client:mac-bot/session-one')?.poolId).toBe(SHARED_POOL_ID)
    expect(routeOf('client:mac-bot/session-two')?.poolId).toBe(SHARED_POOL_ID)

    await relay.endTurn('session-one')
    expect(routeOf('client:mac-bot/session-one') ?? undefined).toBeUndefined()
    expect(routeOf('client:mac-bot/session-two')?.poolId).toBe(SHARED_POOL_ID)
  })

  test('refuses unknown and revoked keys before contacting the host', async () => {
    const { key, upstream, host } = await poolHost()
    relay = await startRemotePoolRelay({ config: { url: host.baseUrl, key } })
    const issued = relay.issueKey(() => 'session-one')
    relay.revokeKey(issued)
    expect((await ask(relay.baseUrl, issued)).status).toBe(401)
    expect((await ask(relay.baseUrl, 'never-issued')).status).toBe(401)
    expect(upstream).toHaveLength(0)
  })

  test('a host that rejects the client key fails the request closed', async () => {
    const { upstream, host } = await poolHost()
    relay = await startRemotePoolRelay({ config: { url: host.baseUrl, key: 'revoked-client-key' } })
    const response = await ask(relay.baseUrl, relay.issueKey(() => 'session-one'))
    expect(response.status).toBe(401)
    expect(upstream).toHaveLength(0)
  })

  test('an unreachable host is a 502, not a hang', async () => {
    relay = await startRemotePoolRelay({ config: { url: 'http://127.0.0.1:9', key: 'k' }, retryWindowMs: 30, retryDelayMs: 5 })
    expect((await ask(relay.baseUrl, relay.issueKey(() => 'session-one'))).status).toBe(502)
  })

  test('retries connection failures until the host comes up', async () => {
    const { createServer } = await import('node:http')
    const probe = await import('node:net')
    const reservation = probe.createServer()
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
    const { port } = reservation.address() as import('node:net').AddressInfo
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    relay = await startRemotePoolRelay({ config: { url: `http://127.0.0.1:${port}`, key: 'k' }, retryWindowMs: 1_000, retryDelayMs: 10 })
    const key = relay.issueKey(() => 'session-one')
    const pending = ask(relay.baseUrl, key)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const host = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise<void>((resolve) => host.listen(port, '127.0.0.1', resolve))
    try { expect((await pending).status).toBe(200) } finally { await new Promise<void>((resolve) => host.close(() => resolve())) }
  })

  test('does not retry after receiving a response', async () => {
    let calls = 0
    relay = await startRemotePoolRelay({ config: { url: 'http://127.0.0.1:9', key: 'k' }, retryWindowMs: 100, retryDelayMs: 5,
      fetchImpl: async () => { calls++; if (calls === 1) return new Response('started', { status: 503 }); throw new Error('should not retry') },
    })
    expect((await ask(relay.baseUrl, relay.issueKey(() => 'session-one'))).status).toBe(503)
    expect(calls).toBe(1)
  })

  test('end-turn needs a client key on the host', async () => {
    const { host } = await poolHost()
    expect((await fetch(`${host.baseUrl}${POOL_END_TURN_PATH}`, { method: 'POST' })).status).toBe(401)
  })
})
