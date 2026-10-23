// MCP servers for Pi sessions. Roadie converts OpenCode-format project config
// and per-person servers to Pi's built-in MCP extension with direct exposure.
// The private per-process file (ROADIE_PI_MCP_FILE, 0600) carries auth headers.

import fs from 'node:fs'
import path from 'node:path'

export type PiMcpServer = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  exposure: 'direct'
}

type ProjectMcpConfig =
  | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled?: boolean }
  | { type: 'remote'; url: string; headers?: Record<string, string>; enabled?: boolean }

/** Convert OpenCode-format project config: `{env:NAME}` becomes `${NAME}`. */
export function convertProjectMcpServers(mcp: Record<string, ProjectMcpConfig>): Record<string, PiMcpServer> {
  const env = (values: Record<string, string> | undefined) =>
    values && Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')]))
  const servers: Record<string, PiMcpServer> = {}
  for (const [name, entry] of Object.entries(mcp)) {
    if (entry.type === 'local' && Array.isArray(entry.command) && entry.command[0]) {
      const environment = env(entry.environment)
      servers[name] = { command: entry.command[0], args: entry.command.slice(1), ...(environment && { env: environment }), enabled: entry.enabled !== false, exposure: 'direct' }
    } else if (entry.type === 'remote' && entry.url) {
      const headers = env(entry.headers)
      servers[name] = { url: entry.url, ...(headers && { headers }), enabled: entry.enabled !== false, exposure: 'direct' }
    }
  }
  return servers
}

/** The project's `opencode.json` / `opencode.jsonc` MCP servers, or none. */
export function projectMcpServers(directory: string): Record<string, PiMcpServer> {
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(directory, name)
    if (!fs.existsSync(file)) continue
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')
      const config = JSON.parse(text) as { mcp?: Record<string, ProjectMcpConfig> }
      return config.mcp ? convertProjectMcpServers(config.mcp) : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Map Pi's `mcp__<server>__<tool>` to the name used by permission rules. */
export function permissionToolName(piTool: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(piTool)
  return match ? `${match[1]}_${match[2]}` : piTool
}

export function writeMcpFile(file: string, servers: Record<string, PiMcpServer>): void {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(servers), { mode: 0o600 })
  fs.renameSync(temp, file)
}
