// Start the credential-pool proxy for Pi sessions and prepare Pi's agent dir.

import path from 'node:path'
import { getDataDir } from '../../config.js'
import { poolCatalog, startMessagesProxy } from '../../credentials/messages-proxy.js'
import { clearSessionRoute } from '../../credentials/routes.js'
import { resolveSessionPoolHeader } from '../../credentials/session-pools.js'
import { fetchRemotePoolCatalog, readRemotePoolConfig, startRemotePoolRelay } from '../../credentials/remote-pool.js'
import { SHARED_POOL_ID } from '../../credentials/store.js'
import { writePiPoolAgentDir } from './pool.js'

/** Fixed listen address for external pool clients (#171); ephemeral when unset. */
export function piPoolListenOptions(env: NodeJS.ProcessEnv = process.env): { host?: string; port?: number } | Error {
  const rawPort = env['ROADIE_POOL_PROXY_PORT']?.trim()
  const host = env['ROADIE_POOL_PROXY_HOST']?.trim() || undefined
  if (!rawPort) return { host }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return new Error(`ROADIE_POOL_PROXY_PORT must be a port number, got "${rawPort}"`)
  return { host, port }
}

export async function startPiPool(): Promise<Error | {
  agentDir: string
  baseUrl: string
  issueKey(sessionId: () => string | undefined): string
  revokeKey(key: string): void
  endTurn(sessionId: string): void
}> {
  const dataDir = getDataDir()
  const agentDir = process.env['ROADIE_PI_AGENT_DIR'] || path.join(dataDir, 'pi-agent')
  // A remote pool (#226): this bot holds no accounts; a relay forwards Pi
  // requests to the pool host under the bot's client key.
  const remote = readRemotePoolConfig()
  if (remote instanceof Error) return remote
  if (remote) {
    const catalog = await fetchRemotePoolCatalog({ config: remote })
    if (catalog instanceof Error) return catalog
    if (Object.keys(catalog.rotations).length === 0) return new Error(`the pool host ${remote.url} serves this client no rotation`)
    const relay = await startRemotePoolRelay({ config: remote }).catch((cause: unknown) => new Error('remote pool relay failed to start', { cause }))
    if (relay instanceof Error) return relay
    writePiPoolAgentDir({ agentDir, baseUrl: relay.baseUrl, ...catalog })
    return {
      baseUrl: relay.baseUrl,
      agentDir,
      issueKey: (sessionId) => relay.issueKey(sessionId),
      revokeKey: (key) => relay.revokeKey(key),
      endTurn: (sessionId) => {
        void relay.endTurn(sessionId)
      },
    }
  }
  const catalog = poolCatalog({ dataDir, poolIds: [SHARED_POOL_ID] })
  if (Object.keys(catalog.rotations).length === 0) return new Error('the shared pool has no rotation')
  const listen = piPoolListenOptions()
  if (listen instanceof Error) return listen
  const proxy = await startMessagesProxy({ dataDir, ...listen, resolvePools: (sessionId) => resolveSessionPoolHeader({ sessionId }) })
    .catch((cause: unknown) => new Error('pool proxy failed to start', { cause }))
  if (proxy instanceof Error) return proxy
  writePiPoolAgentDir({ agentDir, baseUrl: proxy.baseUrl, ...catalog })
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
