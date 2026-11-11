// Agent sends inherit identity only from a verified session and bot-owned state.
import { ensureAgentTokenSecret, verifyAgentToken } from '../agent-token.js'
import { getSessionTurnAttribution, getThreadIdBySessionId } from '../database.js'
import { getRuntime } from './runtime-registry.js'

export async function resolveAgentSendPerson(token: unknown): Promise<string | undefined> {
  if (typeof token !== 'string' || !token) return undefined
  const verified = verifyAgentToken({ secret: ensureAgentTokenSecret(), token })
  if (!verified) return undefined
  const threadId = await getThreadIdBySessionId(verified.sessionId)
  const runtime = threadId ? getRuntime(threadId) : undefined
  if (runtime?.state?.sessionId === verified.sessionId) {
    const owner = runtime.getPermissionOwner()
    if (owner) return owner
  }
  return (await getSessionTurnAttribution(verified.sessionId))?.personId
}
