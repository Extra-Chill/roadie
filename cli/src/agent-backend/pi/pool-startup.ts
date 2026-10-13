// Start the credential-pool proxy for Pi channels and prepare Pi's agent dir.

import path from 'node:path'
import { getDataDir } from '../../config.js'
import { startMessagesProxy } from '../../credentials/messages-proxy.js'
import { clearSessionRoute } from '../../credentials/routes.js'
import { resolveSessionPoolHeader } from '../../credentials/session-pools.js'
import { readPoolClients } from '../../credentials/pool-clients.js'
import { DEFAULT_CODEX_MODELS, anthropicRotations, hasCodexAccounts, openaiCompatRotations, writePiPoolAgentDir } from './pool.js'

/** Fixed listen address for external pool clients (#171); ephemeral when unset. */
export function piPoolListenOptions(env: NodeJS.ProcessEnv = process.env): { host?: string; port?: number } | Error {
  const rawPort = env['ROADIE_POOL_PROXY_PORT']?.trim()
  const host = env['ROADIE_POOL_PROXY_HOST']?.trim() || undefined
  if (!rawPort) return { host }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return new Error(`ROADIE_POOL_PROXY_PORT must be a port number, got "${rawPort}"`)
  return { host, port }
}

/** Start the proxy for Pi channels, or whenever external pool clients are registered. */
export function shouldStartPiPool({ dataDir, env = process.env }: { dataDir: string; env?: NodeJS.ProcessEnv }): boolean {
  if (env['ROADIE_PI_CHANNELS']) return true
  const clients = readPoolClients(dataDir)
  return !(clients instanceof Error) && clients.length > 0
}

export async function startPiPool(): Promise<Error | {
  agentDir: string
  baseUrl: string
  issueKey(sessionId: () => string | undefined): string
  revokeKey(key: string): void
  endTurn(sessionId: string): void
}> {
  const dataDir = getDataDir()
  const rotations = anthropicRotations({ dataDir })
  const openaiRotations = openaiCompatRotations({ dataDir })
  const codexModels = hasCodexAccounts({ dataDir }) ? (process.env['ROADIE_PI_CODEX_MODELS']?.split(',').map((m) => m.trim()).filter(Boolean) ?? DEFAULT_CODEX_MODELS) : []
  if (rotations.length === 0 && openaiRotations.length === 0 && codexModels.length === 0) return new Error('the shared pool has no ChatGPT account and no pool rotation')
  const listen = piPoolListenOptions()
  if (listen instanceof Error) return listen
  const proxy = await startMessagesProxy({ dataDir, ...listen, resolvePools: (sessionId) => resolveSessionPoolHeader({ sessionId }) })
    .catch((cause: unknown) => new Error('pool proxy failed to start', { cause }))
  if (proxy instanceof Error) return proxy
  const agentDir = process.env['ROADIE_PI_AGENT_DIR'] || path.join(dataDir, 'pi-agent')
  writePiPoolAgentDir({ agentDir, baseUrl: proxy.baseUrl, rotations, openaiRotations, codexModels })
  return {
    baseUrl: proxy.baseUrl,
    agentDir,
    issueKey: (sessionId) => proxy.issueKey(sessionId),
    revokeKey: (key) => proxy.revokeKey(key),
    endTurn: (sessionId) => {
      void clearSessionRoute({ dataDir, sessionId }).catch(() => {})
    },
  }
}
