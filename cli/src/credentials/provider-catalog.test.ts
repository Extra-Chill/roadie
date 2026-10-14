// models.dev catalog tests: parsing, close-match validation, routability, and
// the cache/fetch chain (roadie cache, one models.dev fetch). No real network:
// fetch is always injected.

import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  catalogCachePath,
  closestCatalogProviders,
  isCatalogProviderRoutable,
  parseCatalog,
  readCatalogFile,
  resetCatalogCacheForTests,
  resolveCatalog,
  validateCatalogProvider,
  type ModelsDevCatalog,
} from './provider-catalog.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-catalog-'))
  resetCatalogCacheForTests()
})

afterEach(() => {
  resetCatalogCacheForTests()
})


function stubFetch(handler: () => Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

const CATALOG: ModelsDevCatalog = {
  anthropic: { id: 'anthropic' },
  groq: { id: 'groq' },
  'zai-coding-plan': { id: 'zai-coding-plan', api: 'https://api.z.ai/api/coding/paas/v4' },
  deepseek: { id: 'deepseek', api: 'https://api.deepseek.com' },
}

test('isCatalogProviderRoutable: first-party providers and catalog api URLs are served, the rest need --base-url', () => {
  expect(isCatalogProviderRoutable(CATALOG, 'anthropic')).toBe(true)
  expect(isCatalogProviderRoutable(CATALOG, 'openai')).toBe(true)
  expect(isCatalogProviderRoutable(CATALOG, 'zai-coding-plan')).toBe(true)
  expect(isCatalogProviderRoutable(CATALOG, 'groq')).toBe(false)
  expect(isCatalogProviderRoutable(CATALOG, 'who-dis')).toBe(false)
})

describe('catalog loading', () => {
  test('a missing cache falls back to one models.dev fetch, cached under the data dir', async () => {
    const fetchImpl = stubFetch(async () => Response.json(CATALOG))
    const catalog = await resolveCatalog({ dataDir, fetchImpl })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(fetchImpl.mock.calls).toHaveLength(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://models.dev/api.json')
    // The fetched catalog is cached for later processes.
    const cached = readCatalogFile(catalogCachePath({ dataDir }))
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
    expect(catalog['deepseek']?.api).toBe('https://api.deepseek.com')
  })

  test('a failed fetch clears the memo so a later request can retry', async () => {
    const failing = stubFetch(async () => new Response('nope', { status: 500 }))
    const first = await resolveCatalog({ dataDir, fetchImpl: failing })
    expect(first).toBeInstanceOf(Error)
    const second = await resolveCatalog({ dataDir, fetchImpl: stubFetch(async () => Response.json(CATALOG)) })
    expect(second).not.toBeInstanceOf(Error)
  })
})

describe('parseCatalog and validation', () => {
  test('parseCatalog reduces entries to the routing fields and skips junk', () => {
    const catalog = parseCatalog({
      groq: { id: 'groq', api: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'], name: 'Groq', models: { big: {} } },
      broken: 'not-an-object',
      'env-not-array': { id: 'x', env: 'GROQ_API_KEY' },
    })
    expect(catalog).not.toBeInstanceOf(Error)
    if (catalog instanceof Error) return
    expect(catalog['groq']).toEqual({
      id: 'groq',
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
