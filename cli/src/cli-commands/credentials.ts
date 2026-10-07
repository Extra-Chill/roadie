// Terminal commands for managing credential pools.
// Phase 1a/1b operate on the shared pool only:
//   roadie credentials list
//   roadie credentials add-key --provider <anthropic|openai|...> [--label]
//   roadie credentials login anthropic [--label]
//   roadie credentials remove <id>
//   roadie credentials rotation set <name> <provider/model>...
//   roadie credentials import-subrouter [--dry-run] [--subrouter-home <dir>]
// API keys are read from stdin (never argv) and never printed; only the last
// 4 characters are shown. OAuth tokens are never printed; `list` shows the
// access token's expiry instead.
import { goke } from 'goke'
import fs from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { createLogger, LogPrefix } from '../logger.js'
import { getDataDir } from '../config.js'
import {
  addPoolAccount,
  addPoolOAuthAccount,
  readPoolAccounts,
  readPoolRotations,
  readPoolState,
  removePoolAccount,
  setPoolRotation,
  SHARED_POOL_ID,
  type PoolAccount,
} from '../credentials/store.js'
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePKCE,
  parseManualInput,
  ANTHROPIC_OAUTH_REDIRECT_URI,
} from '../credentials/adapters/anthropic-oauth.js'
import { EXIT_NO_RESTART } from '../cli-runner.js'
import {
  formatSubrouterImportReport,
  importSubrouterCredentials,
} from '../credentials/import-subrouter.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

/** Keys are never printed in full; `…last4` is enough to tell accounts apart. */
function maskKey(key: string): string {
  return `…${key.slice(-4)}`
}

/** One-line credential summary per account type. Never shows tokens. */
function describeAccountCredential(account: PoolAccount, now: number): string {
  if (account.type === 'oauth') {
    const expiresAt = new Date(account.expires).toISOString()
    return account.expires <= now ? `expires ${expiresAt} (expired)` : `expires ${expiresAt}`
  }
  return maskKey(account.key)
}

function exitWithError(message: string): never {
  cliLogger.error(message)
  process.exit(EXIT_NO_RESTART)
}

cli
  .command('credentials list', 'List the accounts and rotations in the shared credential pool')
  .action(async () => {
    const dataDir = getDataDir()
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) exitWithError(accounts.message)
    const state = readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    if (state instanceof Error) exitWithError(state.message)
    const rotations = readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })
    if (rotations instanceof Error) exitWithError(rotations.message)

    const now = Date.now()
    if (accounts.length === 0) {
      cliLogger.log(`Pool ${SHARED_POOL_ID} has no accounts`)
    } else {
      cliLogger.log(`Pool ${SHARED_POOL_ID} accounts:`)
      for (const account of accounts) {
        const cooldownUntil = state.cooldowns[account.id]
        const cooling =
          typeof cooldownUntil === 'number' && cooldownUntil > now
            ? ` | cooling ${Math.ceil((cooldownUntil - now) / 1000)}s`
            : ''
        const lastUsed = account.lastUsed ? ` | last used ${account.lastUsed}` : ''
        cliLogger.log(
          `${account.id} | ${account.provider} | ${account.type} | ${describeAccountCredential(account, now)}${account.label ? ` | ${account.label}` : ''} | added ${account.addedAt}${lastUsed}${cooling}`,
        )
      }
    }

    const rotationNames = Object.keys(rotations).sort()
    if (rotationNames.length === 0) {
      cliLogger.log(`Pool ${SHARED_POOL_ID} has no rotations`)
      process.exit(0)
    }
    cliLogger.log(`Pool ${SHARED_POOL_ID} rotations:`)
    for (const name of rotationNames) {
      cliLogger.log(`${name}: ${(rotations[name] ?? []).join(' ')}`)
    }
    process.exit(0)
  })

cli
  .command(
    'credentials add-key',
    'Add an API key account to the shared pool. The key is read from stdin: echo <key> | roadie credentials add-key --provider <provider>',
  )
  .option('--provider <provider>', 'Provider the key belongs to (anthropic, openai, openrouter, ...)')
  .option('--label <label>', 'Optional human-readable label for the account')
  .action(async (options) => {
    const provider = options.provider?.trim()
    if (!provider) {
      exitWithError('Provider is required. Use --provider <anthropic|openai|...>')
    }
    if (process.stdin.isTTY) {
      exitWithError('Pipe the API key on stdin: echo <key> | roadie credentials add-key --provider <provider>')
    }
    const key = (() => {
      try {
        return fs.readFileSync(0, 'utf8').trim()
      } catch (cause) {
        return new Error('Failed to read the API key from stdin', { cause })
      }
    })()
    if (key instanceof Error) exitWithError(key.message)
    if (!key) {
      exitWithError('No API key received on stdin')
    }

    const account = await addPoolAccount({
      dataDir: getDataDir(),
      poolId: SHARED_POOL_ID,
      provider,
      key,
      ...(options.label && { label: options.label }),
    })
    if (account instanceof Error) exitWithError(account.message)
    cliLogger.log(`Added ${account.provider} account ${account.id} (${maskKey(account.key)}) to pool ${SHARED_POOL_ID}`)
    process.exit(0)
  })

cli
  .command(
    'credentials login <provider>',
    'Log in an OAuth subscription account and add it to the shared pool. Only anthropic (Claude Pro/Max) is supported.',
  )
  .option('--label <label>', 'Optional human-readable label for the account')
  .action(async (provider, options) => {
    if (provider !== 'anthropic') {
      exitWithError(`Unsupported OAuth provider: ${provider}. Only anthropic is supported.`)
    }
    const dataDir = getDataDir()
    const pkce = await generatePKCE()
    if (pkce instanceof Error) exitWithError(pkce.message)
    // The browser redirects to localhost (nothing listens there); the code and
    // state stay visible in the address bar for pasting.
    const state = pkce.verifier
    const authorizeUrl = buildAuthorizeUrl({
      challenge: pkce.challenge,
      state,
      redirectUri: ANTHROPIC_OAUTH_REDIRECT_URI,
    })
    cliLogger.log('Open this URL in your browser and sign in with the account to add:')
    cliLogger.log(authorizeUrl)
    cliLogger.log('Then paste the code#state from the redirect (the full redirect URL also works):')
    const readline = createInterface({ input: process.stdin })
    const pasted = await readline.question('')
    readline.close()
    const { code, state: pastedState } = parseManualInput(pasted)
    if (!code.trim()) {
      exitWithError('No authorization code received')
    }
    const tokens = await exchangeAuthorizationCode({
      code,
      state: pastedState || state,
      verifier: pkce.verifier,
      redirectUri: ANTHROPIC_OAUTH_REDIRECT_URI,
    })
    if (tokens instanceof Error) exitWithError(tokens.message)
    const account = await addPoolOAuthAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      refresh: tokens.refresh,
      access: tokens.access,
      expires: tokens.expires,
      ...(options.label && { label: options.label }),
    })
    if (account instanceof Error) exitWithError(account.message)
    cliLogger.log(
      `Added anthropic oauth account ${account.id} (access expires ${new Date(tokens.expires).toISOString()}) to pool ${SHARED_POOL_ID}`,
    )
    process.exit(0)
  })

cli
  .command(
    'credentials import-subrouter',
    'Import subrouter accounts and presets into the shared credential pool. Read-only on subrouter files: they are never written, moved or deleted.',
  )
  .option('--dry-run', 'Print the import plan without writing anything')
  .option(
    '--subrouter-home <dir>',
    'Subrouter home directory (default: $SUBROUTER_HOME, then ~/.subrouter)',
  )
  .action(async (options) => {
    const result = await importSubrouterCredentials({
      dataDir: getDataDir(),
      ...(options.subrouterHome && { subrouterHome: options.subrouterHome }),
      dryRun: options.dryRun === true,
    })
    if (result instanceof Error) exitWithError(result.message)
    for (const line of formatSubrouterImportReport(result)) {
      cliLogger.log(line)
    }
    process.exit(0)
  })

cli
  .command('credentials remove <id>', 'Remove an account from the shared pool by id')
  .action(async (id: string) => {
    const removed = await removePoolAccount({
      dataDir: getDataDir(),
      poolId: SHARED_POOL_ID,
      accountId: id,
    })
    if (removed instanceof Error) exitWithError(removed.message)
    if (!removed) exitWithError(`Account ${id} not found in pool ${SHARED_POOL_ID}`)
    cliLogger.log(`Removed account ${id} from pool ${SHARED_POOL_ID}`)
    process.exit(0)
  })

cli
  .command(
    'credentials rotation set <name> [...models]',
    'Set (or replace) a named rotation in the shared pool as ordered provider/model entries. Empty list removes the rotation.',
  )
  .action(async (name: string, models: string[] | undefined) => {
    const result = await setPoolRotation({
      dataDir: getDataDir(),
      poolId: SHARED_POOL_ID,
      name,
      entries: models ?? [],
    })
    if (result instanceof Error) exitWithError(result.message)
    if ((models ?? []).length === 0) {
      cliLogger.log(`Removed rotation ${name} from pool ${SHARED_POOL_ID}`)
    } else {
      cliLogger.log(`Set rotation ${name} in pool ${SHARED_POOL_ID}: ${(models ?? []).join(' ')}`)
    }
    process.exit(0)
  })

export default cli
