import { test, expect, describe, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  addPoolAccount,
  addPoolOAuthAccount,
  markCooldown as markCooldownInStore,
  readPoolAccounts,
  readPoolState,
  setPoolRotation,
  SHARED_POOL_ID,
  type PoolState,
} from './store.js'
import {
  cooldownUntilFromRetryAfter,
  makePoolFetch,
  wireForProvider,
  wireFromRequestUrl,
  type PoolFetch,
} from './provider.js'
import {
  CLAUDE_CODE_BETA,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_CODE_USER_AGENT,
  FINE_GRAINED_TOOL_STREAMING_BETA,
  INTERLEAVED_THINKING_BETA,
  OAUTH_BETA,
} from './adapters/anthropic-oauth.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-provider-'))
})

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const NOW = 1_000_000

/** Typed fetch mock: calls expose `[input, init]` without casts. */
function stubFetch(handler: PoolFetch): ReturnType<typeof vi.fn<PoolFetch>> {
  return vi.fn(handler)
}

function lastInit(fetchMock: ReturnType<typeof vi.fn<PoolFetch>>, callIndex: number): RequestInit {
  return fetchMock.mock.calls[callIndex]?.[1] ?? {}
}

function readStateOrThrow(): PoolState {
  const state = readPoolState({ dataDir, poolId: SHARED_POOL_ID })
  if (state instanceof Error) throw state
  return state
}

function jsonResponse(status: number, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

async function seedPool({
  keys = ['anthropic-key-1'],
  rotation = ['anthropic/claude-sonnet-4'],
  rotationName = 'default',
  poolId = SHARED_POOL_ID,
}: {
  keys?: string[]
  rotation?: string[]
  rotationName?: string
  poolId?: string
} = {}) {
  for (const key of keys) {
    const added = await addPoolAccount({ dataDir, poolId, provider: 'anthropic', key })
    expect(added).not.toBeInstanceOf(Error)
  }
  const set = await setPoolRotation({ dataDir, poolId, name: rotationName, entries: rotation })
  expect(set).toBe(true)
}

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

function isTokenUrl(input: string | URL | Request): boolean {
  return (input instanceof Request ? input.url : input.toString()).startsWith(TOKEN_URL)
}

/**
 * Seed one OAuth account and a rotation. `expiresInMs` is how long the stored
 * access token stays valid from NOW.
 */
async function seedOAuthPool({
  accounts,
  rotation = ['anthropic/claude-sonnet-4'],
  poolId = SHARED_POOL_ID,
}: {
  accounts: Array<{ access: string; refresh: string; expiresInMs: number; label?: string }>
  rotation?: string[]
  poolId?: string
} = { accounts: [] }) {
  const added = []
  for (const account of accounts) {
    const result = await addPoolOAuthAccount({
      dataDir,
      poolId,
      provider: 'anthropic',
      refresh: account.refresh,
      access: account.access,
      expires: NOW + account.expiresInMs,
      ...(account.label && { label: account.label }),
    })
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) throw result
    added.push(result)
  }
  const set = await setPoolRotation({ dataDir, poolId, name: 'default', entries: rotation })
  expect(set).toBe(true)
  return added
}

describe('pure helpers', () => {
  test('wireForProvider: anthropic vs everything else', () => {
    expect(wireForProvider('anthropic')).toBe('anthropic')
    expect(wireForProvider('openai')).toBe('openai-compatible')
    expect(wireForProvider('openrouter')).toBe('openai-compatible')
  })

  test('wireFromRequestUrl: /messages vs /chat/completions', () => {
    expect(wireFromRequestUrl(ANTHROPIC_URL)).toBe('anthropic')
    expect(wireFromRequestUrl(OPENAI_URL)).toBe('openai-compatible')
    expect(wireFromRequestUrl(new URL(ANTHROPIC_URL))).toBe('anthropic')
  })

  test('cooldownUntilFromRetryAfter: retry-after seconds, default 60s, capped', () => {
    expect(cooldownUntilFromRetryAfter({ retryAfter: '30', now: NOW })).toBe(NOW + 30_000)
    expect(cooldownUntilFromRetryAfter({ retryAfter: '0', now: NOW })).toBe(NOW + 60_000)
    expect(cooldownUntilFromRetryAfter({ retryAfter: null, now: NOW })).toBe(NOW + 60_000)
    expect(cooldownUntilFromRetryAfter({ retryAfter: 'not-a-number', now: NOW })).toBe(NOW + 60_000)
    expect(cooldownUntilFromRetryAfter({ retryAfter: '999999', now: NOW })).toBe(NOW + 24 * 60 * 60 * 1000)
  })
})

describe('makePoolFetch', () => {
  test('missing pool tag fails closed with 401 and never reaches upstream', async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(200))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' },
      body: JSON.stringify({ model: 'default', messages: [] }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { message: 'no credential pool on request' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('pool without accounts fails closed with 401', async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(200))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: {
        message:
          'no usable accounts in pool shared; add one with roadie credentials add-key --pool shared or roadie credentials login anthropic --pool shared',
      },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('pool without the requested rotation fails closed with 401', async () => {
    await seedPool({ rotationName: 'other' })
    const fetchImpl = stubFetch(async () => jsonResponse(200))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { message: 'pool shared has no rotation named default' },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('strips x-roadie-* and placeholder auth, sets the account auth per wire, and rewrites the body model', async () => {
    await seedPool({ keys: ['sk-ant-abcd1234'] })
    const fetchImpl = stubFetch(async () => jsonResponse(200, { ok: true }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })

    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        'x-roadie-pool': 'shared',
        'x-roadie-session': 'ses_123',
        'x-api-key': 'roadie-pool-managed',
        'authorization': 'Bearer stale',
        'content-length': '999',
      }),
      body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const init = lastInit(fetchImpl, 0)
    const headers = new Headers(init.headers)
    for (const name of [...headers.keys()]) {
      expect(name.toLowerCase().startsWith('x-roadie-')).toBe(false)
    }
    expect(headers.get('x-api-key')).toBe('sk-ant-abcd1234')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    const body = JSON.parse(String(init.body)) as { model: string }
    expect(body.model).toBe('claude-sonnet-4')
  })

  test('openai-compatible wire uses authorization: Bearer', async () => {
    const openaiAccount = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'openai', key: 'sk-oai-xyz' })
    expect(openaiAccount).not.toBeInstanceOf(Error)
    const set = await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['openai/gpt-5.1'] })
    expect(set).toBe(true)
    const fetchImpl = stubFetch(async () => jsonResponse(200, { ok: true }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    const init = lastInit(fetchImpl, 0)
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-oai-xyz')
    expect(headers.get('x-api-key')).toBeNull()
  })

  test('429 marks cooldown with retry-after and fails over to the next account', async () => {
    const first = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-first' })
    const second = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-second' })
    expect(first).not.toBeInstanceOf(Error)
    expect(second).not.toBeInstanceOf(Error)
    if (first instanceof Error || second instanceof Error) return
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })

    const fetchImpl = stubFetch(async () => jsonResponse(429))
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(429, {}, { 'retry-after': '30' }))
      .mockImplementationOnce(async () => jsonResponse(200, { ok: 'second account' }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })

    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: 'second account' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const firstCallHeaders = new Headers(lastInit(fetchImpl, 0).headers)
    const secondCallHeaders = new Headers(lastInit(fetchImpl, 1).headers)
    expect(firstCallHeaders.get('x-api-key')).toBe('sk-ant-first')
    expect(secondCallHeaders.get('x-api-key')).toBe('sk-ant-second')

    const state = readStateOrThrow()
    expect(state.cooldowns[first.id]).toBe(NOW + 30_000)
    // Only the successful account is marked used.
    expect(state.lastUsed).toEqual({ [second.id]: NOW })
  })

  test('429 without retry-after cools the account down for 60s', async () => {
    const only = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-only' })
    expect(only).not.toBeInstanceOf(Error)
    if (only instanceof Error) return
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })

    const fetchImpl = stubFetch(async () => jsonResponse(429))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(429)
    const state = readStateOrThrow()
    expect(state.cooldowns[only.id]).toBe(NOW + 60_000)
  })

  test('candidates on another wire are skipped without being cooled down', async () => {
    const anthropicAccount = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-x' })
    const openaiAccount = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'openai', key: 'sk-oai-x' })
    expect(anthropicAccount).not.toBeInstanceOf(Error)
    expect(openaiAccount).not.toBeInstanceOf(Error)
    if (anthropicAccount instanceof Error || openaiAccount instanceof Error) return
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['openai/gpt-5.1', 'anthropic/claude-sonnet-4'],
    })

    // An anthropic-wire request: rotation puts openai first, but only the
    // anthropic candidate can serve it, and it succeeds without a cooldown.
    const fetchImpl = stubFetch(async () => jsonResponse(200, { ok: true }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const state = readStateOrThrow()
    expect(state.cooldowns).toEqual({})
    expect(state.lastUsed).toEqual({ [anthropicAccount.id]: NOW })
  })

  test('all accounts cooling down fails closed with 401 without touching upstream', async () => {
    const only = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-cold' })
    expect(only).not.toBeInstanceOf(Error)
    if (only instanceof Error) return
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })
    await markCooldownInStore({ dataDir, poolId: SHARED_POOL_ID, accountId: only.id, untilMs: NOW + 60_000 })

    const fetchImpl = stubFetch(async () => jsonResponse(200))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: {
        message:
          'no usable accounts in pool shared; add one with roadie credentials add-key --pool shared or roadie credentials login anthropic --pool shared',
      },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('makePoolFetch pool lists', () => {
  test('tries the listed pools in order: the first pool with usable accounts answers', async () => {
    await seedPool({ keys: ['sk-ant-alice'], poolId: 'alice' })
    await seedPool({ keys: ['sk-ant-shared'] })
    const fetchImpl = stubFetch(async () => jsonResponse(200, { ok: true }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'alice,shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new Headers(lastInit(fetchImpl, 0).headers).get('x-api-key')).toBe('sk-ant-alice')
    // Per-pool state: only the answering pool's account is marked used.
    const aliceState = readPoolState({ dataDir, poolId: 'alice' })
    expect(aliceState).not.toBeInstanceOf(Error)
    if (aliceState instanceof Error) return
    expect(Object.keys(aliceState.lastUsed)).toHaveLength(1)
    const sharedState = readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    expect(sharedState).not.toBeInstanceOf(Error)
    if (sharedState instanceof Error) return
    expect(sharedState.lastUsed).toEqual({})
  })

  test('an empty billed pool falls through to the shared fallback pool', async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(200, { ok: 'from shared' }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    await seedPool({ keys: ['sk-ant-shared'] })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'alice,shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: 'from shared' })
    expect(new Headers(lastInit(fetchImpl, 0).headers).get('x-api-key')).toBe('sk-ant-shared')
  })

  test('a fully-cooled billed pool falls through to the shared fallback pool', async () => {
    const cooled = await addPoolAccount({ dataDir, poolId: 'alice', provider: 'anthropic', key: 'sk-ant-cold' })
    expect(cooled).not.toBeInstanceOf(Error)
    if (cooled instanceof Error) return
    await setPoolRotation({ dataDir, poolId: 'alice', name: 'default', entries: ['anthropic/claude-sonnet-4'] })
    await markCooldownInStore({ dataDir, poolId: 'alice', accountId: cooled.id, untilMs: NOW + 60_000 })
    await seedPool({ keys: ['sk-ant-shared'] })

    const fetchImpl = stubFetch(async () => jsonResponse(200, { ok: 'from shared' }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'alice,shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: 'from shared' })
    // The cooled pool's cooldown is untouched by the fallback dispatch.
    const state = readPoolState({ dataDir, poolId: 'alice' })
    expect(state).not.toBeInstanceOf(Error)
    if (state instanceof Error) return
    expect(state.cooldowns[cooled.id]).toBe(NOW + 60_000)
    expect(state.lastUsed).toEqual({})
  })

  test('cooldowns are per pool: a 429 in the first pool does not touch the fallback pool', async () => {
    const aliceKey = await addPoolAccount({ dataDir, poolId: 'alice', provider: 'anthropic', key: 'sk-ant-alice' })
    expect(aliceKey).not.toBeInstanceOf(Error)
    if (aliceKey instanceof Error) return
    await setPoolRotation({ dataDir, poolId: 'alice', name: 'default', entries: ['anthropic/claude-sonnet-4'] })
    await seedPool({ keys: ['sk-ant-shared'] })

    const fetchImpl = stubFetch(async () => jsonResponse(429))
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(429, {}, { 'retry-after': '30' }))
      .mockImplementationOnce(async () => jsonResponse(200, { ok: 'from shared' }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'alice,shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: 'from shared' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const aliceState = readPoolState({ dataDir, poolId: 'alice' })
    expect(aliceState).not.toBeInstanceOf(Error)
    if (aliceState instanceof Error) return
    // The rate-limited account cools down in its own pool only.
    expect(aliceState.cooldowns[aliceKey.id]).toBe(NOW + 30_000)
    const sharedState = readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    expect(sharedState).not.toBeInstanceOf(Error)
    if (sharedState instanceof Error) return
    expect(sharedState.cooldowns).toEqual({})
    expect(Object.keys(sharedState.lastUsed)).toHaveLength(1)
  })

  test('every listed pool unusable fails closed with the actionable 401 message', async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(200))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'alice,shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: {
        message:
          'no usable accounts in pool alice,shared; add one with roadie credentials add-key --pool alice or roadie credentials login anthropic --pool alice',
      },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a single pool id in the list behaves exactly as before', async () => {
    await seedPool({ keys: ['sk-ant-single'] })
    const fetchImpl = stubFetch(async () => jsonResponse(200, { ok: true }))
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new Headers(lastInit(fetchImpl, 0).headers).get('x-api-key')).toBe('sk-ant-single')
  })
})

describe('oauth accounts', () => {
  const upstream = (auths: string[]) =>
    stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        throw new Error('token endpoint must not be called in this test')
      }
      const headers = new Headers(init?.headers)
      auths.push(headers.get('authorization') ?? '')
      return jsonResponse(200, { ok: true })
    })

  test('concurrent requests refresh an expiring oauth account once and share the rotated tokens', async () => {
    await seedOAuthPool({ accounts: [{ access: 'at-old', refresh: 'rt-old', expiresInMs: 10_000 }] })
    let refreshCount = 0
    const auths: string[] = []
    const bodies: string[] = []
    const fetchImpl = stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        refreshCount += 1
        // Give the second request time to queue on the pool lock.
        await new Promise((resolve) => setTimeout(resolve, 10))
        return jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 })
      }
      const headers = new Headers(init?.headers)
      auths.push(headers.get('authorization') ?? '')
      bodies.push(String(init?.body))
      return jsonResponse(200, { ok: true })
    })
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const request = () =>
      poolFetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-roadie-pool': 'shared' },
        body: JSON.stringify({ model: 'default' }),
      })
    const [first, second] = await Promise.all([request(), request()])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(refreshCount).toBe(1)
    // Both requests dispatched with the rotated access token, and the rotated
    // refresh token was written back to accounts.json.
    expect(auths).toEqual(['Bearer at-new', 'Bearer at-new'])
    const accounts = await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) throw accounts
    expect(accounts).toHaveLength(1)
    const account = accounts[0]
    expect(account).toMatchObject({ type: 'oauth', refresh: 'rt-new', access: 'at-new' })
    if (!account || account.type !== 'oauth') return
    // expires_in 3600 minus the 5 minute early-expiry margin.
    expect(account.expires).toBeGreaterThan(Date.now())
    expect(bodies).toHaveLength(2)
  })

  test('an oauth account expiring beyond the 60s lead is dispatched without a refresh', async () => {
    await seedOAuthPool({ accounts: [{ access: 'at-fresh', refresh: 'rt-fresh', expiresInMs: 61_000 }] })
    const auths: string[] = []
    const fetchImpl = upstream(auths)
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(auths).toEqual(['Bearer at-fresh'])
    const accounts = await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) throw accounts
    const account = accounts[0]
    expect(account).toMatchObject({ type: 'oauth', refresh: 'rt-fresh', access: 'at-fresh' })
  })

  test('a permanent refresh failure (400) cools the account down for an hour and moves to the next candidate', async () => {
    const [dead, alive] = await seedOAuthPool({
      accounts: [
        { access: 'at-dead', refresh: 'rt-dead', expiresInMs: 10_000 },
        { access: 'at-alive', refresh: 'rt-alive', expiresInMs: 10 * 3_600_000 },
      ],
    })
    if (!dead || !alive) throw new Error('seed failed')
    const auths: string[] = []
    const fetchImpl = stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        return jsonResponse(400, { error: 'invalid_grant' })
      }
      const headers = new Headers(init?.headers)
      auths.push(headers.get('authorization') ?? '')
      return jsonResponse(200, { ok: true })
    })
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    // The refresh failure never surfaces: the next candidate serves the request.
    expect(response.status).toBe(200)
    expect(auths).toEqual(['Bearer at-alive'])
    const state = readStateOrThrow()
    expect(state.cooldowns[dead.id]).toBe(NOW + 60 * 60 * 1000)
    expect(state.cooldowns[alive.id]).toBeUndefined()
    expect(state.lastUsed).toEqual({ [alive.id]: NOW })
  })

  test('a transient refresh failure (500) skips the candidate without a cooldown', async () => {
    const [flaky, healthy] = await seedOAuthPool({
      accounts: [
        { access: 'at-flaky', refresh: 'rt-flaky', expiresInMs: 10_000 },
        { access: 'at-healthy', refresh: 'rt-healthy', expiresInMs: 10 * 3_600_000 },
      ],
    })
    if (!flaky || !healthy) throw new Error('seed failed')
    const auths: string[] = []
    const fetchImpl = stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        return jsonResponse(500, { error: 'server_error' })
      }
      const headers = new Headers(init?.headers)
      auths.push(headers.get('authorization') ?? '')
      return jsonResponse(200, { ok: true })
    })
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(auths).toEqual(['Bearer at-healthy'])
    const state = readStateOrThrow()
    expect(state.cooldowns).toEqual({})
    expect(state.lastUsed).toEqual({ [healthy.id]: NOW })
  })

  test('oauth candidates send the Claude Code headers, merged betas and payload shaping, and the response reverses tool names', async () => {
    await seedOAuthPool({ accounts: [{ access: 'at-live', refresh: 'rt-live', expiresInMs: 10 * 3_600_000 }] })
    let capturedInit: RequestInit | undefined
    const fetchImpl = stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        throw new Error('token endpoint must not be called in this test')
      }
      capturedInit = init
      return new Response(
        JSON.stringify({ content: [{ type: 'tool_use', name: 'Bash', input: {} }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        'x-roadie-pool': 'shared',
        'x-api-key': 'roadie-pool-managed',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      }),
      body: JSON.stringify({
        model: 'default',
        system: 'You are OpenCode.',
        tools: [{ name: 'bash', description: 'run a command' }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ content: [{ type: 'tool_use', name: 'bash', input: {} }] })

    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('authorization')).toBe('Bearer at-live')
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('user-agent')).toBe(CLAUDE_CODE_USER_AGENT)
    expect(headers.get('x-app')).toBe('cli')
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(headers.get('anthropic-beta')).toBe(
      [CLAUDE_CODE_BETA, OAUTH_BETA, FINE_GRAINED_TOOL_STREAMING_BETA, INTERLEAVED_THINKING_BETA].join(','),
    )
    expect(headers.get('content-length')).toBeNull()

    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string
      system: Array<{ type: string; text: string }>
      tools: Array<{ name: string }>
    }
    expect(body.model).toBe('claude-sonnet-4')
    expect(body.system).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'You are OpenCode.' },
    ])
    expect(body.tools[0]?.name).toBe('Bash')

    const state = readStateOrThrow()
    expect(state.cooldowns).toEqual({})
  })

  test('failing over from an oauth candidate to an api candidate replaces Bearer auth with x-api-key', async () => {
    const oauth = await addPoolOAuthAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      refresh: 'rt-mixed',
      access: 'at-mixed',
      expires: NOW + 10 * 3_600_000,
    })
    expect(oauth).not.toBeInstanceOf(Error)
    const api = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-fallback' })
    expect(api).not.toBeInstanceOf(Error)
    const set = await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })
    expect(set).toBe(true)

    const authHeaders: string[][] = []
    const fetchImpl = stubFetch(async (_input, init) => {
      const headers = new Headers(init?.headers)
      authHeaders.push([headers.get('authorization') ?? '', headers.get('x-api-key') ?? ''])
      if (authHeaders.length === 1) return jsonResponse(429)
      return jsonResponse(200, { ok: 'api account' })
    })
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-roadie-pool': 'shared' },
      body: JSON.stringify({ model: 'default' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: 'api account' })
    expect(authHeaders).toEqual([
      ['Bearer at-mixed', ''],
      ['', 'sk-ant-fallback'],
    ])
  })
})

describe('api-key regression', () => {
  test('api-key requests carry no oauth headers and the body is unchanged apart from the model', async () => {
    await seedPool({ keys: ['sk-ant-regression'] })
    let capturedInit: RequestInit | undefined
    const fetchImpl = stubFetch(async (_input, init) => {
      capturedInit = init
      return jsonResponse(200, { ok: true })
    })
    const poolFetch = makePoolFetch({ dataDir, rotationName: 'default', now: () => NOW, fetchImpl })
    const requestBody = {
      model: 'default',
      system: 'You are OpenCode.',
      tools: [{ name: 'bash', description: 'run a command' }],
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
    }
    const response = await poolFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-roadie-pool': 'shared',
        'anthropic-beta': 'some-existing-beta',
      },
      body: JSON.stringify(requestBody),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('x-api-key')).toBe('sk-ant-regression')
    for (const name of [
      'authorization',
      'accept',
      'user-agent',
      'x-app',
      'anthropic-dangerous-direct-browser-access',
    ]) {
      expect(headers.get(name)).toBeNull()
    }
    // Caller-provided betas pass through untouched (never stripped, never merged).
    expect(headers.get('anthropic-beta')).toBe('some-existing-beta')
    // The body is the request with only the model id swapped; system stays a
    // plain string and tool names are untouched.
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ ...requestBody, model: 'claude-sonnet-4' })
  })
})
