// Host identity hook: map a chat actor to a person and their permissions.
//
// Roadie knows *who spoke* (an actor authenticated by the chat platform). It
// does not know who that is in the host's world. An optional host-supplied
// command answers that question, so a host (e.g. one that maps Discord users
// to accounts in its own system) can decide per person what they may do,
// without Roadie learning anything host-specific.
//
// Configure with ROADIE_IDENTITY_HOOK (or --identity-hook): a command run
// through the shell. It receives one JSON object on stdin and must print one
// JSON object on stdout.
//
//   stdin  { "version": 1, "actor": { "platform": "discord", "id": "…", "name": "…" },
//            "context": { "guild_id": "…", "channel_id": "…" } }
//   stdout { "allowed": true,
//            "person_id": "opaque-host-id",            // optional
//            "capabilities": ["sessions", "shell", "admin"],
//            "agent": "…", "model": "…",                // optional overrides
//            "permissions": ["bash:deny", …],           // optional session rules
//            "mcp_servers": [{ "name": "extrachill",     // optional per-person MCP servers
//                              "url": "https://…/mcp",    // https (http only for loopback)
//                              "credential": "extrachill" }], // optional token reference
//            "ttl_seconds": 300 }                       // optional cache TTL
//
// Capabilities:
//   sessions  start and continue sessions (default when allowed)
//   shell     run raw shell commands (`!cmd`, /run-shell-command)
//   admin     admin-only commands (credentials, server restart, …)
//
// No hook configured → resolvePerson returns null and callers keep Roadie's
// built-in role checks unchanged. A configured hook that fails, times out or
// returns invalid output denies access (fail closed) and logs why.

import { applyFiltersAsync, hasFilter } from './hooks.js'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { getRoadieEnv } from './config.js'
import { createLogger, LogPrefix } from './logger.js'
import { isValidPoolId } from './credentials/store.js'
import { MCP_NAME_PATTERN, isAllowedMcpUrl } from './credentials/person-mcp-store.js'

const logger = createLogger(LogPrefix.DISCORD)

export const IDENTITY_HOOK_VERSION = 1
const DEFAULT_TTL_SECONDS = 300
const MAX_TTL_SECONDS = 3600
const HOOK_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 64 * 1024

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
  // puts a team on one pool or pins a guest to `shared`. Optional; hooks that
  // do not send it behave as before. Invalid pool ids are ignored.
  credentialPool?: string
  // Per-person MCP servers (identity hook `mcp_servers`). Empty or absent
  // means the person gets no extra MCP servers.
  mcpServers?: PersonMcpServer[]
}

const hookOutputSchema = z.object({
  allowed: z.boolean(),
  person_id: z.string().min(1).max(200).optional(),
  capabilities: z.array(z.enum(['sessions', 'shell', 'admin'])).optional(),
  agent: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  permissions: z.array(z.string().min(1).max(500)).max(100).optional(),
  credential_pool: z.string().min(1).max(200).optional(),
  mcp_servers: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().max(2000),
        credential: z.string().optional(),
      }),
    )
    .max(20)
    .optional(),
  ttl_seconds: z.number().int().min(0).max(MAX_TTL_SECONDS).optional(),
})

const DENIED: Person = Object.freeze({
  allowed: false,
  capabilities: new Set<Capability>(),
  permissions: [],
})

type CacheEntry = { person: Person; expiresAt: number }

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<Person>>()

let hookCommandOverride: string | null | undefined

/** Set or clear the hook command (CLI flag, tests). `undefined` = use env. */
export function setIdentityHookCommand(command: string | null | undefined) {
  hookCommandOverride = command
  cache.clear()
  inflight.clear()
}

export function getIdentityHookCommand(): string | undefined {
  if (hookCommandOverride !== undefined) return hookCommandOverride ?? undefined
  const fromEnv = getRoadieEnv('ROADIE_IDENTITY_HOOK')?.trim()
  return fromEnv || undefined
}

/** True when an identity hook command or a `person` filter is in place. */
export function isIdentityHookConfigured(): boolean {
  return Boolean(getIdentityHookCommand()) || hasFilter('person')
}

function cacheKey(actor: IdentityActor): string {
  return `${actor.platform}:${actor.id}`
}

/** Drop cached people (all, or one actor). */
export function clearIdentityCache(actor?: IdentityActor) {
  if (actor) {
    cache.delete(cacheKey(actor))
    return
  }
  cache.clear()
}

/**
 * Cached person for an actor, without running the hook. Used by synchronous
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
 * Resolve the person behind an actor. Returns null when no hook is
 * configured, so callers fall back to built-in checks.
 */
export async function resolvePerson({
  actor,
  context = {},
}: {
  actor: IdentityActor
  context?: IdentityContext
}): Promise<Person | null> {
  const command = getIdentityHookCommand()
  if (!command && !hasFilter('person')) return null

  const cached = getCachedPerson(actor)
  if (cached) return cached

  const key = cacheKey(actor)
  const pending = inflight.get(key)
  if (pending) return pending

  const base = command
    ? runHook({ command, actor, context })
    : Promise.resolve({ person: null as Person | null, ttlSeconds: DEFAULT_TTL_SECONDS })
  const promise = base
    .then(async ({ person, ttlSeconds }) => {
      // Plugins refine or supply the person. With an identity layer in place,
      // an actor nobody vouches for is denied (fail closed).
      const filtered = (await applyFiltersAsync('person', person, { actor, context })) ?? DENIED
      if (ttlSeconds > 0) {
        cache.set(key, { person: filtered, expiresAt: Date.now() + ttlSeconds * 1000 })
      }
      return filtered
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, promise)
  return promise
}

export function personHas(person: Person, capability: Capability): boolean {
  return person.allowed && person.capabilities.has(capability)
}

async function runHook({
  command,
  actor,
  context,
}: {
  command: string
  actor: IdentityActor
  context: IdentityContext
}): Promise<{ person: Person; ttlSeconds: number }> {
  const input = JSON.stringify({
    version: IDENTITY_HOOK_VERSION,
    actor: { platform: actor.platform, id: actor.id, ...(actor.name ? { name: actor.name } : {}) },
    context: {
      ...(context.guildId ? { guild_id: context.guildId } : {}),
      ...(context.channelId ? { channel_id: context.channelId } : {}),
    },
  })

  const raw = await execHook({ command, input }).catch((e: unknown) => {
    return e instanceof Error ? e : new Error(String(e))
  })
  if (raw instanceof Error) {
    logger.warn(`[IDENTITY] hook failed for ${actor.platform}:${actor.id}, denying: ${raw.message}`)
    // Short TTL so a broken hook doesn't spawn a process per message.
    return { person: DENIED, ttlSeconds: 10 }
  }

  const parsed = (() => {
    try {
      return hookOutputSchema.safeParse(JSON.parse(raw))
    } catch (e) {
      return { success: false as const, error: e }
    }
  })()
  if (!parsed.success) {
    logger.warn(`[IDENTITY] hook returned invalid output for ${actor.platform}:${actor.id}, denying`)
    return { person: DENIED, ttlSeconds: 10 }
  }

  const out = parsed.data
  const capabilities = new Set<Capability>(
    out.allowed ? (out.capabilities ?? ['sessions']) : [],
  )
  const credentialPool = out.credential_pool && isValidPoolId(out.credential_pool)
    ? out.credential_pool
    : undefined
  // A denied person never gets MCP servers. Invalid or duplicate entries are
  // dropped individually (and logged), not the whole person.
  const mcpServers = out.allowed ? parseMcpServers(out.mcp_servers) : []
  const person: Person = {
    allowed: out.allowed,
    ...(out.person_id ? { personId: out.person_id } : {}),
    capabilities,
    ...(out.agent ? { agent: out.agent } : {}),
    ...(out.model ? { model: out.model } : {}),
    permissions: out.permissions ?? [],
    ...(credentialPool ? { credentialPool } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  }
  return { person, ttlSeconds: out.ttl_seconds ?? DEFAULT_TTL_SECONDS }
}

function parseMcpServers(
  raw: Array<{ name: string; url: string; credential?: string }> | undefined,
): PersonMcpServer[] {
  const servers: PersonMcpServer[] = []
  for (const entry of raw ?? []) {
    const credential = entry.credential ?? entry.name
    if (!MCP_NAME_PATTERN.test(entry.name) || !MCP_NAME_PATTERN.test(credential)) {
      logger.warn('[IDENTITY] ignoring mcp_servers entry with an invalid name or credential reference')
      continue
    }
    if (!isAllowedMcpUrl(entry.url)) {
      logger.warn(`[IDENTITY] ignoring mcp_servers entry ${entry.name}: url must be https (http only for loopback)`)
      continue
    }
    if (servers.some((server) => server.name === entry.name)) continue
    servers.push({ name: entry.name, url: entry.url, credential })
  }
  return servers
}

function execHook({ command, input }: { command: string; input: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`timed out after ${HOOK_TIMEOUT_MS}ms`)))
    }, HOOK_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish(() => reject(new Error('output too large')))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString('utf8')
    })
    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(`exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`))
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
