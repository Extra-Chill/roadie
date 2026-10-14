// PoolAccounts seam (#238): which implementation an environment resolves to,
// and the remote client round-tripping against a real pool host.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { startMessagesProxy, type MessagesProxy } from './messages-proxy.js'
import { addPoolClient } from './pool-clients.js'
import { localPoolAccounts, resolvePoolAccounts, toPoolAccountView } from './pool-accounts.js'
import { createPoolAdminHandler } from './pool-admin.js'
import { readPoolAccounts, SHARED_POOL_ID } from './store.js'

const CATALOG = { openai: { id: 'openai', npm: '@ai-sdk/openai' } }
const TEST_KEY = 'sk-test-not-a-real-key-YY88'

const tempDir = () => fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-accounts-'))

let proxy: MessagesProxy | undefined
afterEach(async () => {
  await proxy?.close()
  proxy = undefined
})

describe('resolvePoolAccounts', () => {
  test('no ROADIE_POOL_URL resolves to the local pool', () => {
    const accounts = resolvePoolAccounts({ env: {}, dataDir: tempDir() })
    expect(accounts).not.toBeInstanceOf(Error)
    expect((accounts as { location: string }).location).toBe('local')
  })

  test('a remote pool without an admin key is an Error naming the host and the fix', () => {
    const accounts = resolvePoolAccounts({ env: { ROADIE_POOL_URL: 'http://100.64.0.9:47120' }, dataDir: tempDir() })
    expect(accounts).toBeInstanceOf(Error)
    expect((accounts as Error).message).toContain('http://100.64.0.9:47120')
    expect((accounts as Error).message).toContain('client add <name> --admin')
    expect((accounts as Error).message).toContain('ROADIE_POOL_ADMIN_KEY_FILE')
  })

  test('a remote pool with an admin key file resolves to the pool host', () => {
    const keyFile = path.join(tempDir(), 'admin.key')
    fs.writeFileSync(keyFile, 'rpc_admin\n')
    const accounts = resolvePoolAccounts({
      env: { ROADIE_POOL_URL: 'http://100.64.0.9:47120/', ROADIE_POOL_ADMIN_KEY_FILE: keyFile },
      dataDir: tempDir(),
    })
    expect(accounts).not.toBeInstanceOf(Error)
    expect((accounts as { location: string }).location).toBe('http://100.64.0.9:47120')
  })

  test('an unreadable admin key file is an Error', () => {
    const accounts = resolvePoolAccounts({
      env: { ROADIE_POOL_URL: 'http://100.64.0.9:47120', ROADIE_POOL_ADMIN_KEY_FILE: '/nonexistent/admin.key' },
      dataDir: tempDir(),
    })
    expect(accounts).toBeInstanceOf(Error)
    expect((accounts as Error).message).toContain('ROADIE_POOL_ADMIN_KEY_FILE')
  })
})

describe('toPoolAccountView', () => {
  test('is an allowlist: keys and tokens never appear', () => {
    const api = toPoolAccountView({
      account: { id: 'a', provider: 'openai', type: 'api', key: TEST_KEY, baseURL: 'https://x.test/v1', addedAt: 't', lastUsed: null },
      position: 1,
    })
    const oauth = toPoolAccountView({
      account: { id: 'b', provider: 'anthropic', type: 'oauth', refresh: 'refresh-secret', access: 'access-secret', expires: 0, addedAt: 't', lastUsed: null },
      position: 2,
    })
    const text = JSON.stringify([api, oauth])
    expect(text).not.toContain(TEST_KEY)
    expect(text).not.toContain('secret')
    expect(api.baseURL).toBe('https://x.test/v1')
    expect(oauth.expiresAt).toBe(new Date(0).toISOString())
  })
})

describe('remote PoolAccounts against a real pool host', () => {
  test('round-trips list, add and remove; the host holds the key', async () => {
    const hostDir = tempDir()
    const admin = addPoolClient({ dataDir: hostDir, name: 'bot-admin', admin: true })
    if (admin instanceof Error) throw admin
    proxy = await startMessagesProxy({
      dataDir: hostDir,
      resolvePools: async () => new Error('no sessions'),
      admin: createPoolAdminHandler({ dataDir: hostDir, accounts: localPoolAccounts({ dataDir: hostDir, catalog: CATALOG }) }),
    })
    const keyFile = path.join(tempDir(), 'admin.key')
    fs.writeFileSync(keyFile, admin.key)
    const botDir = tempDir()
    const accounts = resolvePoolAccounts({ env: { ROADIE_POOL_URL: proxy.baseUrl, ROADIE_POOL_ADMIN_KEY_FILE: keyFile }, dataDir: botDir })
    if (accounts instanceof Error) throw accounts

    const added = await accounts.addApiKey({ poolId: SHARED_POOL_ID, provider: 'openai', key: TEST_KEY })
    if (added instanceof Error) throw added
    expect(added.account).toMatchObject({ provider: 'openai', type: 'api', position: 1 })

    const listing = await accounts.list({ poolId: SHARED_POOL_ID })
    if (listing instanceof Error) throw listing
    expect(listing.accounts.map((account) => account.id)).toEqual([added.account.id])
    expect(JSON.stringify(listing)).not.toContain(TEST_KEY)

    // The host holds the key; the bot's data dir has no pool.
    expect(readPoolAccounts({ dataDir: hostDir, poolId: SHARED_POOL_ID })).toMatchObject([{ key: TEST_KEY }])
    expect(readPoolAccounts({ dataDir: botDir, poolId: SHARED_POOL_ID })).toEqual([])

    // Host errors surface as Errors with the host's message.
    const foreign = await accounts.list({ poolId: 'alice' })
    expect(foreign).toBeInstanceOf(Error)
    expect((foreign as Error).message).toContain('cannot manage pool alice')

    expect(await accounts.remove({ poolId: SHARED_POOL_ID, accountId: added.account.id })).toBe(true)
    expect(readPoolAccounts({ dataDir: hostDir, poolId: SHARED_POOL_ID })).toEqual([])
  })
})
