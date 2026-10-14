// Headless credential pool host (#226): registered clients only, fixed
// address, refuses to start with nothing that could authenticate.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { MessagesProxy } from './messages-proxy.js'
import { addPoolClient } from './pool-clients.js'
import { addPoolOAuthAccount, setPoolRotation, SHARED_POOL_ID } from './store.js'
import { readSessionRoute } from './routes.js'
import { resolvePoolServeAddress, servePool } from './serve.js'

const tempDir = () => fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-serve-'))

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })

let proxy: MessagesProxy | undefined
afterEach(async () => {
  await proxy?.close()
  proxy = undefined
})

describe('resolvePoolServeAddress', () => {
  test('requires a fixed port', () => {
    expect(resolvePoolServeAddress({ env: {} })).toBeInstanceOf(Error)
    expect(resolvePoolServeAddress({ port: 'abc', env: {} })).toBeInstanceOf(Error)
    expect(resolvePoolServeAddress({ port: '70000', env: {} })).toBeInstanceOf(Error)
  })

  test('defaults to loopback; flags win over the environment', () => {
    expect(resolvePoolServeAddress({ env: { ROADIE_POOL_PROXY_PORT: '47120' } })).toEqual({ host: '127.0.0.1', port: 47120 })
    expect(resolvePoolServeAddress({ env: { ROADIE_POOL_PROXY_PORT: '47120', ROADIE_POOL_PROXY_HOST: '100.64.0.5' } })).toEqual({ host: '100.64.0.5', port: 47120 })
    expect(resolvePoolServeAddress({ host: '127.0.0.2', port: '47121', env: { ROADIE_POOL_PROXY_PORT: '47120', ROADIE_POOL_PROXY_HOST: '100.64.0.5' } })).toEqual({ host: '127.0.0.2', port: 47121 })
  })
})

describe('servePool', () => {
  test('refuses to start without a registered client', async () => {
    const result = await servePool({ dataDir: tempDir(), port: await freePort() })
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('client add')
  })

  test('serves registered clients from their pools on the fixed address, and refuses other keys', async () => {
    const dataDir = tempDir()
    const account = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', label: 'a', refresh: 'refresh-a', access: 'access-a', expires: Date.now() + 3_600_000 })
    if (account instanceof Error) throw account
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'claude-best', entries: ['anthropic/claude-opus-4-8'] })
    const client = addPoolClient({ dataDir, name: 'mac-bot' })
    if (client instanceof Error) throw client
    const upstreamCalls: string[] = []
    const fetchImpl = async (input: string | URL | Request) => {
      upstreamCalls.push(String(input))
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const port = await freePort()
    const served = await servePool({ dataDir, port, fetchImpl })
    if (served instanceof Error) throw served
    proxy = served
    expect(proxy.baseUrl).toBe(`http://127.0.0.1:${port}`)

    const post = (key: string) =>
      fetch(`${proxy!.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-roadie-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-best', max_tokens: 8, messages: [] }) })

    expect((await post('not-a-registered-key')).status).toBe(401)
    expect(upstreamCalls).toHaveLength(0)

    const ok = await post(client.key)
    expect(ok.status).toBe(200)
    await ok.text()
    expect(upstreamCalls).toHaveLength(1)
    const route = readSessionRoute({ dataDir, sessionId: 'client:mac-bot', now: Date.now() })
    expect(route instanceof Error ? undefined : route?.poolId).toBe(SHARED_POOL_ID)
  })

  test('reports a port that is already taken', async () => {
    const dataDir = tempDir()
    addPoolClient({ dataDir, name: 'lab' })
    const port = await freePort()
    const first = await servePool({ dataDir, port })
    if (first instanceof Error) throw first
    proxy = first
    const second = await servePool({ dataDir, port })
    expect(second).toBeInstanceOf(Error)
    expect((second as Error).message).toContain(`:${port}`)
  })

  test('closes an open streaming response after the shutdown grace period', async () => {
    const dataDir = tempDir()
    const account = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', label: 'a', refresh: 'refresh-a', access: 'access-a', expires: Date.now() + 3_600_000 })
    if (account instanceof Error) throw account
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'claude-best', entries: ['anthropic/claude-opus-4-8'] })
    const client = addPoolClient({ dataDir, name: 'stream-client' })
    if (client instanceof Error) throw client
    proxy = await servePool({ dataDir, port: await freePort(), shutdownGraceMs: 50,
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message_start\\n\\n')) } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    }) as MessagesProxy
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-roadie-key': client.key, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-best', max_tokens: 8, messages: [] }) })
    expect(response.status).toBe(200)
    const started = Date.now()
    await proxy.close()
    expect(Date.now() - started).toBeLessThan(1_000)
    await response.body?.cancel().catch(() => {})
    proxy = undefined
  })
})
