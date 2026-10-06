import { test, expect, describe, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  addPoolAccount,
  markCooldown as markCooldownInStore,
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
    expect(await response.json()).toMatchObject({ error: { message: 'pool shared has no accounts' } })
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

  test('all accounts cooling down returns 429 without touching upstream', async () => {
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
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({
      error: { message: 'all accounts in pool shared are cooling down' },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
