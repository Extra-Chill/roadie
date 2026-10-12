// Start the credential-pool proxy for Pi channels and prepare Pi's agent dir.

import path from 'node:path'
import { getDataDir } from '../../config.js'
import { startMessagesProxy } from '../../credentials/messages-proxy.js'
import { clearSessionRoute } from '../../credentials/routes.js'
import { resolveSessionPoolHeader } from '../../credentials/session-pools.js'
import { anthropicRotations, writePiPoolAgentDir } from './pool.js'

export async function startPiPool(): Promise<Error | {
  agentDir: string
  issueKey(sessionId: () => string | undefined): string
  revokeKey(key: string): void
  endTurn(sessionId: string): void
}> {
  const dataDir = getDataDir()
  const rotations = anthropicRotations({ dataDir })
  if (rotations.length === 0) return new Error('the shared pool has no rotation with an anthropic model')
  const proxy = await startMessagesProxy({ dataDir, resolvePools: (sessionId) => resolveSessionPoolHeader({ sessionId }) })
    .catch((cause: unknown) => new Error('pool proxy failed to start', { cause }))
  if (proxy instanceof Error) return proxy
  const agentDir = process.env['ROADIE_PI_AGENT_DIR'] || path.join(dataDir, 'pi-agent')
  writePiPoolAgentDir({ agentDir, baseUrl: proxy.baseUrl, rotations })
  return {
    agentDir,
    issueKey: (sessionId) => proxy.issueKey(sessionId),
    revokeKey: (key) => proxy.revokeKey(key),
    endTurn: (sessionId) => {
      void clearSessionRoute({ dataDir, sessionId }).catch(() => {})
    },
  }
}
