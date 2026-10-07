// Credential pools plugin: tags every LLM request with the credential pool(s)
// to bill. The provider module (cli/src/credentials/provider.ts) reads the tag
// in its fetch, resolves each pool's rotation to an account, and strips these
// headers before anything reaches upstream.
//
// Phase 1a is global mode only: every session tags the `shared` pool. Phase 2a
// adds per-person routing (opt-in): `--credentials` picks the mode and
// `--thread-billing` picks who pays a thread (the session owner or the current
// speaker). The mode and billing reach this plugin as ROADIE_CREDENTIALS /
// ROADIE_THREAD_BILLING env vars set by opencode.ts on the server process;
// config.ts state is not available there. The plugin is opt-in and inert
// unless ROADIE_CREDENTIAL_POOLS=1 is set by opencode.ts when the bot starts
// with --credential-pools.
//
// Global mode never touches the database: the header is `shared`, exactly as
// before. Per-person modes resolve the billed person's pool from
// credential_owners (owner billing) or session_actors.credential_pool
// (speaker billing). No owner/actor bills `shared` (scheduled tasks); a failed
// read sends no pool at all, which the provider rejects, so a database error
// can never silently bill the shared pool for someone's turn.

import type { Plugin } from '@opencode-ai/plugin'
import {
  CREDENTIALS_MODE_ENV,
  THREAD_BILLING_ENV,
  parseCredentialsMode,
  parseThreadBilling,
  resolveBilledPoolList,
  type ThreadBilling,
} from './credentials/person-pool.js'
import { SHARED_POOL_ID } from './credentials/store.js'
import { POOL_HEADER, ROADIE_PROVIDER_ID, SESSION_HEADER } from './credentials/provider.js'
import { getSessionCredentialOwner, getSessionTurnAttribution } from './database.js'

export const CREDENTIAL_POOLS_ENV = 'ROADIE_CREDENTIAL_POOLS'

/**
 * The pool the billed person bills to; null when there is no billed person
 * (no owner row / no actor), which the caller maps to `shared`; an Error when
 * the lookup itself failed, which the caller must not treat as "no person".
 */
async function resolveBilledPoolId({
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

export const credentialPoolsPlugin: Plugin = async () => {
  if (process.env[CREDENTIAL_POOLS_ENV] !== '1') {
    return {}
  }
  return {
    'chat.headers': async (input, output) => {
      // Only the roadie provider strips x-roadie-* before sending upstream.
      // Tagging any other provider's request would leak the session id and
      // pool name to that provider, so leave those requests untouched.
      if (input.model.providerID !== ROADIE_PROVIDER_ID) return
      const mode = parseCredentialsMode(process.env[CREDENTIALS_MODE_ENV])
      const billing = parseThreadBilling(process.env[THREAD_BILLING_ENV])
      if (mode === 'global') {
        output.headers[POOL_HEADER] = SHARED_POOL_ID
      } else {
        const billedPoolId = await resolveBilledPoolId({ sessionId: input.sessionID, billing })
        // Fail closed: without a pool header the provider rejects the request.
        if (!(billedPoolId instanceof Error)) {
          output.headers[POOL_HEADER] = resolveBilledPoolList({ mode, billedPoolId }).join(',')
        }
      }
      output.headers[SESSION_HEADER] = input.sessionID
    },
  }
}
