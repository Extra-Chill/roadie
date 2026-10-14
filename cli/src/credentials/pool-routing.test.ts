// Pool routing helpers shared by Pi's pool proxy (messages-proxy.ts).
import { test, expect, describe, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { addPoolOAuthAccount, readPoolAccounts, readPoolState, setPoolRotation, SHARED_POOL_ID } from './store.js'
import {
  cooldownUntilFromRetryAfter,
  ensureFreshOAuthAccount,
  heldCandidate,
  resolvePoolListCandidates,
  type PoolFetch,
} from './pool-routing.js'
import { setSessionRoute } from './routes.js'
import { CLAUDE_CODE_USER_AGENT } from './adapters/anthropic-oauth.js'

let dataDir: string
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-pool-routing-'))
})

const NOW = 1_000_000
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function seedOAuthPool(accounts: Array<{ access: string; refresh: string; expiresInMs: number }>) {
  const added = []
  for (const account of accounts) {
    const result = await addPoolOAuthAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      refresh: account.refresh,
      access: account.access,
      expires: NOW + account.expiresInMs,
    })
    if (result instanceof Error) throw result
    added.push(result)
  }
  expect(await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })).toBe(true)
  return added
}

test('cooldownUntilFromRetryAfter: retry-after seconds, default 60s, capped', () => {
  expect(cooldownUntilFromRetryAfter({ retryAfter: '30', now: NOW })).toBe(NOW + 30_000)
  expect(cooldownUntilFromRetryAfter({ retryAfter: '0', now: NOW })).toBe(NOW + 60_000)
  expect(cooldownUntilFromRetryAfter({ retryAfter: null, now: NOW })).toBe(NOW + 60_000)
  expect(cooldownUntilFromRetryAfter({ retryAfter: 'not-a-number', now: NOW })).toBe(NOW + 60_000)
  expect(cooldownUntilFromRetryAfter({ retryAfter: '999999', now: NOW })).toBe(NOW + 24 * 60 * 60 * 1000)
})

describe('resolvePoolListCandidates', () => {
  test('skips unusable pools with a reason and resolves the usable one', async () => {
    const [account] = await seedOAuthPool([{ access: 'at', refresh: 'rt', expiresInMs: 3_600_000 }])
    const resolved = resolvePoolListCandidates({ poolIds: ['empty', SHARED_POOL_ID], dataDir, rotationName: 'default', now: NOW })
    expect(resolved[0]).toMatchObject({ poolId: 'empty', candidates: [], skipped: 'pool empty has no accounts' })
    expect(resolved[1]?.candidates.map((candidate) => candidate.account.id)).toEqual([account!.id])
    const missing = resolvePoolListCandidates({ poolIds: [SHARED_POOL_ID], dataDir, rotationName: 'nope', now: NOW })
    expect(missing[0]).toMatchObject({ skipped: `pool ${SHARED_POOL_ID} has no rotation named nope` })
  })
})

describe('heldCandidate', () => {
  test('holds the pinned candidate for the same rotation only', async () => {
    const [first, second] = await seedOAuthPool([
      { access: 'at-1', refresh: 'rt-1', expiresInMs: 3_600_000 },
      { access: 'at-2', refresh: 'rt-2', expiresInMs: 3_600_000 },
    ])
    const [resolution] = resolvePoolListCandidates({ poolIds: [SHARED_POOL_ID], dataDir, rotationName: 'default', now: NOW })
    const candidates = resolution!.candidates
    const pinned = candidates.find((candidate) => candidate.account.id === second!.id)!
    expect(
      await setSessionRoute({
        dataDir,
        sessionId: 'ses_1',
        route: { rotation: 'default', poolId: SHARED_POOL_ID, accountId: second!.id, provider: pinned.provider, modelId: pinned.modelId, pinnedAt: NOW },
        now: NOW,
      }),
    ).toBe(true)
    expect(heldCandidate({ sessionId: 'ses_1', rotationName: 'default', candidates, dataDir, now: NOW })?.account.id).toBe(second!.id)
    expect(heldCandidate({ sessionId: 'ses_1', rotationName: 'other', candidates, dataDir, now: NOW })).toBeNull()
    expect(heldCandidate({ sessionId: null, rotationName: 'default', candidates, dataDir, now: NOW })).toBeNull()
    expect(first).toBeDefined()
  })
})

describe('ensureFreshOAuthAccount', () => {
  test('concurrent callers refresh an expiring account once and share the rotated tokens', async () => {
    const [account] = await seedOAuthPool([{ access: 'at-old', refresh: 'rt-old', expiresInMs: 10_000 }])
    let refreshCount = 0
    const fetchImpl = vi.fn<PoolFetch>(async (input) => {
      expect(String(input instanceof Request ? input.url : input)).toBe(TOKEN_URL)
      refreshCount += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 })
    })
    const refresh = () => ensureFreshOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, account: account!, now: NOW, fetchImpl })
    const [a, b] = await Promise.all([refresh(), refresh()])
    expect(refreshCount).toBe(1)
    expect(a).toMatchObject({ access: 'at-new', refresh: 'rt-new' })
    expect(b).toMatchObject({ access: 'at-new', refresh: 'rt-new' })
    const stored = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (stored instanceof Error) throw stored
    expect(stored[0]).toMatchObject({ access: 'at-new', refresh: 'rt-new' })
  })

  test('an account expiring beyond the 60s lead is returned without a refresh', async () => {
    const [account] = await seedOAuthPool([{ access: 'at-fresh', refresh: 'rt-fresh', expiresInMs: 61_000 }])
    const fetchImpl = vi.fn<PoolFetch>()
    expect(await ensureFreshOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, account: account!, now: NOW, fetchImpl })).toBe(account)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a permanent refresh failure (400) cools the account down for an hour', async () => {
    const [account] = await seedOAuthPool([{ access: 'at-dead', refresh: 'rt-dead', expiresInMs: 10_000 }])
    const fetchImpl = vi.fn<PoolFetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('user-agent')).toBe(CLAUDE_CODE_USER_AGENT)
      return jsonResponse(400, { error: 'invalid_grant' })
    })
    const result = await ensureFreshOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, account: account!, now: NOW, fetchImpl })
    expect(result).toBeInstanceOf(Error)
    const state = readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    if (state instanceof Error) throw state
    expect(state.cooldowns[account!.id]).toBe(NOW + 60 * 60 * 1000)
  })

  test('a transient refresh failure (500) fails without a cooldown', async () => {
    const [account] = await seedOAuthPool([{ access: 'at', refresh: 'rt', expiresInMs: 10_000 }])
    const fetchImpl = vi.fn<PoolFetch>(async () => jsonResponse(500, { error: 'server_error' }))
    const result = await ensureFreshOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, account: account!, now: NOW, fetchImpl })
    expect(result).toBeInstanceOf(Error)
    const state = readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    if (state instanceof Error) throw state
    expect(state.cooldowns).toEqual({})
  })
})
