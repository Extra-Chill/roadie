// Credential pools plugin: tags every LLM request with the credential pool to
// bill. The provider module (cli/src/credentials/provider.ts) reads the tag in
// its fetch, resolves the pool's rotation to an account, and strips these
// headers before anything reaches upstream.
//
// Phase 1a is global mode only: every session tags the `shared` pool. The
// plugin is opt-in and inert unless ROADIE_CREDENTIAL_POOLS=1 is set by
// opencode.ts when the bot starts with --credential-pools.

import type { Plugin } from '@opencode-ai/plugin'
import { SHARED_POOL_ID } from './credentials/store.js'
import { POOL_HEADER, SESSION_HEADER } from './credentials/provider.js'

export const CREDENTIAL_POOLS_ENV = 'ROADIE_CREDENTIAL_POOLS'

export const credentialPoolsPlugin: Plugin = async () => {
  if (process.env[CREDENTIAL_POOLS_ENV] !== '1') {
    return {}
  }
  return {
    'chat.headers': async (input, output) => {
      output.headers[POOL_HEADER] = SHARED_POOL_ID
      output.headers[SESSION_HEADER] = input.sessionID
    },
  }
}
