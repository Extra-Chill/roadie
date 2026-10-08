// models.dev provider catalog for credential pools (issue #136).
//
// Resolves a pool account's provider id (`zai-coding-plan`, `groq`, ...) to an
// AI SDK language-model factory:
//   1. the catalog's `npm` package, when roadie bundles that SDK,
//   2. otherwise the catalog's `api` base URL via @ai-sdk/openai-compatible,
//   3. otherwise the account's own `baseURL` override via
//      @ai-sdk/openai-compatible (custom or self-hosted endpoints, and
//      providers declared only in opencode config),
//   4. otherwise unsupported, with a clear error.
//
// Catalog source is the models.dev data opencode already caches
// (`$XDG_CACHE_HOME/opencode/models.json`, default
// `~/.cache/opencode/models.json`). When that file is missing,
// `https://models.dev/api.json` is fetched once per process and cached under
// `<dataDir>/credentials/models-dev.json`. Nothing here is provider-specific:
// provider ids stay catalog data, and the only hardcoded names are the npm
// packages roadie actually bundles (plus the OAuth adapters, which live in
// credentials/adapters/).
//
// This module is imported by the provider module that runs inside the
// OpenCode server process: node builtins and the bundled AI SDK packages
// only, and every function takes the data directory explicitly instead of
// importing cli/src/config.ts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import * as errore from 'errore'

export const MODELS_DEV_API_URL = 'https://models.dev/api.json'

/** The global fetch type (bun-types) carries a preconnect member; match it so the fetch installs cleanly on the AI SDK providers. */
export type CatalogFetch = typeof fetch

/** One models.dev provider entry, reduced to the fields routing needs. */
export type ModelsDevCatalogEntry = {
  id: string
  /** npm package models.dev recommends (e.g. `@ai-sdk/groq`). */
  npm?: string
  /** OpenAI-compatible base URL for providers without a dedicated SDK. */
  api?: string
  env?: string[]
  name?: string
}

export type ModelsDevCatalog = Record<string, ModelsDevCatalogEntry>

/** Builds the provider's language model for one candidate request. */
export type CandidateModelFactory = (modelId: string) => LanguageModelV3

export type BundledProviderSettings = {
  apiKey?: string
  baseURL?: string
  fetch?: CatalogFetch
}

type BundledProvider = { languageModel: (modelId: string) => LanguageModelV3 }

/**
 * The AI SDK packages roadie bundles. A catalog `npm` value outside this set
 * is never imported at runtime; those providers route through
 * @ai-sdk/openai-compatible with the catalog's `api` URL instead.
 * `@ai-sdk/openai-compatible` itself needs no map entry: it *is* the
 * fallback, so its npm value routes through the same factory below.
 */
const BUNDLED_PROVIDER_FACTORIES: Record<string, (settings: BundledProviderSettings) => BundledProvider> = {
  '@ai-sdk/anthropic': (settings) => createAnthropic(settings),
  '@ai-sdk/openai': (settings) => createOpenAI(settings),
  '@ai-sdk/google': (settings) => createGoogleGenerativeAI(settings),
  '@ai-sdk/groq': (settings) => createGroq(settings),
  '@ai-sdk/xai': (settings) => createXai(settings),
  '@ai-sdk/mistral': (settings) => createMistral(settings),
  '@openrouter/ai-sdk-provider': (settings) => createOpenRouter(settings),
}

// ── Catalog loading ──────────────────────────────────────────────

/** opencode's models.dev cache: `$XDG_CACHE_HOME/opencode/models.json`. */
export function opencodeCatalogCachePath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache')
  return path.join(cacheHome, 'opencode', 'models.json')
}

/** Roadie's own cache, written when the opencode cache is missing. */
export function fallbackCatalogCachePath({ dataDir }: { dataDir: string }): string {
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
      ...(typeof record.npm === 'string' && { npm: record.npm }),
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
  writeCatalogCache({ filePath: fallbackCatalogCachePath({ dataDir }), catalog })
  return catalog
}

// Memoized per process so concurrent doGenerate/doStream calls share one load
// and the fetch runs at most once. A failed load clears the memo so a later
// request can retry (e.g. after the network comes back).
let catalogLoad: Promise<ModelsDevCatalog | Error> | null = null

/** Test hook: drop the memoized catalog so the next resolve starts over. */
export function resetCatalogCacheForTests(): void {
  catalogLoad = null
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
      const opencodeCache = readCatalogFile(opencodeCatalogCachePath())
      if (!(opencodeCache instanceof Error)) return opencodeCache
      const ownCache = readCatalogFile(fallbackCatalogCachePath({ dataDir }))
      if (!(ownCache instanceof Error)) return ownCache
      const fetched = await fetchCatalog({ dataDir, fetchImpl })
      if (fetched instanceof Error) catalogLoad = null
      return fetched
    })()
  }
  return catalogLoad
}

// ── Validation (credentials add-key) ─────────────────────────────

/**
 * True when an api-key account for the provider can be routed without a
 * `baseURL` override: the catalog resolves it to a bundled SDK or an
 * OpenAI-compatible `api` URL.
 */
export function isCatalogProviderRoutable(catalog: ModelsDevCatalog, provider: string): boolean {
  const entry = catalog[provider]
  if (!entry) return false
  if (entry.api) return true
  return Boolean(entry.npm && BUNDLED_PROVIDER_FACTORIES[entry.npm])
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

// ── Client building ──────────────────────────────────────────────

/**
 * Language-model factory for one API-key candidate. Resolution order:
 * bundled catalog `npm` SDK, else openai-compatible against the catalog
 * `api` URL, else openai-compatible against `baseURLOverride`, else an
 * unsupported error. `baseURLOverride` (the account's `baseURL`) wins over
 * the catalog; the npm SDK always wins over the openai-compatible fallback.
 */
export function resolveCandidateModelFactory({
  catalog,
  provider,
  apiKey,
  baseURL: baseURLOverride,
  fetchImpl,
}: {
  catalog: ModelsDevCatalog
  provider: string
  apiKey: string
  /** Account-level base URL; wins over the catalog `api` URL. */
  baseURL?: string
  fetchImpl?: CatalogFetch
}): CandidateModelFactory | Error {
  const entry = catalog[provider]
  // The account's baseURL wins over the catalog `api` URL; the resolved URL
  // also flows into the bundled SDKs (each accepts baseURL, undefined keeps
  // its default endpoint).
  const baseURL = baseURLOverride ?? entry?.api
  const settings: BundledProviderSettings = {
    apiKey,
    ...(baseURL && { baseURL }),
    ...(fetchImpl && { fetch: fetchImpl }),
  }
  const bundled = entry?.npm ? BUNDLED_PROVIDER_FACTORIES[entry.npm] : undefined
  if (bundled) {
    const provider_ = bundled(settings)
    return (modelId) => provider_.languageModel(modelId)
  }
  if (baseURL) {
    const provider_ = createOpenAICompatible({ name: provider, baseURL, ...settings })
    return (modelId) => provider_.languageModel(modelId)
  }
  if (!entry) {
    return new Error(
      `provider ${provider} is not in the models.dev catalog and has no base URL; ` +
        'add the account with a --base-url to route it as OpenAI-compatible',
    )
  }
  return new Error(
    entry.npm && !BUNDLED_PROVIDER_FACTORIES[entry.npm]
      ? `provider ${provider} needs the ${entry.npm} package, which roadie does not bundle, and the catalog has no base URL for it`
      : `provider ${provider} has no base URL in the models.dev catalog; add the account with a --base-url to route it as OpenAI-compatible`,
  )
}
