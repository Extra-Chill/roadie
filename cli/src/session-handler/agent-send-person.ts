// Agent sends inherit identity only from a verified session and bot-owned state.
// The agent API verifies the shell's token and issues a single-use nonce; only
// the nonce rides in the Discord marker, so no credential is ever posted.
import crypto from 'node:crypto'
import { getSessionTurnAttribution, getThreadIdBySessionId } from '../database.js'
import { getRuntime } from './runtime-registry.js'

export const AGENT_SEND_NONCE_ENV = 'ROADIE_AGENT_SEND_NONCE'
const NONCE_TTL_MS = 10 * 60_000
const nonces = new Map<string, { sessionId: string; expiresAt: number }>()

/** Bind a fresh single-use nonce to a session the caller has already verified. */
export function issueAgentSendNonce(sessionId: string): string {
  const now = Date.now()
  for (const [key, entry] of nonces) if (entry.expiresAt <= now) nonces.delete(key)
  const nonce = crypto.randomBytes(32).toString('hex')
  nonces.set(nonce, { sessionId, expiresAt: now + NONCE_TTL_MS })
  return nonce
}

/** Consume a nonce once and return the person its verified session runs for. */
export async function resolveAgentSendPerson(nonce: unknown): Promise<string | undefined> {
  if (typeof nonce !== 'string' || !nonce) return undefined
  const entry = nonces.get(nonce)
  nonces.delete(nonce)
  if (!entry || entry.expiresAt <= Date.now()) return undefined
  const threadId = await getThreadIdBySessionId(entry.sessionId)
  const runtime = threadId ? getRuntime(threadId) : undefined
  if (runtime?.state?.sessionId === entry.sessionId) {
    const owner = runtime.getPermissionOwner()
    if (owner) return owner
  }
  return (await getSessionTurnAttribution(entry.sessionId))?.personId
}
