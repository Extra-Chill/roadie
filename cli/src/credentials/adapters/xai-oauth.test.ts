import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { refreshXaiToken, XAI_OAUTH_CLIENT_ID, XAI_OAUTH_TOKEN_URL } from './xai-oauth.js'
import { ensureFreshOAuthAccount } from '../pool-routing.js'
import { addPoolOAuthAccount, readPoolAccounts, readPoolState, SHARED_POOL_ID } from '../store.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const tokens = () => Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 })

test('refresh uses the xAI public client and returns rotated tokens and expiry', async () => {
  const result = await refreshXaiToken({ refreshToken: 'old-refresh', now: 1000, fetchImpl: async (url, init) => {
    expect(url).toBe(XAI_OAUTH_TOKEN_URL)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: XAI_OAUTH_CLIENT_ID })
    return tokens()
  } })
  expect(result).toEqual({ access: 'new-access', refresh: 'rotated-refresh', expires: 3601000 })
})

test('refresh keeps the current refresh token when xAI does not rotate it', async () => {
  const result = await refreshXaiToken({ refreshToken: 'old-refresh', now: 1000, fetchImpl: async () => Response.json({ access_token: 'new-access', expires_in: 3600 }) })
  expect(result).toEqual({ access: 'new-access', refresh: 'old-refresh', expires: 3601000 })
})

test.each([400, 401, 500])('refresh preserves HTTP %s for permanent-failure classification', async (status) => {
  const result = await refreshXaiToken({ refreshToken: 'bad', fetchImpl: async () => new Response('invalid_grant', { status }) })
  expect(result).toBeInstanceOf(Error)
  expect(result).toHaveProperty('status', status)
})

test('malformed and network responses return errors', async () => {
  expect(await refreshXaiToken({ refreshToken: 'r', fetchImpl: async () => Response.json({ access_token: 'a' }) })).toBeInstanceOf(Error)
  expect(await refreshXaiToken({ refreshToken: 'r', fetchImpl: async () => { throw new Error('offline') } })).toBeInstanceOf(Error)
})

async function accountFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-refresh-'))
  dirs.push(dataDir)
  const account = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'xai', refresh: 'old-refresh', access: 'old-access', expires: 1 })
  if (account instanceof Error) throw account
  return { dataDir, poolId: SHARED_POOL_ID, account, now: Date.now() }
}

test('concurrent refreshes write the rotated refresh token back under the pool lock once', async () => {
  const fixture = await accountFixture()
  let calls = 0
  const fetchImpl = async () => { calls++; return tokens() }
  const results = await Promise.all([ensureFreshOAuthAccount({ ...fixture, fetchImpl }), ensureFreshOAuthAccount({ ...fixture, fetchImpl })])
  expect(calls).toBe(1)
  for (const result of results) expect(result).toMatchObject({ access: 'new-access', refresh: 'rotated-refresh' })
  expect(readPoolAccounts(fixture)).toMatchObject([{ access: 'new-access', refresh: 'rotated-refresh' }])
})

test.each([400, 401, 500])('HTTP %s refresh failure only cools down permanent failures', async (status) => {
  const fixture = await accountFixture()
  expect(await ensureFreshOAuthAccount({ ...fixture, fetchImpl: async () => new Response('invalid_grant', { status }) })).toBeInstanceOf(Error)
  const state = readPoolState(fixture)
  if (state instanceof Error) throw state
  expect(state.cooldowns[fixture.account.id]).toBe(status === 500 ? undefined : fixture.now + 3600000)
  expect(readPoolAccounts(fixture)).toMatchObject([{ access: 'old-access', refresh: 'old-refresh' }])
})
