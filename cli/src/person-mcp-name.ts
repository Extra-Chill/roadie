// Naming for person-scoped MCP servers and their tools. Dependency-free so the
// Pi extension, the permission gate and the Discord formatter share one source.
//
//   server: <scope>_<name>               scope = `rpm_<first 12 hex of sha256(person key)>`
//   tool:   mcp__<scope>_<name>__<tool>  (Pi's MCP tool naming)
//
// Provider tool names are capped at 64 chars of [A-Za-z0-9_-]. The scope is
// kept short (16 chars) so typical server + tool names fit without truncation.

import crypto from 'node:crypto'

export const PERSON_MCP_PREFIX = 'rpm_'
const SCOPE_HASH_LENGTH = 12
/** Permission (tool name) glob covering every person-scoped MCP tool. */
export const PERSON_MCP_TOOL_GLOB = `${PERSON_MCP_PREFIX}*`
/** Provider tool-name length limit. */
export const MAX_TOOL_NAME_LENGTH = 64

const SCOPE_PATTERN = new RegExp(`^${PERSON_MCP_PREFIX}[0-9a-f]{${SCOPE_HASH_LENGTH}}_`)

/** Scope prefix unique to a person key. Fixed length, so no scope prefixes another. */
export function personMcpScope(personKey: string): string {
  const hash = crypto.createHash('sha256').update(personKey).digest('hex').slice(0, SCOPE_HASH_LENGTH)
  return `${PERSON_MCP_PREFIX}${hash}`
}

export function personMcpServerName({ personKey, name }: { personKey: string; name: string }): string {
  return `${personMcpScope(personKey)}_${name}`
}

/** True for a server name created for a person (hide it from shared listings). */
export function isPersonMcpServerName(name: string): boolean {
  return name.startsWith(PERSON_MCP_PREFIX)
}

/** The server name a person sees, without the per-person scope. */
export function displayServerName(server: string): string {
  return server.replace(SCOPE_PATTERN, '') || server
}

/**
 * Pi's tool name for an MCP tool: `mcp__<server>__<tool>`, non-alphanumerics
 * folded to `_`, shortened with an 8-hex hash suffix past the provider limit
 * (the same rule as Pi's built-in client).
 */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name
  const hash = crypto.createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8)
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`
}

/**
 * Human label for a tool name: `mcp__<scope>_<server>__<tool>` becomes
 * `<server> › <tool>`; anything else is returned unchanged.
 */
export function mcpToolLabel(tool: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!match) return tool
  const server = displayServerName(match[1]!)
  const name = match[2]!
  // A tool named after its server (`extrachill` › `extrachill_ability_search`) reads as noise.
  const prefix = `${server}_`
  const short = name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name
  return `${server} › ${short.replace(/_/g, '-')}`
}
