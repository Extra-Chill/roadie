// Terminal commands for managing credential pools.
// Phase 1a/1b operate on the shared pool by default; phase 2a adds --pool so
// per-person servers can manage other pools:
//   roadie credentials list [--pool <id>]
//   roadie credentials add-key --provider <anthropic|openai|...> [--label] [--pool <id>]
//   roadie credentials login anthropic [--label] [--pool <id>]
//   roadie credentials remove <id> [--pool <id>]
//   roadie credentials rotation set <name> <provider/model>... [--pool <id>]
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
  isValidPoolId,
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
import { resolveCatalog, validateCatalogProvider } from '../credentials/provider-catalog.js'

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

/** Resolve --pool (default `shared`), exiting when the id is malformed. */
function resolvePoolId(poolId: string | undefined): string {
  const value = poolId?.trim() || SHARED_POOL_ID
  if (!isValidPoolId(value)) {
    exitWithError(
      `Invalid pool id: ${value}. Use lowercase letters, digits, dots, dashes, colons or underscores (max 128 chars).`,
    )
  }
  return value
}

cli
  .command('credentials list', 'List the accounts and rotations in a credential pool (default: shared)')
  .option('--pool <id>', 'Pool to list (default: shared)')
  .action(async (options) => {
    const poolId = resolvePoolId(options.pool)
    const dataDir = getDataDir()
    const accounts = readPoolAccounts({ dataDir, poolId })
    if (accounts instanceof Error) exitWithError(accounts.message)
    const state = readPoolState({ dataDir, poolId })
    if (state instanceof Error) exitWithError(state.message)
    const rotations = readPoolRotations({ dataDir, poolId })
    if (rotations instanceof Error) exitWithError(rotations.message)

    const now = Date.now()
    if (accounts.length === 0) {
      cliLogger.log(`Pool ${poolId} has no accounts`)
    } else {
      cliLogger.log(`Pool ${poolId} accounts:`)
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
      cliLogger.log(`Pool ${poolId} has no rotations`)
      process.exit(0)
    }
    cliLogger.log(`Pool ${poolId} rotations:`)
    for (const name of rotationNames) {
      cliLogger.log(`${name}: ${(rotations[name] ?? []).join(' ')}`)
    }
    process.exit(0)
  })

cli
  .command(
    'credentials add-key',
    'Add an API key account to a credential pool (default: shared). The key is read from stdin: echo <key> | roadie credentials add-key --provider <provider>',
  )
  .option('--provider <provider>', 'Provider the key belongs to, as named in the models.dev catalog (anthropic, zai-coding-plan, groq, ...)')
  .option('--base-url <url>', 'Optional base URL override for custom or self-hosted endpoints (wins over the models.dev catalog)')
  .option('--label <label>', 'Optional human-readable label for the account')
  .option('--pool <id>', 'Pool to add the account to (default: shared)')
  .action(async (options) => {
    const poolId = resolvePoolId(options.pool)
    const provider = options.provider?.trim()
    if (!provider) {
      exitWithError('Provider is required. Use --provider <anthropic|zai-coding-plan|groq|...>')
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

    // Free text provider, checked against the models.dev catalog; an explicit
    // --base-url bypasses the check (custom endpoints are exactly the case the
    // catalog cannot know).
    if (!options.baseUrl) {
      const catalog = await resolveCatalog({ dataDir: getDataDir() })
      if (catalog instanceof Error) {
        cliLogger.warn(`[CLI] Could not load the models.dev catalog; skipping provider validation: ${catalog.message}`)
      } else {
        const invalid = validateCatalogProvider({ catalog, provider })
        if (invalid) exitWithError(invalid.message)
      }
    }

    const account = await addPoolAccount({
      dataDir: getDataDir(),
      poolId,
      provider,
      key,
      ...(options.baseUrl && { baseURL: options.baseUrl }),
      ...(options.label && { label: options.label }),
    })
    if (account instanceof Error) exitWithError(account.message)
    cliLogger.log(`Added ${account.provider} account ${account.id} (${maskKey(account.key)}) to pool ${poolId}`)
    process.exit(0)
  })

cli
  .command(
    'credentials login <provider>',
    'Log in an OAuth subscription account and add it to a credential pool (default: shared). Only anthropic (Claude Pro/Max) is supported.',
  )
  .option('--label <label>', 'Optional human-readable label for the account')
  .option('--pool <id>', 'Pool to add the account to (default: shared)')
  .action(async (provider: string, options) => {
    if (provider !== 'anthropic') {
      exitWithError(`Unsupported OAuth provider: ${provider}. Only anthropic is supported.`)
    }
    const poolId = resolvePoolId(options.pool)
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
      poolId,
      provider: 'anthropic',
      refresh: tokens.refresh,
      access: tokens.access,
      expires: tokens.expires,
      ...(options.label && { label: options.label }),
    })
    if (account instanceof Error) exitWithError(account.message)
    cliLogger.log(
      `Added anthropic oauth account ${account.id} (access expires ${new Date(tokens.expires).toISOString()}) to pool ${poolId}`,
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
  .command('credentials remove <id>', 'Remove an account from a credential pool (default: shared) by id')
  .option('--pool <id>', 'Pool to remove the account from (default: shared)')
  .action(async (id: string, options) => {
    const poolId = resolvePoolId(options.pool)
    const removed = await removePoolAccount({
      dataDir: getDataDir(),
      poolId,
      accountId: id,
    })
    if (removed instanceof Error) exitWithError(removed.message)
    if (!removed) exitWithError(`Account ${id} not found in pool ${poolId}`)
    cliLogger.log(`Removed account ${id} from pool ${poolId}`)
    process.exit(0)
  })

cli
  .command(
    'credentials rotation set <name> [...models]',
    'Set (or replace) a named rotation in a credential pool (default: shared) as ordered provider/model entries. Empty list removes the rotation.',
  )
  .option('--pool <id>', 'Pool to set the rotation in (default: shared)')
  .action(async (name: string, models: string[] | undefined, options) => {
    const poolId = resolvePoolId(options.pool)
    const result = await setPoolRotation({
      dataDir: getDataDir(),
      poolId,
      name,
      entries: models ?? [],
    })
    if (result instanceof Error) exitWithError(result.message)
    if ((models ?? []).length === 0) {
      cliLogger.log(`Removed rotation ${name} from pool ${poolId}`)
    } else {
      cliLogger.log(`Set rotation ${name} in pool ${poolId}: ${(models ?? []).join(' ')}`)
    }
    process.exit(0)
  })

export default cli
