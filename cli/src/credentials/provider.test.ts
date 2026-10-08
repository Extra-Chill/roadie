// Credential pool provider tests: routing happens per candidate at the
// LanguageModel level (doGenerate/doStream), with providers resolved from the
// models.dev catalog. Upstreams are stubbed via the injected fetch and the
// catalog is injected; no real keys and no real network.

import { test, expect, describe, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
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
  createRoadiePoolProvider,
  POOL_HEADER,
  type PoolFetch,
} from './provider.js'
import type { ModelsDevCatalog } from './provider-catalog.js'
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

const NOW = 1_000_000

const TEST_CATALOG: ModelsDevCatalog = {
  anthropic: { id: 'anthropic', npm: '@ai-sdk/anthropic' },
  'zai-coding-plan': {
    id: 'zai-coding-plan',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.z.ai/api/coding/paas/v4',
  },
  groq: { id: 'groq', npm: '@ai-sdk/groq' },
  'unbundled-no-api': { id: 'unbundled-no-api', npm: '@ai-sdk/does-not-exist' },
}

/** Typed fetch mock with the preconnect member the AI SDK providers expect. */
type FetchPreconnect = {
  preconnect: (url: string | URL, options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }) => void
}

type FetchMock = ReturnType<typeof vi.fn<PoolFetch>> & FetchPreconnect

function stubFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): FetchMock {
  return Object.assign(vi.fn(handler), {
    preconnect: (
      _url: string | URL,
      _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean },
    ): void => {},
  })
}

function lastInit(fetchMock: FetchMock, callIndex: number): RequestInit {
  return fetchMock.mock.calls[callIndex]?.[1] ?? {}
}

function readStateOrThrow(): PoolState {
  const state = readPoolState({ dataDir, poolId: SHARED_POOL_ID })
  if (state instanceof Error) throw state
  return state
}

function jsonResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const ANTHROPIC_SSE_EVENT = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

/** Minimal Anthropic Messages SSE stream answering one text block. */
function anthropicSseResponse(text: string): Response {
  const body =
    ANTHROPIC_SSE_EVENT('message_start', {
      type: 'message_start',
      message: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }) +
    ANTHROPIC_SSE_EVENT('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    ANTHROPIC_SSE_EVENT('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }) +
    ANTHROPIC_SSE_EVENT('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ANTHROPIC_SSE_EVENT('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    ANTHROPIC_SSE_EVENT('message_stop', { type: 'message_stop' })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const ANTHROPIC_OK_RESPONSE = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  model: 'claude-sonnet-4',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}

const OPENAI_OK_RESPONSE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'glm-5.3-flash',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const OPENAI_STREAM_CHUNK = (delta: Record<string, unknown>, finish: string | null) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'glm-5.3-flash',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

async function seedPool({
  provider = 'anthropic',
  keys = ['anthropic-key-1'],
  rotation = ['anthropic/claude-sonnet-4'],
  rotationName = 'default',
  poolId = SHARED_POOL_ID,
}: {
  provider?: string
  keys?: string[]
  rotation?: string[]
  rotationName?: string
  poolId?: string
} = {}) {
  for (const key of keys) {
    const added = await addPoolAccount({ dataDir, poolId, provider, key })
    expect(added).not.toBeInstanceOf(Error)
  }
  const set = await setPoolRotation({ dataDir, poolId, name: rotationName, entries: rotation })
  expect(set).toBe(true)
}

function poolProvider(overrides: Parameters<typeof createRoadiePoolProvider>[0] = {}) {
  return createRoadiePoolProvider({
    dataDir,
    catalog: TEST_CATALOG,
    now: () => NOW,
    ...overrides,
  })
}

function generateOptions({
  pool,
  system,
  tools,
  extraHeaders = {},
}: {
  pool: string
  system?: string
  tools?: LanguageModelV3CallOptions['tools']
  extraHeaders?: Record<string, string>
}): LanguageModelV3CallOptions {
  return {
    prompt: [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    ...(tools && { tools }),
    headers: { [POOL_HEADER]: pool, ...extraHeaders },
  }
}

async function collectStream(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = []
  for await (const part of stream) {
    parts.push(part)
  }
  return parts
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
  test('cooldownUntilFromRetryAfter: retry-after seconds, default 60s, capped', () => {
    expect(cooldownUntilFromRetryAfter({ retryAfter: '30', now: NOW })).toBe(NOW + 30_000)
    expect(cooldownUntilFromRetryAfter({ retryAfter: '0', now: NOW })).toBe(NOW + 60_000)
    expect(cooldownUntilFromRetryAfter({ retryAfter: null, now: NOW })).toBe(NOW + 60_000)
    expect(cooldownUntilFromRetryAfter({ retryAfter: 'not-a-number', now: NOW })).toBe(NOW + 60_000)
    expect(cooldownUntilFromRetryAfter({ retryAfter: '999999', now: NOW })).toBe(NOW + 24 * 60 * 60 * 1000)
  })
})

describe('languageModel doGenerate fail-closed', () => {
  test('missing pool tag fails closed with a 401 and never reaches upstream', async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }).then(
      () => null,
      (cause: unknown) => cause,
    )
    expect(APICallError.isInstance(error)).toBe(true)
    if (!(error instanceof APICallError)) return
    expect(error.statusCode).toBe(401)
    expect(error.message).toBe('no credential pool on request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('pool without accounts fails closed with the actionable 401 message', async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate(generateOptions({ pool: 'shared' })).then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof APICallError)) throw error
    expect(error.statusCode).toBe(401)
    expect(error.message).toBe(
      'no usable accounts in pool shared; add one with roadie credentials add-key --pool shared or roadie credentials login anthropic --pool shared',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('pool without the requested rotation fails closed with its specific 401 message', async () => {
    await seedPool({ rotationName: 'other' })
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate(generateOptions({ pool: 'shared' })).then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof APICallError)) throw error
    expect(error.statusCode).toBe(401)
    expect(error.message).toBe('pool shared has no rotation named default')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('all accounts cooling down fails closed with 401 without touching upstream', async () => {
    const only = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-cold' })
    expect(only).not.toBeInstanceOf(Error)
    if (only instanceof Error) return
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })
    await markCooldownInStore({ dataDir, poolId: SHARED_POOL_ID, accountId: only.id, untilMs: NOW + 60_000 })

    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate(generateOptions({ pool: 'shared' })).then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof APICallError)) throw error
    expect(error.statusCode).toBe(401)
    expect(error.message).toBe(
      'no usable accounts in pool shared; add one with roadie credentials add-key --pool shared or roadie credentials login anthropic --pool shared',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('languageModel doGenerate routing', () => {
  test('an anthropic api key reaches api.anthropic.com with x-api-key, no x-roadie-* headers, and the real model id', async () => {
    await seedPool({ keys: ['sk-ant-abcd1234'] })
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(
      generateOptions({
        pool: 'shared',
        extraHeaders: {
          'x-roadie-session': 'ses_123',
          'anthropic-beta': 'some-existing-beta',
        },
      }),
    )
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [input, init] = fetchImpl.mock.calls[0]!
    expect(String(input)).toBe('https://api.anthropic.com/v1/messages')
    const headers = new Headers(init?.headers)
    for (const name of [...headers.keys()]) {
      expect(name.toLowerCase().startsWith('x-roadie-')).toBe(false)
    }
    expect(headers.get('x-api-key')).toBe('sk-ant-abcd1234')
    // Caller-provided headers pass through untouched; only x-roadie-* is stripped.
    expect(headers.get('anthropic-beta')).toBe('some-existing-beta')
    const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] }
    expect(body.model).toBe('claude-sonnet-4')
    expect(body.messages).toHaveLength(1)
  })

  test('a zai-coding-plan key reaches the z.ai base URL with Bearer auth and never api.openai.com', async () => {
    await seedPool({
      provider: 'zai-coding-plan',
      keys: ['zai-key-1234'],
      rotation: ['zai-coding-plan/glm-5.3-flash'],
    })
    const fetchImpl = stubFetch(async () => jsonResponse(200, OPENAI_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [input, init] = fetchImpl.mock.calls[0]!
    expect(String(input)).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions')
    expect(String(input)).not.toContain('api.openai.com')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer zai-key-1234')
    for (const name of [...headers.keys()]) {
      expect(name.toLowerCase().startsWith('x-roadie-')).toBe(false)
    }
    const body = JSON.parse(String(init?.body)) as { model: string }
    expect(body.model).toBe('glm-5.3-flash')
  })

  test('429 marks a cooldown with retry-after and fails over to the next account', async () => {
    const first = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-first' })
    const second = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-second' })
    expect(first).not.toBeInstanceOf(Error)
    expect(second).not.toBeInstanceOf(Error)
    if (first instanceof Error || second instanceof Error) return
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })

    const fetchImpl = stubFetch(async (input, init) => {
      const key = new Headers(init?.headers).get('x-api-key')
      if (key === 'sk-ant-first') {
        return jsonResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '30' })
      }
      return jsonResponse(200, { ...ANTHROPIC_OK_RESPONSE, content: [{ type: 'text', text: 'second account' }] })
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'second account' }])
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const state = readStateOrThrow()
    expect(state.cooldowns[first.id]).toBe(NOW + 30_000)
    // Only the successful account is marked used.
    expect(state.lastUsed).toEqual({ [second.id]: NOW })
  })

  test('a mixed-provider rotation: the first provider 429s, its cooldown is marked, and the second provider (a different SDK) answers', async () => {
    const zai = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'zai-coding-plan', key: 'zai-rl' })
    const anthropic = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-mixed' })
    expect(zai).not.toBeInstanceOf(Error)
    expect(anthropic).not.toBeInstanceOf(Error)
    if (zai instanceof Error || anthropic instanceof Error) return
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['zai-coding-plan/glm-5.3-flash', 'anthropic/claude-sonnet-4'],
    })

    const requestedUrls: string[] = []
    const fetchImpl = stubFetch(async (input, init) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.startsWith('https://api.z.ai/')) {
        return jsonResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '45' })
      }
      expect(new Headers(init?.headers).get('x-api-key')).toBe('sk-ant-mixed')
      return jsonResponse(200, { ...ANTHROPIC_OK_RESPONSE, content: [{ type: 'text', text: 'from anthropic' }] })
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'from anthropic' }])
    expect(requestedUrls).toEqual([
      'https://api.z.ai/api/coding/paas/v4/chat/completions',
      'https://api.anthropic.com/v1/messages',
    ])

    const state = readStateOrThrow()
    expect(state.cooldowns[zai.id]).toBe(NOW + 45_000)
    expect(state.cooldowns[anthropic.id]).toBeUndefined()
    expect(state.lastUsed).toEqual({ [anthropic.id]: NOW })
  })

  test('a 429 without retry-after cools the account down for 60s and surfaces the rate limit', async () => {
    const only = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-only' })
    expect(only).not.toBeInstanceOf(Error)
    if (only instanceof Error) return
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })

    const fetchImpl = stubFetch(async () => jsonResponse(429, { error: { message: 'rate limited' } }))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate(generateOptions({ pool: 'shared' })).then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof APICallError)) throw error
    expect(error.statusCode).toBe(429)
    const state = readStateOrThrow()
    expect(state.cooldowns[only.id]).toBe(NOW + 60_000)
  })

  test('an unsupported provider in the rotation is skipped untouched and a later candidate answers', async () => {
    const unsupported = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'unbundled-no-api',
      key: 'key-unbundled',
    })
    const anthropic = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-after' })
    expect(unsupported).not.toBeInstanceOf(Error)
    expect(anthropic).not.toBeInstanceOf(Error)
    if (unsupported instanceof Error || anthropic instanceof Error) return
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['unbundled-no-api/model-x', 'anthropic/claude-sonnet-4'],
    })

    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // The unsupported candidate was skipped without a cooldown or a dispatch.
    const state = readStateOrThrow()
    expect(state.cooldowns).toEqual({})
    expect(state.lastUsed).toEqual({ [anthropic.id]: NOW })
  })

  test('when only unsupported candidates remain, the 401 names the underlying reason', async () => {
    await seedPool({
      provider: 'unbundled-no-api',
      keys: ['key-unbundled'],
      rotation: ['unbundled-no-api/model-x'],
    })
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate(generateOptions({ pool: 'shared' })).then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof APICallError)) throw error
    expect(error.statusCode).toBe(401)
    expect(error.message).toContain('no usable account in pool shared')
    expect(error.message).toContain('unbundled-no-api')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('an account baseURL override wins over the catalog api URL', async () => {
    const account = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'zai-coding-plan',
      key: 'zai-custom',
      baseURL: 'https://zai-proxy.example.com/v4',
    })
    expect(account).not.toBeInstanceOf(Error)
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['zai-coding-plan/glm-5.3-flash'],
    })
    const fetchImpl = stubFetch(async () => jsonResponse(200, OPENAI_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://zai-proxy.example.com/v4/chat/completions')
  })

  test('a provider-level baseURL (gateway) wins over the catalog and the account', async () => {
    const account = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'zai-coding-plan',
      key: 'zai-gateway',
      baseURL: 'https://account-proxy.example.com/v4',
    })
    expect(account).not.toBeInstanceOf(Error)
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['zai-coding-plan/glm-5.3-flash'],
    })
    const fetchImpl = stubFetch(async () => jsonResponse(200, OPENAI_OK_RESPONSE))
    const model = poolProvider({ fetchImpl, baseURL: 'https://gateway.example.com/v1' }).languageModel('default')
    await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://gateway.example.com/v1/chat/completions')
  })

  test('a non-429 upstream error is returned as-is without a cooldown', async () => {
    await seedPool({ keys: ['sk-ant-err'] })
    const fetchImpl = stubFetch(async () => jsonResponse(500, { error: { message: 'boom' } }))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate(generateOptions({ pool: 'shared' })).then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof APICallError)) throw error
    expect(error.statusCode).toBe(500)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const state = readStateOrThrow()
    expect(state.cooldowns).toEqual({})
  })
})

describe('languageModel doStream routing', () => {
  test('a zai-coding-plan key streams from the z.ai base URL', async () => {
    await seedPool({
      provider: 'zai-coding-plan',
      keys: ['zai-stream'],
      rotation: ['zai-coding-plan/glm-5.3-flash'],
    })
    const fetchImpl = stubFetch(async () =>
      sseResponse([OPENAI_STREAM_CHUNK({ role: 'assistant', content: 'ok' }, null), OPENAI_STREAM_CHUNK({}, 'stop')]),
    )
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doStream(generateOptions({ pool: 'shared' }))
    const parts = await collectStream(result.stream)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions')
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta).join('')).toBe('ok')
  })

  test('a 429 during doStream fails over to the next candidate', async () => {
    const zai = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'zai-coding-plan', key: 'zai-stream-rl' })
    const anthropic = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-ant-stream' })
    expect(zai).not.toBeInstanceOf(Error)
    expect(anthropic).not.toBeInstanceOf(Error)
    if (zai instanceof Error || anthropic instanceof Error) return
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['zai-coding-plan/glm-5.3-flash', 'anthropic/claude-sonnet-4'],
    })
    const fetchImpl = stubFetch(async (input) => {
      if (String(input).startsWith('https://api.z.ai/')) {
        return jsonResponse(429, { error: { message: 'rate limited' } })
      }
      return anthropicSseResponse('ok')
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doStream(generateOptions({ pool: 'shared' }))
    const parts = await collectStream(result.stream)
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta).join('')).toBe('ok')
    const state = readStateOrThrow()
    expect(state.cooldowns[zai.id]).toBe(NOW + 60_000)
    expect(state.lastUsed).toEqual({ [anthropic.id]: NOW })
  })
})

describe('pool lists', () => {
  test('tries the listed pools in order: the first pool with usable accounts answers', async () => {
    await seedPool({ keys: ['sk-ant-alice'], poolId: 'alice' })
    await seedPool({ keys: ['sk-ant-shared'] })
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'alice,shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
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
    const fetchImpl = stubFetch(async () =>
      jsonResponse(200, { ...ANTHROPIC_OK_RESPONSE, content: [{ type: 'text', text: 'from shared' }] }),
    )
    const model = poolProvider({ fetchImpl }).languageModel('default')
    await seedPool({ keys: ['sk-ant-shared'] })
    const result = await model.doGenerate(generateOptions({ pool: 'alice,shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'from shared' }])
    expect(new Headers(lastInit(fetchImpl, 0).headers).get('x-api-key')).toBe('sk-ant-shared')
  })

  test('a fully-cooled billed pool falls through to the shared fallback pool', async () => {
    const cooled = await addPoolAccount({ dataDir, poolId: 'alice', provider: 'anthropic', key: 'sk-ant-cold' })
    expect(cooled).not.toBeInstanceOf(Error)
    if (cooled instanceof Error) return
    await setPoolRotation({ dataDir, poolId: 'alice', name: 'default', entries: ['anthropic/claude-sonnet-4'] })
    await markCooldownInStore({ dataDir, poolId: 'alice', accountId: cooled.id, untilMs: NOW + 60_000 })
    await seedPool({ keys: ['sk-ant-shared'] })

    const fetchImpl = stubFetch(async () =>
      jsonResponse(200, { ...ANTHROPIC_OK_RESPONSE, content: [{ type: 'text', text: 'from shared' }] }),
    )
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'alice,shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'from shared' }])
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

    const fetchImpl = stubFetch(async (input, init) => {
      const key = new Headers(init?.headers).get('x-api-key')
      if (key === 'sk-ant-alice') {
        return jsonResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '30' })
      }
      return jsonResponse(200, { ...ANTHROPIC_OK_RESPONSE, content: [{ type: 'text', text: 'from shared' }] })
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'alice,shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'from shared' }])
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
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate(generateOptions({ pool: 'alice,shared' })).then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof APICallError)) throw error
    expect(error.statusCode).toBe(401)
    expect(error.message).toBe(
      'no usable accounts in pool alice,shared; add one with roadie credentials add-key --pool alice or roadie credentials login anthropic --pool alice',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a single pool id in the list behaves exactly as before', async () => {
    await seedPool({ keys: ['sk-ant-single'] })
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new Headers(lastInit(fetchImpl, 0).headers).get('x-api-key')).toBe('sk-ant-single')
  })
})

describe('oauth accounts', () => {
  test('concurrent requests refresh an expiring oauth account once and share the rotated tokens', async () => {
    await seedOAuthPool({ accounts: [{ access: 'at-old', refresh: 'rt-old', expiresInMs: 10_000 }] })
    let refreshCount = 0
    const auths: string[] = []
    const fetchImpl = stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        refreshCount += 1
        // Give the second request time to queue on the pool lock.
        await new Promise((resolve) => setTimeout(resolve, 10))
        return jsonResponse(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 })
      }
      const headers = new Headers(init?.headers)
      auths.push(headers.get('authorization') ?? '')
      return jsonResponse(200, ANTHROPIC_OK_RESPONSE)
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const request = () => model.doGenerate(generateOptions({ pool: 'shared' }))
    const [first, second] = await Promise.all([request(), request()])
    expect(first.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(second.content).toEqual([{ type: 'text', text: 'ok' }])
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
  })

  test('an oauth account expiring beyond the 60s lead is dispatched without a refresh', async () => {
    await seedOAuthPool({ accounts: [{ access: 'at-fresh', refresh: 'rt-fresh', expiresInMs: 61_000 }] })
    const auths: string[] = []
    const fetchImpl = stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        throw new Error('token endpoint must not be called in this test')
      }
      const headers = new Headers(init?.headers)
      auths.push(headers.get('authorization') ?? '')
      return jsonResponse(200, ANTHROPIC_OK_RESPONSE)
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    await model.doGenerate(generateOptions({ pool: 'shared' }))
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
    const fetchImpl = stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        return jsonResponse(400, { error: 'invalid_grant' })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer at-alive')
      return jsonResponse(200, ANTHROPIC_OK_RESPONSE)
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'shared' }))
    // The refresh failure never surfaces: the next candidate serves the request.
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
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
    const fetchImpl = stubFetch(async (input, init) => {
      if (isTokenUrl(input)) {
        return jsonResponse(500, { error: 'server_error' })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer at-healthy')
      return jsonResponse(200, ANTHROPIC_OK_RESPONSE)
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
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
      return jsonResponse(200, {
        type: 'message',
        id: 'msg_tool',
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(
      generateOptions({
        pool: 'shared',
        system: 'You are OpenCode.',
        tools: [
          {
            type: 'function',
            name: 'bash',
            description: 'run a command',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        extraHeaders: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
      }),
    )
    // The streamed tool name came back reversed to the opencode name.
    expect(result.content).toEqual([
      { type: 'tool-call', toolCallId: 'tool_1', toolName: 'bash', input: '{}' },
    ])

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
      if (authHeaders.length === 1) return jsonResponse(429, { error: { message: 'rate limited' } })
      return jsonResponse(200, { ...ANTHROPIC_OK_RESPONSE, content: [{ type: 'text', text: 'api account' }] })
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const result = await model.doGenerate(generateOptions({ pool: 'shared' }))
    expect(result.content).toEqual([{ type: 'text', text: 'api account' }])
    expect(authHeaders).toEqual([
      ['Bearer at-mixed', ''],
      ['', 'sk-ant-fallback'],
    ])
  })

  test('a non-anthropic oauth account is unsupported with a clear error', async () => {
    await addPoolOAuthAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'openai',
      refresh: 'rt-oai',
      access: 'at-oai',
      expires: NOW + 10 * 3_600_000,
    })
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['openai/gpt-5.1'] })
    const fetchImpl = stubFetch(async () => jsonResponse(200, ANTHROPIC_OK_RESPONSE))
    const model = poolProvider({ fetchImpl }).languageModel('default')
    const error = await model.doGenerate(generateOptions({ pool: 'shared' })).then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof APICallError)) throw error
    expect(error.statusCode).toBe(401)
    expect(error.message).toContain('no OAuth adapter for openai')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('api-key regression', () => {
  test('api-key requests carry no oauth headers and the body is unchanged apart from the model', async () => {
    await seedPool({ keys: ['sk-ant-regression'] })
    let capturedInit: RequestInit | undefined
    const fetchImpl = stubFetch(async (_input, init) => {
      capturedInit = init
      return jsonResponse(200, ANTHROPIC_OK_RESPONSE)
    })
    const model = poolProvider({ fetchImpl }).languageModel('default')
    await model.doGenerate(
      generateOptions({
        pool: 'shared',
        system: 'You are OpenCode.',
        tools: [
          {
            type: 'function',
            name: 'bash',
            description: 'run a command',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        extraHeaders: { 'anthropic-beta': 'some-existing-beta' },
      }),
    )

    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('x-api-key')).toBe('sk-ant-regression')
    for (const name of [
      'authorization',
      'x-app',
      'anthropic-dangerous-direct-browser-access',
    ]) {
      expect(headers.get(name)).toBeNull()
    }
    // The user agent is the SDK's own, never the Claude Code one.
    expect(headers.get('user-agent')?.startsWith('ai-sdk/anthropic')).toBe(true)
    // Caller-provided betas pass through untouched (never stripped, never merged).
    expect(headers.get('anthropic-beta')).toBe('some-existing-beta')
    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string
      system: string
      tools: Array<{ name: string }>
    }
    // Plain API keys get no Claude Code shaping: system stays a plain string
    // and tool names are untouched.
    expect(body.model).toBe('claude-sonnet-4')
    expect(body.system).toEqual([{ type: 'text', text: 'You are OpenCode.' }])
    expect(body.tools[0]?.name).toBe('bash')
  })
})
