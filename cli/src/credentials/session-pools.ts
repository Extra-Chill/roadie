// The credential pool list a session bills to, as the ordered value of the
// x-roadie-pool header. Shared by every agent backend: the OpenCode plugin
// (../credential-pools-plugin.ts) and the Pi messages proxy (./messages-proxy.ts).

import {
  CREDENTIALS_MODE_ENV,
  THREAD_BILLING_ENV,
  parseCredentialsMode,
  parseThreadBilling,
  resolveBilledPoolList,
  type ThreadBilling,
} from './person-pool.js'
import { SHARED_POOL_ID } from './store.js'
import { getSessionCredentialOwner, getSessionTurnAttribution } from '../database.js'

/**
 * The pool the billed person bills to; null when there is no billed person
 * (no owner row / no actor), which the caller maps to `shared`; an Error when
 * the lookup itself failed, which the caller must not treat as "no person".
 */
export async function resolveBilledPoolId({
  sessionId,
  billing,
}: {
  sessionId: string
  billing: ThreadBilling
}): Promise<string | null | Error> {
  try {
    if (billing === 'speaker') {
      const attribution = await getSessionTurnAttribution(sessionId)
      return attribution?.credentialPool ?? null
    }
    const owner = await getSessionCredentialOwner(sessionId)
    return owner?.poolId ?? null
  } catch (cause) {
    return new Error(`credential pool lookup failed for session ${sessionId}`, { cause })
  }
}

/** Comma-separated pool list for a session. An Error means fail closed: send no pool. */
export async function resolveSessionPoolHeader({ sessionId, env = process.env }: { sessionId: string; env?: NodeJS.ProcessEnv }): Promise<string | Error> {
  const mode = parseCredentialsMode(env[CREDENTIALS_MODE_ENV])
  if (mode === 'global') return SHARED_POOL_ID
  const billedPoolId = await resolveBilledPoolId({ sessionId, billing: parseThreadBilling(env[THREAD_BILLING_ENV]) })
  if (billedPoolId instanceof Error) return billedPoolId
  return resolveBilledPoolList({ mode, billedPoolId }).join(',')
}
