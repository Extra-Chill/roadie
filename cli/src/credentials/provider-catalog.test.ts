// models.dev catalog tests: resolution order (bundled SDK, OpenAI-compatible
// against the catalog `api` URL, the account baseURL override, unsupported),
// close-match validation, and the cache/fetch chain (opencode cache, roadie
// cache, one models.dev fetch). No real network: fetch is always injected.

import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  catalogModelContextLimit,
  closestCatalogProviders,
  fallbackCatalogCachePath,
  opencodeCatalogCachePath,
  parseCatalog,
  readCatalogFile,
  resetCatalogCacheForTests,
  resolveCandidateModelFactory,
  resolveCatalog,
  validateCatalogProvider,
  type CatalogFetch,
  type ModelsDevCatalog,
} from './provider-catalog.js'

let dataDir: string
let originalXdgCacheHome: string | undefined

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-catalog-'))
  originalXdgCacheHome = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-cache-'))
  resetCatalogCacheForTests()
})

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome
  resetCatalogCacheForTests()
})

const GROQ_OK_RESPONSE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'llama-3.3-70b-versatile',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

type FetchPreconnect = {
  preconnect: (url: string | URL, options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }) => void
}

type PlainFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type FetchMock = ReturnType<typeof vi.fn<PlainFetch>> & FetchPreconnect

function stubFetch(handler: PlainFetch): FetchMock {
  return Object.assign(vi.fn(handler), {
    preconnect: (
      _url: string | URL,
      _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean },
    ): void => {},
  })
}

const CATALOG: ModelsDevCatalog = {
  anthropic: { id: 'anthropic', npm: '@ai-sdk/anthropic' },
  groq: { id: 'groq', npm: '@ai-sdk/groq' },
  'zai-coding-plan': {
    id: 'zai-coding-plan',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.z.ai/api/coding/paas/v4',
  },
  deepseek: { id: 'deepseek', npm: '@ai-sdk/openai-compatible', api: 'https://api.deepseek.com' },
  'unbundled-no-api': { id: 'unbundled-no-api', npm: '@ai-sdk/does-not-exist' },
}

describe('resolveCandidateModelFactory', () => {
  test('a bundled SDK (groq) serves requests from the SDK default endpoint', async () => {
    const fetchImpl = stubFetch(async () =>
      Response.json(GROQ_OK_RESPONSE, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const factory = resolveCandidateModelFactory({
      catalog: CATALOG,
      provider: 'groq',
      apiKey: 'gsk_test',
      fetchImpl,
    })
    expect(factory).not.toBeInstanceOf(Error)
    if (factory instanceof Error) return
    const model = factory('llama-3.3-70b-versatile')
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://api.groq.com/openai/v1/chat/completions',
    )
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer gsk_test')
  })

  test('an openai-compatible catalog entry (zai-coding-plan) uses the catalog api URL', async () => {
    const fetchImpl = stubFetch(async () =>
      Response.json(GROQ_OK_RESPONSE, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const factory = resolveCandidateModelFactory({
      catalog: CATALOG,
      provider: 'zai-coding-plan',
      apiKey: 'zai_test',
      fetchImpl,
    })
    expect(factory).not.toBeInstanceOf(Error)
    if (factory instanceof Error) return
    const model = factory('glm-5.3-flash')
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions')
  })

  test('the account baseURL override wins over the catalog api URL', async () => {
    const fetchImpl = stubFetch(async () =>
      Response.json(GROQ_OK_RESPONSE, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const factory = resolveCandidateModelFactory({
      catalog: CATALOG,
      provider: 'zai-coding-plan',
      apiKey: 'zai_test',
      baseURL: 'https://self-hosted.example.com/v4',
      fetchImpl,
    })
    expect(factory).not.toBeInstanceOf(Error)
    if (factory instanceof Error) return
    await factory('glm-5.3-flash').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://self-hosted.example.com/v4/chat/completions')
  })

  test('an unknown provider with a baseURL routes as OpenAI-compatible', async () => {
    const fetchImpl = stubFetch(async () =>
      Response.json(GROQ_OK_RESPONSE, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const factory = resolveCandidateModelFactory({
      catalog: CATALOG,
      provider: 'my-opencode-provider',
      apiKey: 'k',
      baseURL: 'https://custom.example.com/v1',
      fetchImpl,
    })
    expect(factory).not.toBeInstanceOf(Error)
    if (factory instanceof Error) return
    await factory('m').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://custom.example.com/v1/chat/completions')
  })

  test('an unbundled npm package without a catalog api URL is unsupported', () => {
    const factory = resolveCandidateModelFactory({
      catalog: CATALOG,
      provider: 'unbundled-no-api',
      apiKey: 'k',
    })
    expect(factory).toBeInstanceOf(Error)
    if (!(factory instanceof Error)) return
    expect(factory.message).toContain('@ai-sdk/does-not-exist')
    expect(factory.message).toContain('does not bundle')
  })

  test('a provider missing from the catalog without a baseURL is unsupported with actionable text', () => {
    const factory = resolveCandidateModelFactory({
      catalog: CATALOG,
      provider: 'who-dis',
      apiKey: 'k',
    })
    expect(factory).toBeInstanceOf(Error)
    if (!(factory instanceof Error)) return
    expect(factory.message).toContain('not in the models.dev catalog')
    expect(factory.message).toContain('--base-url')
  })
})

describe('catalog loading', () => {
  test('reads the opencode models.dev cache when present', async () => {
    const cachePath = opencodeCatalogCachePath()
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify(CATALOG))
    const fetchImpl = stubFetch(async () => Response.json({}))
    const catalog = await resolveCatalog({ dataDir, fetchImpl })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(catalog['zai-coding-plan']?.api).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a missing cache falls back to one models.dev fetch, cached under the data dir', async () => {
    const fetchImpl = stubFetch(async () => Response.json(CATALOG))
    const catalog = await resolveCatalog({ dataDir, fetchImpl })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(fetchImpl.mock.calls).toHaveLength(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://models.dev/api.json')
    // The fetched catalog is cached for later processes.
    const cached = readCatalogFile(fallbackCatalogCachePath({ dataDir }))
    expect(cached).not.toBeInstanceOf(Error)
    if (cached instanceof Error) return
    expect(cached['deepseek']?.api).toBe('https://api.deepseek.com')

    // Concurrent and later resolves in this process reuse the memo: still one fetch.
    await Promise.all([
      resolveCatalog({ dataDir, fetchImpl: stubFetch(async () => Response.json({})) }),
      resolveCatalog({ dataDir, fetchImpl: stubFetch(async () => Response.json({})) }),
    ])
    expect(fetchImpl.mock.calls).toHaveLength(1)
  })

  test('after a reset, the roadie cache answers without a fetch', async () => {
    const fetchImpl = stubFetch(async () => Response.json(CATALOG))
    await resolveCatalog({ dataDir, fetchImpl })
    expect(fetchImpl.mock.calls).toHaveLength(1)
    resetCatalogCacheForTests()
    const catalog = await resolveCatalog({ dataDir, fetchImpl: stubFetch(async () => Response.json({})) })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(catalog['groq']?.npm).toBe('@ai-sdk/groq')
  })

  test('a failed fetch clears the memo so a later request can retry', async () => {
    const failing = stubFetch(async () => new Response('nope', { status: 500 }))
    const first = await resolveCatalog({ dataDir, fetchImpl: failing })
    expect(first).toBeInstanceOf(Error)
    const second = await resolveCatalog({ dataDir, fetchImpl: stubFetch(async () => Response.json(CATALOG)) })
    expect(second).not.toBeInstanceOf(Error)
  })

  test('a malformed opencode cache is ignored in favor of the roadie cache', async () => {
    const cachePath = opencodeCatalogCachePath()
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, '{not json')
    fs.mkdirSync(path.join(dataDir, 'credentials'), { recursive: true })
    fs.writeFileSync(fallbackCatalogCachePath({ dataDir }), JSON.stringify(CATALOG))
    const catalog = await resolveCatalog({ dataDir, fetchImpl: stubFetch(async () => Response.json({})) })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(catalog['anthropic']?.npm).toBe('@ai-sdk/anthropic')
  })
})

describe('parseCatalog and validation', () => {
  test('parseCatalog reduces entries to the routing fields and skips junk', () => {
    const catalog = parseCatalog({
      groq: { id: 'groq', npm: '@ai-sdk/groq', api: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'], name: 'Groq', models: { big: {} } },
      broken: 'not-an-object',
      'env-not-array': { id: 'x', env: 'GROQ_API_KEY' },
    })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(catalog['groq']).toEqual({
      id: 'groq',
      npm: '@ai-sdk/groq',
      api: 'https://api.groq.com/openai/v1',
      env: ['GROQ_API_KEY'],
      name: 'Groq',
    })
    expect(catalog['broken']).toBeUndefined()
    expect(catalog['env-not-array']?.env).toBeUndefined()
  })

  test('parseCatalog rejects non-objects', () => {
    expect(parseCatalog(null)).toBeInstanceOf(Error)
    expect(parseCatalog([1, 2])).toBeInstanceOf(Error)
    expect(parseCatalog('nope')).toBeInstanceOf(Error)
  })

  test('parseCatalog keeps per-model context limits and drops malformed ones', () => {
    const catalog = parseCatalog({
      anthropic: {
        id: 'anthropic',
        npm: '@ai-sdk/anthropic',
        models: {
          'claude-sonnet-4': { limit: { context: 200000, output: 64000 } },
          'limitless-model': { limit: { context: 1 } },
          'no-limit': {},
          'bad-context': { limit: { context: 'big' } },
          'negative-context': { limit: { context: -5 } },
        },
      },
      'models-not-object': { id: 'x', models: 'nope' },
    })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(catalog['anthropic']?.models).toEqual({
      'claude-sonnet-4': { context: 200000 },
      'limitless-model': { context: 1 },
    })
    expect(catalog['models-not-object']?.models).toBeUndefined()
  })

  test('catalogModelContextLimit resolves per provider/model and is undefined when unknown', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: { 'claude-sonnet-4': { context: 200000 } },
      },
      groq: { id: 'groq', npm: '@ai-sdk/groq' },
    }
    expect(catalogModelContextLimit({ catalog, provider: 'anthropic', modelId: 'claude-sonnet-4' })).toBe(200000)
    // Unknown model, unknown provider, and a provider without limits all fail open.
    expect(catalogModelContextLimit({ catalog, provider: 'anthropic', modelId: 'who-dis' })).toBeUndefined()
    expect(catalogModelContextLimit({ catalog, provider: 'who-dis', modelId: 'claude-sonnet-4' })).toBeUndefined()
    expect(catalogModelContextLimit({ catalog, provider: 'groq', modelId: 'llama-3.3-70b-versatile' })).toBeUndefined()
  })

  test('closestCatalogProviders ranks exact, substring and near matches', () => {
    // Substring match: the unknown name is contained in the catalog id.
    expect(closestCatalogProviders({ catalog: CATALOG, provider: 'zai-coding' })).toEqual(['zai-coding-plan'])
    // Edit distance 1: a typo'd name is still suggested.
    expect(closestCatalogProviders({ catalog: CATALOG, provider: 'grog' })).toEqual(['groq'])
    // Unrelated names suggest nothing.
    expect(closestCatalogProviders({ catalog: CATALOG, provider: 'qqqqqq' })).toEqual([])
  })

  test('validateCatalogProvider: known provider passes; unknown lists close matches', () => {
    expect(validateCatalogProvider({ catalog: CATALOG, provider: 'groq' })).toBeNull()
    const unknown = validateCatalogProvider({ catalog: CATALOG, provider: 'zai-coding' })
    expect(unknown).toBeInstanceOf(Error)
    if (!(unknown instanceof Error)) return
    expect(unknown.message).toContain('Unknown provider')
    expect(unknown.message).toContain('zai-coding-plan')
  })

  test('validateCatalogProvider: an unknown name with no close matches points at --base-url', () => {
    const unknown = validateCatalogProvider({ catalog: CATALOG, provider: 'zzzzzz-not-close' })
    expect(unknown).toBeInstanceOf(Error)
    if (!(unknown instanceof Error)) return
    expect(unknown.message).toContain('--base-url')
  })
})
