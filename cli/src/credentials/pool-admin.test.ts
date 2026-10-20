// Pool host admin API (#238): admin clients manage their own pools' accounts;
// nothing secret ever leaves the host. Exercised over real HTTP through
// startMessagesProxy with the admin handler mounted, as `credentials serve` does.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { POOL_ADMIN_PATH, PROXY_KEY_HEADER, startMessagesProxy, type MessagesProxy } from './messages-proxy.js'
import { addPoolClient } from './pool-clients.js'
import { localPoolAccounts } from './pool-accounts.js'
import { createPoolAdminHandler } from './pool-admin.js'
import { addPoolAccount, readPoolAccounts, readPoolRotations, setPoolRotation, SHARED_POOL_ID } from './store.js'

const CATALOG = { openai: { id: 'openai', npm: '@ai-sdk/openai' } }
const TEST_KEY = 'sk-test-not-a-real-key-ZZ99'

const tempDir = () => fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-admin-'))

let proxy: MessagesProxy | undefined
afterEach(async () => {
  await proxy?.close()
  proxy = undefined
})

/** A fake OAuth token endpoint: records the request, returns fixed tokens. */
function fakeTokenEndpoint() {
  const requests: Array<Record<string, unknown>> = []
  const tokenFetch = async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { requests, tokenFetch }
}

async function host({ tokenFetch }: { tokenFetch?: ReturnType<typeof fakeTokenEndpoint>['tokenFetch'] } = {}) {
  const dataDir = tempDir()
  const admin = addPoolClient({ dataDir, name: 'mac-bot-admin', admin: true })
  const plain = addPoolClient({ dataDir, name: 'homeboy-lab' })
  if (admin instanceof Error || plain instanceof Error) throw new Error('client add failed')
  const accounts = localPoolAccounts({ dataDir, catalog: CATALOG, ...(tokenFetch && { tokenFetch }) })
  proxy = await startMessagesProxy({
    dataDir,
    resolvePools: async () => new Error('no sessions'),
    admin: createPoolAdminHandler({ dataDir, accounts }),
  })
  const base = `${proxy.baseUrl}${POOL_ADMIN_PATH}`
  const call = async (key: string | undefined, method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(key && { [PROXY_KEY_HEADER]: key }), 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return { status: response.status, text, json: JSON.parse(text) as Record<string, any> }
  }
  return { dataDir, adminKey: admin.key, plainKey: plain.key, call }
}

describe('pool admin API', () => {
  test('401 without a known key, 403 for a non-admin client and for a pool outside the client', async () => {
    const { call, plainKey, adminKey } = await host()
    expect((await call(undefined, 'GET', 'accounts?pool=shared')).status).toBe(401)
    expect((await call('rpc_unknown', 'GET', 'accounts?pool=shared')).status).toBe(401)
    expect((await call(plainKey, 'GET', 'accounts?pool=shared')).status).toBe(403)
    const foreign = await call(adminKey, 'GET', 'accounts?pool=alice')
    expect(foreign.status).toBe(403)
    expect(foreign.json.error.message).toContain('alice')
  })

  test('adds an API key and lists it without any secret in the response', async () => {
    const { call, adminKey, dataDir } = await host()
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['openai/gpt-5'] })
    const added = await call(adminKey, 'POST', 'accounts/api-key', { pool: 'shared', provider: 'openai', key: TEST_KEY, label: 'team' })
    expect(added.status).toBe(201)
    expect(added.json.account).toMatchObject({ provider: 'openai', type: 'api', label: 'team', position: 1 })
    const listing = await call(adminKey, 'GET', 'accounts?pool=shared')
    expect(listing.status).toBe(200)
    expect(listing.json.accounts).toHaveLength(1)
    expect(listing.json.rotations).toEqual({ default: { entries: ['openai/gpt-5'] } })
    for (const text of [added.text, listing.text]) {
      expect(text).not.toContain(TEST_KEY)
      expect(text).not.toContain('ZZ99')
      expect(text).not.toMatch(/"(key|access|refresh)"/)
    }
    const stored = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    expect(stored).toMatchObject([{ provider: 'openai', key: TEST_KEY }])
  })

  test('an unknown provider is refused by the host catalog check', async () => {
    const { call, adminKey, dataDir } = await host()
    const refused = await call(adminKey, 'POST', 'accounts/api-key', { pool: 'shared', provider: 'not-a-provider', key: TEST_KEY })
    expect(refused.status).toBe(400)
    expect(readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([])
  })

  test('OAuth start/complete exchanges the code on the host and stores the account', async () => {
    const endpoint = fakeTokenEndpoint()
    const { call, adminKey, dataDir } = await host({ tokenFetch: endpoint.tokenFetch })
    const start = await call(adminKey, 'POST', 'oauth/start', { pool: 'shared', provider: 'anthropic', label: 'max' })
    expect(start.status).toBe(200)
    const authorizeUrl = new URL(start.json.authorizeUrl as string)
    const state = authorizeUrl.searchParams.get('state')
    expect(state).toBeTruthy()
    // The PKCE verifier never leaves the host.
    expect(start.text).not.toContain('verifier')

    const done = await call(adminKey, 'POST', 'oauth/complete', { pool: 'shared', flowId: start.json.flowId, input: `the-code#${state}` })
    expect(done.status).toBe(201)
    expect(done.json.account).toMatchObject({ provider: 'anthropic', type: 'oauth', label: 'max' })
    expect(done.text).not.toContain('access-secret')
    expect(done.text).not.toContain('refresh-secret')
    expect(endpoint.requests[0]).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', state })
    expect(readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toMatchObject([{ provider: 'anthropic', refresh: 'refresh-secret' }])

    // Single use: the same flow cannot complete twice.
    const again = await call(adminKey, 'POST', 'oauth/complete', { pool: 'shared', flowId: start.json.flowId, input: `the-code#${state}` })
    expect(again.status).toBe(400)
    expect(again.json.error.message).toContain('expired')
  })

  test('a state mismatch is rejected before the token exchange', async () => {
    const endpoint = fakeTokenEndpoint()
    const { call, adminKey, dataDir } = await host({ tokenFetch: endpoint.tokenFetch })
    const start = await call(adminKey, 'POST', 'oauth/start', { pool: 'shared', provider: 'openai-codex' })
    const done = await call(adminKey, 'POST', 'oauth/complete', { pool: 'shared', flowId: start.json.flowId, input: 'the-code#wrong-state' })
    expect(done.status).toBe(400)
    expect(done.json.error.message).toContain('state mismatch')
    expect(endpoint.requests).toHaveLength(0)
    expect(readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([])
  })

  test('an unknown flow is rejected as expired', async () => {
    const { call, adminKey } = await host()
    const done = await call(adminKey, 'POST', 'oauth/complete', { pool: 'shared', flowId: 'deadbeef', input: 'code#state' })
    expect(done.status).toBe(400)
    expect(done.json.error.message).toContain('expired')
  })

  test('sets and removes rotations; only admins, only their own pools (#275)', async () => {
    const { call, adminKey, plainKey, dataDir } = await host()
    const set = await call(adminKey, 'POST', 'rotations', { pool: 'shared', name: 'default', entries: ['openai/gpt-5', 'anthropic/claude-sonnet-4'], description: 'Hard tasks' })
    expect(set.status).toBe(200)
    expect(set.json).toEqual({ set: true })
    expect(readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toEqual({ default: ['openai/gpt-5', 'anthropic/claude-sonnet-4'] })

    // Replacing preserves metadata; clearing is explicit.
    expect((await call(adminKey, 'POST', 'rotations', { pool: 'shared', name: 'default', entries: ['openai/gpt-5'] })).status).toBe(200)
    expect((await call(adminKey, 'GET', 'accounts?pool=shared')).json.rotations).toEqual({ default: { entries: ['openai/gpt-5'], description: 'Hard tasks' } })
    expect((await call(adminKey, 'POST', 'rotations', { pool: 'shared', name: 'default', entries: ['openai/gpt-5'], description: '' })).status).toBe(200)
    expect((await call(adminKey, 'GET', 'accounts?pool=shared')).json.rotations).toEqual({ default: { entries: ['openai/gpt-5'] } })
    expect((await call(adminKey, 'POST', 'rotations', { pool: 'shared', name: 'default', entries: [] })).status).toBe(200)
    expect(readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toEqual({})

    // Same validation as the host's own CLI.
    const invalid = await call(adminKey, 'POST', 'rotations', { pool: 'shared', name: 'default', entries: ['no-slash'] })
    expect(invalid.status).toBe(400)
    expect(invalid.json.error.message).toContain('provider/model')
    const missing = await call(adminKey, 'POST', 'rotations', { pool: 'shared', entries: ['a/m'] })
    expect(missing.status).toBe(400)
    const notArray = await call(adminKey, 'POST', 'rotations', { pool: 'shared', name: 'default', entries: 'a/m' })
    expect(notArray.status).toBe(400)

    // A non-admin client and a pool outside the client's list are refused.
    expect((await call(plainKey, 'POST', 'rotations', { pool: 'shared', name: 'default', entries: ['a/m'] })).status).toBe(403)
    expect((await call(adminKey, 'POST', 'rotations', { pool: 'alice', name: 'default', entries: ['a/m'] })).status).toBe(403)
    expect(readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toEqual({})
  })

  test('reorders and removes accounts', async () => {
    const { call, adminKey, dataDir } = await host()
    const first = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'openai', key: 'sk-test-first' })
    const second = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'openai', key: 'sk-test-second' })
    if (first instanceof Error || second instanceof Error) throw new Error('seed failed')
    const moved = await call(adminKey, 'POST', 'accounts/reorder', { pool: 'shared', accountId: second.id, position: 1 })
    expect(moved.status).toBe(200)
    expect(moved.json.accounts.map((account: { id: string }) => account.id)).toEqual([second.id, first.id])
    expect(moved.text).not.toContain('sk-test')
    const removed = await call(adminKey, 'DELETE', `accounts/${first.id}?pool=shared`)
    expect(removed.json).toEqual({ removed: true })
    const missing = await call(adminKey, 'DELETE', `accounts/${first.id}?pool=shared`)
    expect(missing.json).toEqual({ removed: false })
    expect(readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toMatchObject([{ id: second.id }])
  })
})
