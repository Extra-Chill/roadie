// MCP servers for Pi sessions (#51). Pi 1.x speaks MCP itself (built-in `mcp`
// extension); Roadie only decides which servers a session gets:
// - the project's OpenCode-style `opencode.json` `mcp` entries, converted;
// - servers added through the backend (per-person servers, ../../person-mcp.ts).
// Roadie writes them to a private per-process file (ROADIE_PI_MCP_FILE, 0600:
// headers carry tokens); ./roadie-extension.ts registers them with direct
// exposure, so tools reach the model like OpenCode's MCP tools.

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

type OpenCodeMcp =
  | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled?: boolean }
  | { type: 'remote'; url: string; headers?: Record<string, string>; enabled?: boolean }

/** Convert OpenCode `mcp` config entries (per Pi's migration notes). `{env:NAME}` becomes `${NAME}`. */
export function fromOpenCodeMcp(mcp: Record<string, OpenCodeMcp>): Record<string, PiMcpServer> {
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
      const config = JSON.parse(text) as { mcp?: Record<string, OpenCodeMcp> }
      return config.mcp ? fromOpenCodeMcp(config.mcp) : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** OpenCode's tool name for an MCP tool Pi calls `mcp__<server>__<tool>`, so permission rules match. */
export function openCodeToolName(piTool: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(piTool)
  return match ? `${match[1]}_${match[2]}` : piTool
}

export function writeMcpFile(file: string, servers: Record<string, PiMcpServer>): void {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(servers), { mode: 0o600 })
  fs.renameSync(temp, file)
}
