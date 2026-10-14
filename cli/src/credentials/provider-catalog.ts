// models.dev provider catalog for credential pools (issue #136).
//
// Pi's pool proxy (./messages-proxy.ts) serves Anthropic accounts on the
// Messages wire and every other API-key account as OpenAI-compatible, against
// the account's own `baseURL` override or else the catalog's `api` base URL.
// The catalog also validates free-text provider names (`credentials add-key`).
//
// `https://models.dev/api.json` is fetched once per process and cached under
// `<dataDir>/credentials/models-dev.json`. Nothing here is provider-specific:
// provider ids stay catalog data. Every function takes the data directory
// explicitly instead of importing cli/src/config.ts.

import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'

export const MODELS_DEV_API_URL = 'https://models.dev/api.json'

export type CatalogFetch = typeof fetch

/** One models.dev provider entry, reduced to the fields routing needs. */
export type ModelsDevCatalogEntry = {
  id: string
  /** OpenAI-compatible base URL for providers without a dedicated SDK. */
  api?: string
  env?: string[]
  name?: string
}

export type ModelsDevCatalog = Record<string, ModelsDevCatalogEntry>

// ── Catalog loading ──────────────────────────────────────────────

/** Roadie's models.dev cache. */
export function catalogCachePath({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, 'credentials', 'models-dev.json')
}

/** Reduce a parsed models.dev payload to the entries routing needs. */
export function parseCatalog(json: unknown): ModelsDevCatalog | Error {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return new Error('models.dev catalog is not a JSON object')
  }
  const catalog: ModelsDevCatalog = {}
  for (const [id, value] of Object.entries(json as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    catalog[id] = {
      id,
      ...(typeof record.api === 'string' && { api: record.api }),
      ...(Array.isArray(record.env) && {
        env: record.env.filter((name): name is string => typeof name === 'string'),
      }),
      ...(typeof record.name === 'string' && { name: record.name }),
    }
  }
  return catalog
}

/** Read a catalog JSON file; an Error means "no usable catalog here". */
export function readCatalogFile(filePath: string): ModelsDevCatalog | Error {
  const text = errore.try({
    try: () => fs.readFileSync(filePath, 'utf8'),
    catch: (cause: unknown) =>
      new Error(`no models.dev catalog at ${filePath}`, { cause }),
  })
  if (text instanceof Error) return text
  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause: unknown) =>
      new Error(`Failed to parse the models.dev catalog at ${filePath}`, { cause }),
  })
  if (parsed instanceof Error) return parsed
  const catalog = parseCatalog(parsed)
  if (catalog instanceof Error) {
    return new Error(`Failed to parse the models.dev catalog at ${filePath}: ${catalog.message}`)
  }
  return catalog
}

function writeCatalogCache({ filePath, catalog }: { filePath: string; catalog: ModelsDevCatalog }): void {
  // Best-effort: losing the cache write only means the next process fetches again.
  const write = errore.try({
    try: () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(catalog))
    },
    catch: () => null,
  })
  void write
}

async function fetchCatalog({
  dataDir,
  fetchImpl,
}: {
  dataDir: string
  fetchImpl: CatalogFetch
}): Promise<ModelsDevCatalog | Error> {
  const response = await fetchImpl(MODELS_DEV_API_URL, { headers: { accept: 'application/json' } }).catch(
    (cause: unknown) =>
      new Error(`Failed to fetch ${MODELS_DEV_API_URL}`, { cause }),
  )
  if (response instanceof Error) return response
  if (!response.ok) {
    return new Error(`Failed to fetch ${MODELS_DEV_API_URL}: HTTP ${response.status}`)
  }
  const text = await response.text().catch((cause: unknown) =>
    new Error(`Failed to read the models.dev response`, { cause }),
  )
  if (text instanceof Error) return text
  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause: unknown) => new Error('models.dev returned invalid JSON', { cause }),
  })
  if (parsed instanceof Error) return parsed
  const catalog = parseCatalog(parsed)
  if (catalog instanceof Error) return catalog
  writeCatalogCache({ filePath: catalogCachePath({ dataDir }), catalog })
  return catalog
}

// Memoized per process so concurrent requests share one load
// and the fetch runs at most once. A failed load clears the memo so a later
// request can retry (e.g. after the network comes back).
let catalogLoad: Promise<ModelsDevCatalog | Error> | null = null

/** Test hook: drop the memoized catalog so the next resolve starts over, or preset it. */
export function resetCatalogCacheForTests(catalog?: ModelsDevCatalog): void {
  catalogLoad = catalog ? Promise.resolve(catalog) : null
}

export async function resolveCatalog({
  dataDir,
  fetchImpl = fetch,
}: {
  dataDir: string
  fetchImpl?: CatalogFetch
}): Promise<ModelsDevCatalog | Error> {
  if (!catalogLoad) {
    catalogLoad = (async () => {
      const cached = readCatalogFile(catalogCachePath({ dataDir }))
      if (!(cached instanceof Error)) return cached
      const fetched = await fetchCatalog({ dataDir, fetchImpl })
      if (fetched instanceof Error) catalogLoad = null
      return fetched
    })()
  }
  return catalogLoad
}

// ── Validation (credentials add-key) ─────────────────────────────

/** Providers the pool serves on their own wire: Anthropic Messages, and ChatGPT (Codex) for OpenAI. */
const FIRST_PARTY_POOL_PROVIDERS: readonly string[] = ['anthropic', 'openai']

/**
 * True when the pool can serve an account for the provider without a
 * `baseURL` override: a first-party provider, or a catalog provider with an
 * OpenAI-compatible `api` URL.
 */
export function isCatalogProviderRoutable(catalog: ModelsDevCatalog, provider: string): boolean {
  if (FIRST_PARTY_POOL_PROVIDERS.includes(provider)) return true
  return Boolean(catalog[provider]?.api)
}

/** Bounded Levenshtein distance, cut off past `max` (used for close matches). */
function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMinimum = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      current.push(value)
      if (value < rowMinimum) rowMinimum = value
    }
    if (rowMinimum > max) return false
    previous = current
  }
  return (previous[b.length] ?? Number.POSITIVE_INFINITY) <= max
}

/** Catalog ids close to the unknown provider name (typo suggestions). */
export function closestCatalogProviders({
  catalog,
  provider,
  limit = 5,
}: {
  catalog: ModelsDevCatalog
  provider: string
  limit?: number
}): string[] {
  const needle = provider.toLowerCase()
  const scored: Array<{ id: string; distance: number }> = []
  for (const id of Object.keys(catalog)) {
    const lowercase = id.toLowerCase()
    let distance = Number.POSITIVE_INFINITY
    if (lowercase === needle) distance = 0
    else if (lowercase.includes(needle) || needle.includes(lowercase)) distance = 1
    else if (editDistanceWithin(lowercase, needle, 2)) distance = 2
    if (distance !== Number.POSITIVE_INFINITY) scored.push({ id, distance })
  }
  scored.sort((a, b) => (a.distance - b.distance) || a.id.localeCompare(b.id))
  return scored.slice(0, limit).map((entry) => entry.id)
}

/**
 * Check a free-text provider name against the catalog. null when known; an
 * Error listing close matches when not. Callers let an explicit `baseURL`
 * bypass this: a custom endpoint is exactly the case the catalog cannot know.
 */
export function validateCatalogProvider({
  catalog,
  provider,
}: {
  catalog: ModelsDevCatalog
  provider: string
}): Error | null {
  if (catalog[provider]) return null
  const matches = closestCatalogProviders({ catalog, provider })
  if (matches.length > 0) {
    return new Error(
      `Unknown provider '${provider}'. Closest models.dev providers: ${matches.join(', ')}`,
    )
  }
  return new Error(
    `Unknown provider '${provider}': not in the models.dev catalog. ` +
      'Pass a --base-url to route it as a custom OpenAI-compatible endpoint.',
  )
}
