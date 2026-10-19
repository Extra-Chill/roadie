// Identity: map a chat actor to a person and their permissions.
//
// Roadie knows *who spoke* (an actor authenticated by the chat platform). It
// does not know who that is in the host's world. A host plugin answers that
// question with the `person` filter, so a host (e.g. one that maps Discord
// users to accounts in its own system) can decide per person what they may do,
// without Roadie learning anything host-specific.
//
//   addFilter('person', async (person, { actor, context }) => ({
//     allowed: true,
//     personId: 'opaque-host-id',                 // optional
//     capabilities: new Set(['sessions', 'shell', 'admin']),
//     agent: '…', model: '…',                     // optional overrides
//     permissions: ['bash:deny'],                 // session rules
//     credentialPool: 'team-pool',                // optional pool override
//     mcpServers: [{ name: 'extrachill',          // optional per-person MCP servers
//                    url: 'https://…/mcp',        // https (http only for loopback)
//                    credential: 'extrachill' }], // token reference
//     ttlSeconds: 300,                            // optional cache TTL
//   }))
//
// The filter starts from null; returning null (nobody vouches for the actor)
// denies. `actor` is { platform, id, name? }; `context` is { guildId?, channelId? }.
//
// Caching: an answer is reused for ttlSeconds (default 300, max 3600). After
// that, an allowed person is still answered from the last lookup (up to an
// hour old) while a background lookup refreshes it, so a revocation takes
// effect at most ttlSeconds plus one interaction later. ttlSeconds 0 disables
// caching and gives immediate revocation. Denied actors always wait for a
// fresh lookup.
//
// Capabilities:
//   sessions  start and continue sessions
//   shell     run raw shell commands (`!cmd`, /run-shell-command)
//   admin     admin-only commands (credentials, server restart, …)
//
// No `person` filter → resolvePerson returns null and callers keep Roadie's
// built-in role checks unchanged. A filter that throws or returns
// `lookupFailed` denies access (fail closed) and logs why.

import { applyFiltersAsync, hasFilter } from './hooks.js'
import { createLogger, LogPrefix } from './logger.js'
import { isValidPoolId } from './credentials/store.js'
import { MCP_NAME_PATTERN, isAllowedMcpUrl } from './credentials/person-mcp-store.js'

const logger = createLogger(LogPrefix.DISCORD)

const DEFAULT_TTL_SECONDS = 300
const MAX_TTL_SECONDS = 3600

export type Capability = 'sessions' | 'shell' | 'admin'

export type IdentityActor = {
  platform: string
  id: string
  name?: string
}

export type IdentityContext = {
  guildId?: string
  channelId?: string
}

/**
 * One MCP server a person's sessions may use, authenticated as that person.
 * Carries a reference to the person's stored OAuth token, never the token.
 */
export type PersonMcpServer = {
  /** Short server name; tools surface as `<scope>_<name>_<tool>`. */
  name: string
  url: string
  /** Name of the person's stored credential (defaults to `name`). */
  credential: string
}

export type Person = {
  allowed: boolean
  personId?: string
  capabilities: ReadonlySet<Capability>
  agent?: string
  model?: string
  permissions: string[]
  // Credential pool override for this person (credential pools phase 2a):
  // puts a team on one pool or pins a guest to `shared`. Optional; invalid
  // pool ids are ignored.
  credentialPool?: string
  // Per-person MCP servers. Empty or absent means the person gets no extra
  // MCP servers; invalid entries are dropped, and denied people get none.
  mcpServers?: PersonMcpServer[]
  // The `person` filter failed, so nobody could vouch for the actor. Denied
  // like any unknown actor, but callers report the failure instead of a
  // permission denial.
  lookupFailed?: boolean
}

/**
 * Value of the `person` filter: a person plus how long Roadie may cache it
 * (seconds, default 300, max 3600; 0 disables caching). An MCP server's
 * `credential` defaults to its `name`.
 */
export type PersonLookup = Omit<Person, 'mcpServers'> & {
  mcpServers?: ReadonlyArray<{ name: string; url: string; credential?: string }>
  ttlSeconds?: number
}

const DENIED: Person = Object.freeze({
  allowed: false,
  capabilities: new Set<Capability>(),
  permissions: [],
})

const LOOKUP_FAILED: Person = Object.freeze({ ...DENIED, lookupFailed: true })

// Short TTL so a broken lookup doesn't spawn a process per message, while a
// transient failure clears quickly.
const FAILURE_TTL_SECONDS = 10

// How long the last successful lookup may stand in for a fresh one: answered
// while an expired entry is refreshed in the background (allowed people only),
// and used when the refresh fails, so a slow or flaky host lookup neither
// delays nor locks out a recently verified person. Revocations land on the
// next successful lookup.
const STALE_WINDOW_SECONDS = MAX_TTL_SECONDS

type CacheEntry = { person: Person; expiresAt: number }

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<Person>>()
const lastKnown = new Map<string, { person: Person; resolvedAt: number }>()
// Bumped when one actor's entry is dropped, so a lookup that was already in
// flight cannot write its (now outdated) answer back into the cache.
const generations = new Map<string, number>()

/** True when a `person` filter supplies identity. */
export function isIdentityConfigured(): boolean {
  return hasFilter('person')
}

function cacheKey(actor: IdentityActor): string {
  return `${actor.platform}:${actor.id}`
}

/**
 * Drop cached people (all, or one actor). For one actor this also forgets an
 * in-flight lookup, so the next resolvePerson asks the host again (used after
 * the host links the actor's identity).
 */
export function clearIdentityCache(actor?: IdentityActor) {
  if (actor) {
    cache.delete(cacheKey(actor))
    lastKnown.delete(cacheKey(actor))
    inflight.delete(cacheKey(actor))
    generations.set(cacheKey(actor), (generations.get(cacheKey(actor)) ?? 0) + 1)
    return
  }
  cache.clear()
  lastKnown.clear()
}

/**
 * Cached person for an actor, without running the lookup. Used by synchronous
 * permission checks after an entry point has called resolvePerson.
 */
export function getCachedPerson(actor: IdentityActor): Person | undefined {
  const entry = cache.get(cacheKey(actor))
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey(actor))
    return undefined
  }
  return entry.person
}

/**
 * Resolve the person behind an actor. Returns null when no `person` filter is
 * registered, so callers fall back to built-in checks.
 *
 * Stale-while-revalidate: once the cache entry expires, an actor last
 * resolved as allowed within the stale window is answered from that lookup at
 * once (held in the cache for the failure TTL so the synchronous checks see
 * it) while one deduplicated lookup refreshes it in the background. Denied,
 * never-resolved, uncached (ttlSeconds 0) and cleared actors wait.
 */
export async function resolvePerson({
  actor,
  context = {},
}: {
  actor: IdentityActor
  context?: IdentityContext
}): Promise<Person | null> {
  if (!isIdentityConfigured()) return null

  const cached = getCachedPerson(actor)
  if (cached) return cached

  const key = cacheKey(actor)
  const pending = inflight.get(key)
  const lookup = pending ?? startLookup({ key, actor, context })
  const known = lastKnown.get(key)
  const now = Date.now()
  if (!known?.person.allowed || now - known.resolvedAt > STALE_WINDOW_SECONDS * 1000) return lookup

  if (!pending) {
    lookup.catch((error: unknown) => {
      logger.warn(`[IDENTITY] background refresh failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  cache.set(key, { person: known.person, expiresAt: now + FAILURE_TTL_SECONDS * 1000 })
  return known.person
}

function startLookup({
  key,
  actor,
  context,
}: {
  key: string
  actor: IdentityActor
  context: IdentityContext
}): Promise<Person> {
  const generation = generations.get(key) ?? 0
  const promise = lookupPerson({ key, actor, context, generation }).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

async function lookupPerson({
  key,
  actor,
  context,
  generation,
}: {
  key: string
  actor: IdentityActor
  context: IdentityContext
  generation: number
}): Promise<Person> {
  // The filter supplies the person. An actor nobody vouches for is denied
  // (fail closed). A throwing filter leaves nobody vouching for the actor:
  // fall back to the last successful lookup, else deny as a lookup failure.
  // Either way only for the short failure TTL, so the next message retries.
  let failed = false
  const current = () => (generations.get(key) ?? 0) === generation
  const result = await applyFiltersAsync('person', null, { actor, context }, {
    onError: () => { failed = true },
  })
  // Leave `inflight` in the same step the answer is cached, so a call right
  // after the lookup settles cannot pick up its (possibly stale) promise. A
  // newer generation owns the entry instead.
  if (current()) inflight.delete(key)
  const now = Date.now()
  if (failed || result?.lookupFailed) {
    const known = lastKnown.get(key)
    const stale = known && now - known.resolvedAt <= STALE_WINDOW_SECONDS * 1000 ? known.person : undefined
    if (stale) logger.warn(`[IDENTITY] lookup failed for ${key}; using the last successful lookup`)
    const resolved = stale ?? LOOKUP_FAILED
    if (current()) cache.set(key, { person: resolved, expiresAt: now + FAILURE_TTL_SECONDS * 1000 })
    return resolved
  }
  const { person, ttlSeconds } = result ? normalizeLookup(result) : { person: DENIED, ttlSeconds: DEFAULT_TTL_SECONDS }
  // A lookup that disables caching (ttlSeconds 0) gets no stale answers.
  if (current()) {
    if (ttlSeconds > 0) {
      cache.set(key, { person, expiresAt: now + ttlSeconds * 1000 })
      lastKnown.set(key, { person, resolvedAt: now })
    } else {
      cache.delete(key)
      lastKnown.delete(key)
    }
  }
  return person
}

/** Reply for an actor whose identity lookup failed (not a permission denial). */
export const IDENTITY_LOOKUP_FAILED_MESSAGE =
  `Couldn't verify your account: the identity lookup failed. Try again in a moment.`

export function personHas(person: Person, capability: Capability): boolean {
  return person.allowed && person.capabilities.has(capability)
}

/**
 * Split a filter result into the cached person and its TTL. Drops an invalid
 * credential pool and invalid MCP servers (denied people get none) instead of
 * rejecting the whole person.
 */
function normalizeLookup(result: PersonLookup): { person: Person; ttlSeconds: number } {
  const { ttlSeconds: rawTtl, credentialPool, mcpServers: rawServers, ...rest } = result
  const ttlSeconds = typeof rawTtl === 'number' && Number.isFinite(rawTtl)
    ? Math.min(MAX_TTL_SECONDS, Math.max(0, Math.floor(rawTtl)))
    : DEFAULT_TTL_SECONDS
  if (credentialPool && !isValidPoolId(credentialPool)) {
    logger.warn('[IDENTITY] ignoring invalid credentialPool from the person filter')
  }
  const mcpServers = rest.allowed ? parseMcpServers(rawServers) : []
  const person: Person = {
    ...rest,
    ...(credentialPool && isValidPoolId(credentialPool) ? { credentialPool } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  }
  return { person, ttlSeconds }
}

function parseMcpServers(
  raw: ReadonlyArray<{ name: string; url: string; credential?: string }> | undefined,
): PersonMcpServer[] {
  const servers: PersonMcpServer[] = []
  for (const entry of raw ?? []) {
    const credential = entry.credential ?? entry.name
    if (!MCP_NAME_PATTERN.test(entry.name) || !MCP_NAME_PATTERN.test(credential)) {
      logger.warn('[IDENTITY] ignoring mcpServers entry with an invalid name or credential reference')
      continue
    }
    if (!isAllowedMcpUrl(entry.url)) {
      logger.warn(`[IDENTITY] ignoring mcpServers entry ${entry.name}: url must be https (http only for loopback)`)
      continue
    }
    if (servers.some((server) => server.name === entry.name)) continue
    servers.push({ name: entry.name, url: entry.url, credential })
  }
  return servers
}
