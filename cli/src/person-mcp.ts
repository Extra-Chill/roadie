// Per-person MCP servers for agent sessions.
//
// The identity hook can name MCP servers for a person (`mcp_servers`). Each one
// is registered with the agent backend under a name scoped to that person, with
// that person's own OAuth access token in the request headers:
//
//   <scope>_<name>   where scope = `roadie_pm_<first 16 hex of sha256(person key)>`
//
// Isolation has two halves:
// - The OpenCode server config denies every `roadie_pm_*` tool by default
//   (PERSON_MCP_DENY_ALL), so sessions of people without MCP config, CLI
//   sessions and denied people see none of these servers.
// - Each chat turn appends session rules that reset to deny-all and then allow
//   only the speaker's own scope (personMcpPermissions). The last matching rule
//   wins, so a second speaker in someone else's thread cannot use the first
//   speaker's servers.
//
// Tokens come from the per-person store (credentials/person-mcp-store.ts), are
// only ever placed in headers handed to the backend, and are never logged.

import crypto from 'node:crypto'
import type { AgentBackend } from './agent-backend/types.js'
import { MCP_NAME_PATTERN, getPersonMcpAccessToken, isAllowedMcpUrl } from './credentials/person-mcp-store.js'
import type { PersonMcpServer } from './identity.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.MCP)

export const PERSON_MCP_PREFIX = 'roadie_pm_'
/** Permission (tool name) glob covering every person-scoped MCP tool. */
export const PERSON_MCP_TOOL_GLOB = `${PERSON_MCP_PREFIX}*`

/** Scope prefix unique to a person key. Fixed length, so no scope prefixes another. */
export function personMcpScope(personKey: string): string {
  const hash = crypto.createHash('sha256').update(personKey).digest('hex').slice(0, 16)
  return `${PERSON_MCP_PREFIX}${hash}`
}

export function personMcpServerName({ personKey, name }: { personKey: string; name: string }): string {
  return `${personMcpScope(personKey)}_${name}`
}

/** True for a server name created by this module (hide it from shared listings). */
export function isPersonMcpServerName(name: string): boolean {
  return name.startsWith(PERSON_MCP_PREFIX)
}

/**
 * Session permission rules for one speaker's turn: deny every person-scoped
 * MCP tool, then allow only this person's scope when they have servers.
 */
export function personMcpPermissions({
  personKey,
  hasServers,
}: {
  personKey?: string
  hasServers: boolean
}): string[] {
  const reset = `${PERSON_MCP_TOOL_GLOB}:deny`
  if (!personKey || !hasServers) return [reset]
  return [reset, `${personMcpScope(personKey)}_*:allow`]
}

// Per backend client: server name -> fingerprint of the headers it was
// registered with, so an unchanged token does not reconnect every turn. A
// restarted server gets a new backend object and so registers again.
const registered = new WeakMap<object, Map<string, string>>()

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Register a person's MCP servers with the backend, authenticated with that
 * person's own stored token. Servers whose token is missing or unusable are
 * skipped (and logged without the token), so the person simply has no tools
 * from them. Returns the names registered or already current.
 */
export async function registerPersonMcpServers({
  backend,
  directory,
  dataDir,
  personKey,
  servers,
}: {
  backend: AgentBackend
  directory: string
  dataDir: string
  personKey: string
  servers: readonly PersonMcpServer[]
}): Promise<string[]> {
  if (!backend.mcp || servers.length === 0) return []
  const known = registered.get(backend) ?? new Map<string, string>()
  registered.set(backend, known)
  const names: string[] = []
  for (const server of servers) {
    if (
      !MCP_NAME_PATTERN.test(server.name)
      || !MCP_NAME_PATTERN.test(server.credential)
      || !isAllowedMcpUrl(server.url)
    ) {
      logger.warn(`[PERSON-MCP] skipping invalid server config ${server.name}`)
      continue
    }
    const token = await getPersonMcpAccessToken({
      dataDir,
      personKey,
      credential: server.credential,
    })
    if (token === null) {
      logger.warn(`[PERSON-MCP] no stored credential ${server.credential} for server ${server.name}`)
      continue
    }
    if (token instanceof Error) {
      logger.warn(`[PERSON-MCP] credential ${server.credential} unusable for server ${server.name}: ${token.message}`)
      continue
    }
    const name = personMcpServerName({ personKey, name: server.name })
    const key = `${directory}\0${name}`
    const headers = { Authorization: `Bearer ${token}` }
    const current = fingerprint(`${server.url}\n${token}`)
    if (known.get(key) !== current) {
      const added = await backend.mcp.addRemote({ directory, name, url: server.url, headers })
      if (added instanceof Error) {
        logger.warn(`[PERSON-MCP] could not add server ${server.name}: ${added.message}`)
        continue
      }
      known.set(key, current)
    }
    names.push(name)
  }
  return names
}
