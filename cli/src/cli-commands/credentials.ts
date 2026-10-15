// Terminal commands for managing credential pools.
// Phase 1a/1b operate on the shared pool by default; phase 2a adds --pool so
// per-person servers can manage other pools:
//   roadie credentials list [--pool <id>]
//   roadie credentials add-key --provider <anthropic|openai|...> [--label] [--pool <id>]
//   roadie credentials login <anthropic|openai-codex> [--label] [--pool <id>]
//   roadie credentials remove <id> [--pool <id>]
//   roadie credentials rotation set <name> <provider/model>... [--pool <id>]
//   roadie credentials import-subrouter [--dry-run] [--subrouter-home <dir>]
//   roadie credentials import-opencode --opencode-data <dir> [--pool <id>] [--dry-run]
//   roadie credentials mcp set --person <key> --credential <name>   (OAuth token JSON on stdin)
//   roadie credentials mcp list --person <key>
//   roadie credentials mcp remove --person <key> --credential <name>
//   roadie credentials client add <name> [--pools <id,id>] [--admin]   (prints the key once)
//   roadie credentials client list
//   roadie credentials client remove <name>
//   roadie credentials client pi-agent-dir <dir> --base-url <url> [--pools <id,id>]
//   roadie credentials serve [--host <addr>] [--port <n>]   (headless pool host, #226)
// list, add-key, login, remove, move (reorder) and rotation set go through
// the PoolAccounts seam: this host's pool, or the pool host's admin API when
// ROADIE_POOL_URL is set (#238). API keys are read from stdin (never argv); no
// key or token is ever printed. `list` shows an OAuth account's access expiry
// instead.
import { goke } from 'goke'
import fs from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { createLogger, LogPrefix } from '../logger.js'
import { getDataDir } from '../config.js'
import {
  isValidPoolId,
  SHARED_POOL_ID,
} from '../credentials/store.js'
import {
  isPoolOAuthProvider,
  resolvePoolAccounts,
  type PoolAccountView,
  type PoolAccounts,
} from '../credentials/pool-accounts.js'
import { EXIT_NO_RESTART } from '../cli-runner.js'
import { isAgentMode, runAgentOperatorRequest } from '../agent-remote.js'
import {
  formatSubrouterImportReport,
  importSubrouterCredentials,
} from '../credentials/import-subrouter.js'
import {
  formatOpencodeImportReport,
  importOpencodeCredentials,
} from '../credentials/import-opencode.js'
import {
  listPersonMcpCredentials,
  removePersonMcpToken,
  setPersonMcpToken,
} from '../credentials/person-mcp-store.js'
import { addPoolClient, readPoolClients, removePoolClient } from '../credentials/pool-clients.js'
import { resolvePoolServeAddress, servePool } from '../credentials/serve.js'
import { writePiPoolAgentDir } from '../agent-backend/pi/pool.js'
import { poolCatalog } from '../credentials/messages-proxy.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

/** One-line summary of a secret-free account view. */
function describeAccount(account: PoolAccountView, now: number): string {
  const parts: string[] = [account.id, account.provider, account.type]
  if (account.expiresAt) {
    parts.push(Date.parse(account.expiresAt) <= now ? `expires ${account.expiresAt} (expired)` : `expires ${account.expiresAt}`)
  }
  if (account.baseURL) parts.push(account.baseURL)
  if (account.label) parts.push(account.label)
  parts.push(`added ${account.addedAt}`)
  if (account.lastUsed) parts.push(`last used ${account.lastUsed}`)
  if (typeof account.coolingUntil === 'number' && account.coolingUntil > now) {
    parts.push(`cooling ${Math.ceil((account.coolingUntil - now) / 1000)}s`)
  }
  return parts.join(' | ')
}

function exitWithError(message: string): never {
  cliLogger.error(message)
  process.exit(EXIT_NO_RESTART)
}

/** Credential pool management is operator-only: agent shells never read pool files. */
async function refuseAgentMode(): Promise<void> {
  if (isAgentMode()) process.exit(await runAgentOperatorRequest(process.argv.slice(2)))
}

/**
 * The account seam: this host's pool, or the pool host's admin API when
 * ROADIE_POOL_URL is set (ROADIE_POOL_ADMIN_KEY_FILE holds an admin key, #238).
 */
function poolAccounts(): PoolAccounts {
  const accounts = resolvePoolAccounts({ env: process.env, dataDir: getDataDir() })
  if (accounts instanceof Error) exitWithError(accounts.message)
  return accounts
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
    await refuseAgentMode()
    const poolId = resolvePoolId(options.pool)
    const accounts = poolAccounts()
    const listing = await accounts.list({ poolId })
    if (listing instanceof Error) exitWithError(listing.message)
    const where = accounts.location === 'local' ? '' : ` on ${accounts.location}`
    const now = Date.now()
    if (listing.accounts.length === 0) {
      cliLogger.log(`Pool ${poolId}${where} has no accounts`)
    } else {
      cliLogger.log(`Pool ${poolId}${where} accounts:`)
      for (const account of listing.accounts) cliLogger.log(describeAccount(account, now))
    }

    const rotations = listing.rotations
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
    await refuseAgentMode()
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

    // The seam checks the free-text provider against the models.dev catalog;
    // an explicit --base-url bypasses the check (custom endpoints are exactly
    // the case the catalog cannot know).
    const added = await poolAccounts().addApiKey({
      poolId,
      provider,
      key,
      ...(options.baseUrl && { baseURL: options.baseUrl }),
      ...(options.label && { label: options.label }),
    })
    if (added instanceof Error) exitWithError(added.message)
    cliLogger.log(`Added ${added.account.provider} account ${added.account.id} to pool ${poolId}`)
    if (added.note) cliLogger.warn(added.note)
    process.exit(0)
  })

cli
  .command(
    'credentials login <provider>',
    'Log in an OAuth subscription account and add it to a credential pool (default: shared): anthropic (Claude Pro/Max) or openai-codex (ChatGPT).',
  )
  .option('--label <label>', 'Optional human-readable label for the account')
  .option('--pool <id>', 'Pool to add the account to (default: shared)')
  .action(async (provider: string, options) => {
    await refuseAgentMode()
    if (!isPoolOAuthProvider(provider)) {
      exitWithError(`Unsupported OAuth provider: ${provider}. Use anthropic or openai-codex.`)
    }
    const poolId = resolvePoolId(options.pool)
    const accounts = poolAccounts()
    const flow = await accounts.startOAuth({ poolId, provider, ...(options.label && { label: options.label }) })
    if (flow instanceof Error) exitWithError(flow.message)
    // The browser redirects to a localhost page nothing listens on; the code
    // and state stay visible in the address bar for pasting.
    cliLogger.log('Open this URL in your browser and sign in with the account to add:')
    cliLogger.log(flow.authorizeUrl)
    cliLogger.log('Then paste the code#state or the full redirect URL:')
    const readline = createInterface({ input: process.stdin })
    const pasted = await readline.question('')
    readline.close()
    if (!pasted.trim()) exitWithError('No authorization code received')
    const added = await accounts.completeOAuth({ poolId, flowId: flow.flowId, input: pasted })
    if (added instanceof Error) exitWithError(added.message)
    cliLogger.log(
      `Added ${added.account.provider} oauth account ${added.account.id}${added.account.expiresAt ? ` (access expires ${added.account.expiresAt})` : ''} to pool ${poolId}`,
    )
    if (added.note) cliLogger.warn(added.note)
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
    await refuseAgentMode()
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
  .command(
    'credentials import-opencode',
    'Import credentials from an OpenCode install (auth.json and <provider>-oauth-accounts.json rotation files) into a credential pool (default: shared), so existing logins carry over without signing in again. Read-only on OpenCode files: they are never written, moved or deleted.',
  )
  .option(
    '--opencode-data <dir>',
    'OpenCode data directory holding auth.json (e.g. ~/.local/share/opencode)',
  )
  .option('--pool <id>', 'Pool to add the accounts to (default: shared)')
  .option('--dry-run', 'Print the import plan without writing anything')
  .action(async (options) => {
    await refuseAgentMode()
    const result = await importOpencodeCredentials({
      dataDir: getDataDir(),
      poolId: resolvePoolId(options.pool),
      opencodeData: options.opencodeData,
      dryRun: options.dryRun === true,
    })
    if (result instanceof Error) exitWithError(result.message)
    for (const line of formatOpencodeImportReport(result)) {
      cliLogger.log(line)
    }
    process.exit(0)
  })

cli
  .command('credentials remove <id>', 'Remove an account from a credential pool (default: shared) by id')
  .option('--pool <id>', 'Pool to remove the account from (default: shared)')
  .action(async (id: string, options) => {
    await refuseAgentMode()
    const poolId = resolvePoolId(options.pool)
    const removed = await poolAccounts().remove({ poolId, accountId: id })
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
    await refuseAgentMode()
    const poolId = resolvePoolId(options.pool)
    const entries = models ?? []
    const accounts = poolAccounts()
    const result = await accounts.setRotation({ poolId, name, entries })
    if (result instanceof Error) exitWithError(result.message)
    const where = accounts.location === 'local' ? '' : ` on ${accounts.location}`
    if (entries.length === 0) {
      cliLogger.log(`Removed rotation ${name} from pool ${poolId}${where}`)
    } else {
      cliLogger.log(`Set rotation ${name} in pool ${poolId}${where}: ${entries.join(' ')}`)
    }
    process.exit(0)
  })

function requirePersonKey(person: string | undefined): string {
  const key = person?.trim()
  if (!key) exitWithError('--person is required: the identity hook person_id, or <platform>:<actorId>')
  return key
}

cli
  .command(
    'credentials mcp set',
    'Store a person\'s own OAuth token for an MCP server. Token JSON on stdin: {"access_token","refresh_token","expires_in","token_endpoint","client_id","client_secret"} (only access_token is required)',
  )
  .option('--person <key>', 'Person key: the identity hook person_id, or <platform>:<actorId>')
  .option('--credential <name>', 'Credential name referenced by the identity hook mcp_servers entry (default: the server name)')
  .action(async (options) => {
    await refuseAgentMode()
    const personKey = requirePersonKey(options.person)
    const credential = options.credential?.trim()
    if (!credential) exitWithError('--credential is required')
    if (process.stdin.isTTY) {
      exitWithError('Pipe the token JSON on stdin: cat token.json | roadie credentials mcp set --person <key> --credential <name>')
    }
    const raw = (() => {
      try {
        return JSON.parse(fs.readFileSync(0, 'utf8')) as unknown
      } catch (cause) {
        return new Error('Stdin must be a JSON object', { cause })
      }
    })()
    if (raw instanceof Error) exitWithError(raw.message)
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const str = (field: string) => (typeof record[field] === 'string' && record[field] ? (record[field] as string) : undefined)
    const access = str('access_token')
    if (!access) exitWithError('Token JSON needs an access_token')
    const expiresIn = typeof record.expires_in === 'number' && record.expires_in > 0 ? record.expires_in : undefined
    const result = await setPersonMcpToken({
      dataDir: getDataDir(),
      personKey,
      credential,
      token: {
        access,
        ...(expiresIn && { expires: Date.now() + expiresIn * 1000 }),
        ...(str('refresh_token') && { refresh: str('refresh_token')! }),
        ...(str('token_endpoint') && { tokenEndpoint: str('token_endpoint')! }),
        ...(str('client_id') && { clientId: str('client_id')! }),
        ...(str('client_secret') && { clientSecret: str('client_secret')! }),
      },
    })
    if (result instanceof Error) exitWithError(result.message)
    cliLogger.log(`Stored MCP credential ${credential} for ${personKey}`)
    process.exit(0)
  })

cli
  .command('credentials mcp list', 'List the MCP credential names stored for a person (never the tokens)')
  .option('--person <key>', 'Person key: the identity hook person_id, or <platform>:<actorId>')
  .action(async (options) => {
    await refuseAgentMode()
    const personKey = requirePersonKey(options.person)
    const names = listPersonMcpCredentials({ dataDir: getDataDir(), personKey })
    cliLogger.log(names.length === 0 ? `No MCP credentials stored for ${personKey}` : names.join('\n'))
    process.exit(0)
  })

cli
  .command('credentials mcp remove', 'Remove a person\'s stored MCP credential')
  .option('--person <key>', 'Person key: the identity hook person_id, or <platform>:<actorId>')
  .option('--credential <name>', 'Credential name to remove')
  .action(async (options) => {
    await refuseAgentMode()
    const personKey = requirePersonKey(options.person)
    const credential = options.credential?.trim()
    if (!credential) exitWithError('--credential is required')
    const removed = await removePersonMcpToken({ dataDir: getDataDir(), personKey, credential })
    if (removed instanceof Error) exitWithError(removed.message)
    if (!removed) exitWithError(`No MCP credential ${credential} for ${personKey}`)
    cliLogger.log(`Removed MCP credential ${credential} for ${personKey}`)
    process.exit(0)
  })

/** Parse `--pools a,b` into validated pool ids (default: shared). */
function resolvePoolIds(value: string | undefined): string[] {
  const ids = (value ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  return (ids.length > 0 ? ids : [SHARED_POOL_ID]).map((id) => resolvePoolId(id))
}

cli
  .command(
    'credentials client add <name>',
    'Register an external pool client (e.g. a Homeboy Pi runner). Prints its key once; Roadie stores only a hash. The client sends it as x-roadie-key to the pool proxy (ROADIE_POOL_PROXY_PORT).',
  )
  .option('--pools <ids>', 'Comma-separated pools the client bills to (default: shared)')
  .option('--admin', "Also let the client manage its pools' accounts through the pool host admin API (a remote bot's ROADIE_POOL_ADMIN_KEY_FILE)")
  .action(async (name: string, options) => {
    await refuseAgentMode()
    const added = addPoolClient({ dataDir: getDataDir(), name, pools: resolvePoolIds(options.pools), admin: options.admin === true })
    if (added instanceof Error) exitWithError(added.message)
    cliLogger.log(`Registered ${added.client.admin ? 'admin ' : ''}pool client ${added.client.name} (pools: ${added.client.pools.join(', ')})`)
    cliLogger.log('Key (shown once; store it with the client, e.g. as ROADIE_PI_KEY):')
    process.stdout.write(`${added.key}\n`)
    cliLogger.log('Restart Roadie so the pool proxy starts for registered clients.')
    process.exit(0)
  })

cli
  .command('credentials client list', 'List registered external pool clients (never their keys)')
  .action(async () => {
    await refuseAgentMode()
    const clients = readPoolClients(getDataDir())
    if (clients instanceof Error) exitWithError(clients.message)
    if (clients.length === 0) cliLogger.log('No pool clients registered.')
    for (const client of clients) {
      cliLogger.log(`${client.name}  pools: ${client.pools.join(', ')}${client.admin ? '  admin' : ''}  created ${new Date(client.createdAt).toISOString()}`)
    }
    process.exit(0)
  })

cli
  .command('credentials client remove <name>', 'Revoke an external pool client; its key stops working on the next request')
  .action(async (name: string) => {
    await refuseAgentMode()
    const removed = removePoolClient({ dataDir: getDataDir(), name })
    if (removed instanceof Error) exitWithError(removed.message)
    if (!removed) exitWithError(`Pool client ${name} not found`)
    cliLogger.log(`Removed pool client ${name}`)
    process.exit(0)
  })

cli
  .command(
    'credentials client pi-agent-dir <dir>',
    'Write a Pi agent dir (models.json) whose roadie provider points at the pool proxy, one model per rotation. Copy it to the client and set PI_CODING_AGENT_DIR and ROADIE_PI_KEY there.',
  )
  .option('--base-url <url>', 'Pool proxy URL as the client reaches it (e.g. http://127.0.0.1:47120)')
  .option('--pools <ids>', 'Pools whose rotations to offer (default: shared)')
  .action(async (dir: string, options) => {
    await refuseAgentMode()
    const baseUrl = String(options.baseUrl ?? '').trim()
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) exitWithError('--base-url must be an http(s) URL')
    const dataDir = getDataDir()
    const poolIds = resolvePoolIds(options.pools)
    const catalog = poolCatalog({ dataDir, poolIds })
    if (catalog.rotations.length === 0) exitWithError(`Pools ${poolIds.join(', ')} have no rotation`)
    writePiPoolAgentDir({ agentDir: dir, baseUrl: baseUrl.replace(/\/+$/, ''), ...catalog })
    cliLogger.log(`Wrote Pi agent dir ${dir} (rotations: ${catalog.rotations.join(', ')})`)
    process.exit(0)
  })

cli
  .command(
    'credentials serve',
    'Run this host as a headless credential pool: the pool proxy for registered clients, with no chat platform and no agent backend. Clients reach it with their key (x-roadie-key). Binds 127.0.0.1 unless --host or ROADIE_POOL_PROXY_HOST names another address.',
  )
  .option('--host <addr>', 'Listen address (default: ROADIE_POOL_PROXY_HOST, else 127.0.0.1)')
  .option('--port <n>', 'Listen port (default: ROADIE_POOL_PROXY_PORT; required)')
  .action(async (options) => {
    await refuseAgentMode()
    const address = resolvePoolServeAddress({ host: options.host, port: options.port })
    if (address instanceof Error) exitWithError(address.message)
    const proxy = await servePool({ dataDir: getDataDir(), ...address })
    if (proxy instanceof Error) exitWithError(proxy.message)
    const clients = readPoolClients(getDataDir())
    cliLogger.log(`Credential pool serving ${proxy.baseUrl} for ${clients instanceof Error ? 0 : clients.length} registered client(s)`)
    const stop = async (signal: string) => {
      cliLogger.log(`${signal}: closing the credential pool`)
      await proxy.close().catch(() => {})
      process.exit(0)
    }
    process.once('SIGTERM', () => void stop('SIGTERM'))
    process.once('SIGINT', () => void stop('SIGINT'))
    await new Promise<never>(() => {})
  })

export default cli
