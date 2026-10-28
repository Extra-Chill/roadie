// Per-person MCP servers for agent sessions.
//
// The person filter can name MCP servers for a person (`mcpServers`). Each one
// is registered with the agent backend under a name scoped to that person, with
// that person's own OAuth access token in the request headers:
//
//   <scope>_<name>   where scope = `rpm_<first 12 hex of sha256(person key)>`
//   (naming lives in ./person-mcp-name.ts)
//
// Isolation has two halves:
// - The Pi permission gate denies every `rpm_*` tool by default
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
import { getCachedPerson, isIdentityConfigured, type PersonMcpServer } from './identity.js'
import { personKeyFrom } from './credentials/person-pool.js'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.MCP)
const sessionLogger = createLogger(LogPrefix.SESSION)

/** Connect an allowed chat speaker's own servers; registration is never fatal. */
export async function registerSpeakerMcpServers(
  client: AgentBackend,
  platform: string,
  directory: string,
  input: { userId?: string; actorVia?: 'chat' | 'cli'; personId?: string },
): Promise<void> {
  if (!isIdentityConfigured()) return
  if (!input.userId || (input.actorVia ?? 'chat') !== 'chat') return
  const actor = { platform, id: input.userId }
  const person = getCachedPerson(actor)
  if (!person?.allowed || !person.mcpServers?.length) return
  const personKey = personKeyFrom({ personId: person.personId, platform: actor.platform, actorId: actor.id })
  if (!personKey) return
  await registerPersonMcpServers({
    backend: client,
    directory,
    dataDir: getDataDir(),
    personKey,
    servers: person.mcpServers,
  }).catch((e: unknown) => sessionLogger.warn(`[PERSON-MCP] registration failed: ${String(e)}`))
}

import {
  PERSON_MCP_PREFIX,
  PERSON_MCP_TOOL_GLOB,
  isPersonMcpServerName,
  personMcpScope,
  personMcpServerName,
} from './person-mcp-name.js'

export { PERSON_MCP_PREFIX, PERSON_MCP_TOOL_GLOB, isPersonMcpServerName, personMcpScope, personMcpServerName }

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
/** Marker for a server this module disconnected because its token went away. */
const DISCONNECTED = ''

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
    const name = personMcpServerName({ personKey, name: server.name })
    const key = `${directory}\0${name}`
    if (token === null || token instanceof Error) {
      if (token === null) {
        logger.warn(`[PERSON-MCP] no stored credential ${server.credential} for server ${server.name}`)
      } else {
        logger.warn(`[PERSON-MCP] credential ${server.credential} unusable for server ${server.name}: ${token.message}`)
      }
      // A server registered earlier with a token that is now gone (the
      // person disconnected) must not keep running with the old headers.
      const previous = known.get(key)
      if (previous !== undefined && previous !== DISCONNECTED) {
        const disconnected = await backend.mcp.disconnect({ directory, name })
        if (disconnected instanceof Error) {
          logger.warn(`[PERSON-MCP] could not disconnect server ${server.name}: ${disconnected.message}`)
        } else {
          known.set(key, DISCONNECTED)
        }
      }
      continue
    }
    const headers = { Authorization: `Bearer ${token}` }
    const current = fingerprint(`${server.url}\n${token}`)
    const previous = known.get(key)
    if (previous !== current) {
      // `owner` records whose server this is, so MCP forms raised through it
      // can only be answered by this person (form-requests.ts).
      const added = await backend.mcp.addRemote({ directory, name, url: server.url, headers, owner: personKey })
      if (added instanceof Error) {
        logger.warn(`[PERSON-MCP] could not add server ${server.name}: ${added.message}`)
        continue
      }
      if (previous === DISCONNECTED) {
        // Re-enable a server this module disconnected before (reconnect).
        const connected = await backend.mcp.connect({ directory, name })
        if (connected instanceof Error) {
          logger.warn(`[PERSON-MCP] could not reconnect server ${server.name}: ${connected.message}`)
          continue
        }
      }
      known.set(key, current)
    }
    names.push(name)
  }
  return names
}
