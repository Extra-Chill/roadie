// External pool clients (#171): persisted hashed keys, their own pools, a
// stable session id, immediate revocation, and a configurable proxy address.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { startMessagesProxy, type MessagesProxy } from './messages-proxy.js'
import { addPoolClient, poolClientsPath, readPoolClients, removePoolClient, resolvePoolClient } from './pool-clients.js'
import { addPoolOAuthAccount, setPoolRotation, SHARED_POOL_ID } from './store.js'
import { readSessionRoute } from './routes.js'
import { piPoolListenOptions } from '../agent-backend/pi/pool-startup.js'

const tempDir = () => fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-clients-'))

let proxy: MessagesProxy | undefined
afterEach(async () => {
  await proxy?.close()
  proxy = undefined
})

describe('pool client store', () => {
  test('add returns the key once and persists only its hash, 0600', () => {
    const dataDir = tempDir()
    const added = addPoolClient({ dataDir, name: 'homeboy-lab', pools: ['shared', 'shared'] })
    if (added instanceof Error) throw added

    const raw = fs.readFileSync(poolClientsPath(dataDir), 'utf8')
    expect(raw).not.toContain(added.key)
    expect(raw).toContain(added.client.keyHash)
    expect(fs.statSync(poolClientsPath(dataDir)).mode & 0o777).toBe(0o600)
    expect(added.client.pools).toEqual(['shared'])
    expect(resolvePoolClient({ dataDir, key: added.key })?.name).toBe('homeboy-lab')
    expect(resolvePoolClient({ dataDir, key: `${added.key}x` })).toBeUndefined()
  })

  test('rejects duplicate names, bad names and bad pool ids', () => {
    const dataDir = tempDir()
    expect(addPoolClient({ dataDir, name: 'lab' })).not.toBeInstanceOf(Error)
    expect(addPoolClient({ dataDir, name: 'lab' })).toBeInstanceOf(Error)
    expect(addPoolClient({ dataDir, name: 'Bad Name' })).toBeInstanceOf(Error)
    expect(addPoolClient({ dataDir, name: 'ok', pools: ['NOT VALID'] })).toBeInstanceOf(Error)
  })

  test('remove revokes the key', () => {
    const dataDir = tempDir()
    const added = addPoolClient({ dataDir, name: 'lab' })
    if (added instanceof Error) throw added
    expect(removePoolClient({ dataDir, name: 'lab' })).toBe(true)
    expect(removePoolClient({ dataDir, name: 'lab' })).toBe(false)
    expect(resolvePoolClient({ dataDir, key: added.key })).toBeUndefined()
    expect(readPoolClients(dataDir)).toEqual([])
  })
})

describe('messages proxy: registered clients', () => {
  async function setup() {
    const dataDir = tempDir()
    const added = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', label: 'a', refresh: 'refresh-a', access: 'access-a', expires: Date.now() + 3_600_000 })
    if (added instanceof Error) throw added
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'claude-best', entries: ['anthropic/claude-opus-4-8'] })
    const upstreamCalls: string[] = []
    const fetchImpl = async (input: string | URL | Request) => {
      upstreamCalls.push(String(input))
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    // A session resolver that knows no sessions: only client keys can work.
    proxy = await startMessagesProxy({ dataDir, resolvePools: async () => new Error('no session'), fetchImpl })
    return { dataDir, upstreamCalls, proxy }
  }

  const post = (baseUrl: string, key: string) =>
    fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-roadie-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-best', max_tokens: 8, messages: [] }) })

  test('a registered client key routes to its pools under a stable client session', async () => {
    const { dataDir, upstreamCalls, proxy } = await setup()
    const client = addPoolClient({ dataDir, name: 'homeboy-lab' })
    if (client instanceof Error) throw client

    const response = await post(proxy.baseUrl, client.key)

    expect(response.status).toBe(200)
    await response.text()
    expect(upstreamCalls).toHaveLength(1)
    const route = readSessionRoute({ dataDir, sessionId: 'client:homeboy-lab', now: Date.now() })
    expect(route instanceof Error ? undefined : route?.poolId).toBe(SHARED_POOL_ID)
  })

  test('an unregistered or removed client key is refused before anything goes upstream', async () => {
    const { dataDir, upstreamCalls, proxy } = await setup()
    const client = addPoolClient({ dataDir, name: 'homeboy-lab' })
    if (client instanceof Error) throw client
    removePoolClient({ dataDir, name: 'homeboy-lab' })

    expect((await post(proxy.baseUrl, client.key)).status).toBe(401)
    expect((await post(proxy.baseUrl, 'rpc_not-a-real-key')).status).toBe(401)
    expect(upstreamCalls).toHaveLength(0)
  })
})

describe('pool proxy address', () => {
  test('honours a configured port', async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo
        probe.close(() => resolve(port))
      })
    })
    proxy = await startMessagesProxy({ dataDir: tempDir(), resolvePools: async () => SHARED_POOL_ID, port: free })
    expect(proxy.baseUrl).toBe(`http://127.0.0.1:${free}`)
  })

  test('reads ROADIE_POOL_PROXY_PORT / _HOST and rejects a bad port', () => {
    expect(piPoolListenOptions({})).toEqual({ host: undefined })
    expect(piPoolListenOptions({ ROADIE_POOL_PROXY_PORT: '47120' })).toEqual({ host: undefined, port: 47120 })
    expect(piPoolListenOptions({ ROADIE_POOL_PROXY_PORT: '47120', ROADIE_POOL_PROXY_HOST: '127.0.0.2' })).toEqual({ host: '127.0.0.2', port: 47120 })
    expect(piPoolListenOptions({ ROADIE_POOL_PROXY_PORT: 'abc' })).toBeInstanceOf(Error)
  })
})
