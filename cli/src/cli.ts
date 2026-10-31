#!/usr/bin/env node
// Main CLI entrypoint for the Roadie Discord bot.
// Handles interactive setup, Discord OAuth, slash command registration,
// project channel creation, and launching the bot on the Pi agent backend.
import { loadPlugins, resolvePluginSpecs } from './plugins.js'
import { assertConfiguredBackend, resolveAgentBackendProvider, setPiPool } from './agent-backend/registry.js'
import { goke } from 'goke'
import { z } from 'zod'
import path from 'node:path'
import { createLogger, formatErrorWithStack, initLogFile, LogPrefix } from './logger.js'
import {
  setDataDir,
  getDataDir,
  getProjectsDir,
} from './config.js'
import { getCurrentVersion } from './upgrade.js'
import { store } from './store.js'
import botCommands from './cli-commands/bot.js'
import credentialsCommands from './cli-commands/credentials.js'
import maintenanceCommands from './cli-commands/maintenance.js'
import miscCommands from './cli-commands/misc.js'
import projectCommands from './cli-commands/project.js'
import sendCommands from './cli-commands/send.js'
import sessionCommands from './cli-commands/session.js'
import taskCommands from './cli-commands/task.js'
import threadCommands from './cli-commands/thread.js'
import channelCommands from './cli-commands/channel.js'
import userCommands from './cli-commands/user.js'
import { isIdentityConfigured } from './identity.js'
import {
  parseCredentialsModeStrict,
  parseThreadBillingStrict,
} from './credentials/person-pool.js'
import {
  getChannelsConfigPath,
  isChannelPolicyConfigured,
  setChannelsConfigPath,
} from './channel-policy.js'
import { setPromptConfigPath } from './prompt-config.js'
import { setContextProviderCommand } from './context-provider.js'
import {
  parseShellEnvTemplates,
  SHELL_ENV_TEMPLATES_ENV,
} from './turn-attribution-env.js'
import {
  checkIsolatedShellSetup,
  ensureIsolatedShellWrapper,
  ISOLATE_SHELLS_ENV,
} from './isolated-shell.js'
import {
  EXIT_NO_RESTART,
  printDiscordInstallUrlAndExit,
  resolveSubcommandAgentBackendProvider,
} from './cli-runner.js'
import { registerBuiltinChatPlatforms } from './chat-platform/builtin.js'
import { parseChatPlatformIds } from './chat-platform/registry.js'
import { runChatPlatforms } from './chat-platform/run-platforms.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke('roadie')

process.title = 'roadie'

cli
  .command('', 'Set up and run the Roadie Discord bot')
  .option(
    '--platform <id>',
    z
      .array(z.string())
      .optional()
      .describe(
        'Chat platform id(s) to run: discord (default), slack, or a plugin-registered platform. Repeatable or comma-separated; several platforms share one process and data dir. Also ROADIE_PLATFORM',
      ),
  )
  .option('--restart-onboarding', 'Prompt for new credentials even if saved')
  .option(
    '--add-channels',
    'Run Discord channel setup before starting',
  )
  .option(
    '--data-dir <path>',
    'Data directory for config and database (default: ~/.roadie)',
  )
  .option('--install-url', 'Print the bot install URL and exit')
  .option(
    '--use-worktrees',
    'Deprecated no-op: worktrees are created by host tooling; use roadie send --cwd',
  )
  .option(
    '--enable-voice-channels',
    'Deprecated no-op: voice support was removed',
  )
  .option(
    '--verbosity <level>',
    'Default verbosity for all channels (tools_and_text, text_and_essential_tools, or text_only)',
  )
  .option(
    '--mention-mode',
    'Bot only responds when @mentioned (default for all channels)',
  )
  .option(
    '--no-critique',
    'Deprecated no-op: Roadie no longer includes critique.work instructions',
  )
  .option(
    '--enable-footer-mentions',
    'Mention the thread creator in final session footers so they get a notification',
  )
  .option(
    '--auto-restart',
    'Automatically restart the bot on crash or OOM kill',
  )
  .option(
    '--allow-all-users',
    'Allow all Discord users to start sessions without needing Roadie role or admin permissions (no-roadie role still blocks)',
  )
  .option(
    '--context-provider <command>',
    'Command that supplies host context (memory) per session and per speaker (JSON on stdin/stdout). Also ROADIE_CONTEXT_PROVIDER',
  )
  .option(
    '--prompt-config <path>',
    'System prompt overrides (YAML/JSON): disable, replace or append sections. Also ROADIE_PROMPT_CONFIG',
  )
  .option(
    '--channels-config <path>',
    'Per-channel policy file (YAML/JSON): who the bot answers, when, threads, directory, agent, model, capabilities. Also ROADIE_CHANNELS_CONFIG',
  )
  .option(
    '--restrict-directories',
    'Only allow the agent to access the session working directory and a few known-safe paths. Any other folder asks for permission. By default every directory is allowed',
  )
  .option(
    '--isolate-shells <user>',
    'Run agent tool shells as the given unprivileged user through a setpriv wrapper (Linux only; the bot must run as root or with CAP_SETUID/CAP_SETGID). Off by default. Same as ROADIE_ISOLATE_SHELLS',
  )
  .option(
    '--permission-timeout-minutes <minutes>',
    'Permission prompt timeout in minutes before auto-rejecting (default: 10)',
  )
  .option(
    '--disable-sync',
    'Deprecated no-op: Roadie no longer mirrors external sessions into Discord',
  )
  .option(
    '--credential-pools',
    'No-op: credential pools are enabled by default (the shared pool rotations are exposed as roadie/<rotation> models). Kept for compatibility with earlier invocations',
  )
  .option(
    '--no-credential-pools',
    'Disable credential pools entirely: Pi\'s own auth (its agent dir auth.json, managed with `pi` on the host) applies and /credentials is not registered. Same as ROADIE_CREDENTIAL_POOLS=0',
  )
  .option(
    '--credentials <mode>',
    'Credential pool routing: global (default, shared pool only), per-person (each session bills to its owner\'s pool), per-person-fallback (owner pool first, then shared). Implies --credential-pools except for global. Same as ROADIE_CREDENTIALS',
  )
  .option(
    '--thread-billing <billing>',
    'Who pays for a thread in per-person credential routing: owner (default, the first speaker owns the session) or speaker (each turn bills to whoever sent it). Same as ROADIE_THREAD_BILLING',
  )
  .option(
    '--no-analytics',
    'Deprecated no-op: Roadie no longer sends product analytics',
  )
  .option('--no-auto-upgrade', 'Disable background auto-upgrade on startup')
  .option(
    '--allow-mention <type>',
    z
      .array(z.enum(['users', 'roles', 'everyone']))
      .optional()
      .describe(
        'Which mention types the bot can trigger (users, roles, everyone). Repeatable. Default: users only.',
      ),
  )
  .option(
    '--plugin <spec>',
    z
      .array(z.string())
      .optional()
      .describe(
        'Load a Roadie plugin (file path or package name) that extends Roadie through hooks. Repeatable; loads in order. Also ROADIE_PLUGINS (comma-separated)',
      ),
  )
  .option(
    '--shell-env <NAME=template>',
    z
      .array(z.string())
      .optional()
      .describe(
        'Extra environment variable for agent tool shells, as NAME=template. Repeatable. Templates may use {session_id}, {thread_id}, {channel_id}, {platform}, {actor_id}, {actor_name} and {person_id}; a field with no value for a turn leaves the variable unset. Also ROADIE_SHELL_ENV (JSON object). Invalid names or unknown fields stop startup.',
      ),
  )
  .action(
    async (options: {
      restartOnboarding?: boolean
      addChannels?: boolean
      dataDir?: string
      installUrl?: boolean
      useWorktrees?: boolean
      enableVoiceChannels?: boolean
      verbosity?: string
      mentionMode?: boolean
      noCritique?: boolean
      enableFooterMentions?: boolean
      allowAllUsers?: boolean
      channelsConfig?: string
      promptConfig?: string
      contextProvider?: string
      restrictDirectories?: boolean
      isolateShells?: string
      permissionTimeoutMinutes?: string
      disableSync?: boolean
      credentialPools?: boolean
      credentials?: string
      threadBilling?: string
      autoRestart?: boolean
      noAnalytics?: boolean
      noAutoUpgrade?: boolean
      allowMention?: Array<'users' | 'roles' | 'everyone'>
      enableSkill?: string[]
      plugin?: string[]
      disableSkill?: string[]
      shellEnv?: string[]
      platform?: string[]
    }) => {
      // Guard: only one roadie bot process can run per lock port. Agents may run
      // a second dev bot only when they explicitly choose a different lock port.
      const parentLockPort = process.env.ROADIE_PARENT_LOCK_PORT
      const currentLockPort = process.env.ROADIE_LOCK_PORT
      const usesDifferentLockPort = currentLockPort !== parentLockPort

      if (process.env.ROADIE_AGENT_SHELL && !usesDifferentLockPort) {
        cliLogger.error(
          'Cannot run `roadie` inside an agent session — it would kill the already-running bot process.\n' +
          'Only one roadie bot can run at a time (they share a lock port).\n' +
          'Set ROADIE_LOCK_PORT to a different port for an isolated dev process, or use `roadie send`, `roadie session`, and other subcommands instead.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      if (process.env.ROADIE_AGENT_SHELL && usesDifferentLockPort) {
        delete process.env['ROADIE_DB_URL']
        delete process.env['ROADIE_DB_AUTH_TOKEN']
      }

      try {
        // Set data directory early, before any database access
        if (options.dataDir) {
          setDataDir(options.dataDir)
          cliLogger.log(`Using data directory: ${getDataDir()}`)
        }

        // Initialize file logging to <dataDir>/roadie.log
        initLogFile(getDataDir())

        // ROADIE_BACKEND only accepts `pi` (#177): fail before any setup.
        try {
          assertConfiguredBackend()
        } catch (error) {
          cliLogger.error(error instanceof Error ? error.message : String(error))
          process.exit(EXIT_NO_RESTART)
        }

        // Batch all CLI flag store updates into a single setState call.
        const defaultVerbosity = (() => {
          if (!options.verbosity) {
            return undefined
          }
          if (options.verbosity === 'tools_and_text') {
            return 'tools_and_text'
          }
          if (options.verbosity === 'text_and_essential_tools') {
            return 'text_and_essential_tools'
          }
          if (options.verbosity === 'text_only') {
            return 'text_only'
          }
          cliLogger.error(
            `Invalid verbosity level: ${options.verbosity}. Use one of: tools_and_text, text_and_essential_tools, text_only`,
          )
          process.exit(EXIT_NO_RESTART)
        })()

        // --permission-timeout-minutes validation
        // Node setTimeout max is 2_147_483_647ms; larger values fire immediately.
        const MAX_TIMEOUT_MINUTES = Math.floor(2_147_483_647 / 60_000)
        const permissionTimeoutMs = (() => {
          if (!options.permissionTimeoutMinutes) return undefined
          const parsed = Number(options.permissionTimeoutMinutes)
          if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MINUTES) {
            cliLogger.error(
              `Invalid permission timeout: ${options.permissionTimeoutMinutes}. Must be a positive whole number of minutes (max ${MAX_TIMEOUT_MINUTES}).`,
            )
            process.exit(EXIT_NO_RESTART)
          }
          return parsed * 60_000
        })()

        // Credential pool routing (phase 2a). Strict on the flag (a typo must
        // not silently bill everyone to shared), permissive on the env (warn).
        const credentialsMode = (() => {
          if (!options.credentials) return undefined
          const parsed = parseCredentialsModeStrict(options.credentials)
          if (parsed instanceof Error) {
            cliLogger.error(parsed.message)
            process.exit(EXIT_NO_RESTART)
          }
          return parsed
        })()
        const threadBilling = (() => {
          if (!options.threadBilling) return undefined
          const parsed = parseThreadBillingStrict(options.threadBilling)
          if (parsed instanceof Error) {
            cliLogger.error(parsed.message)
            process.exit(EXIT_NO_RESTART)
          }
          return parsed
        })()
        for (const [envName, parse] of [
          ['ROADIE_CREDENTIALS', parseCredentialsModeStrict],
          ['ROADIE_THREAD_BILLING', parseThreadBillingStrict],
        ] as const) {
          const value = process.env[envName]
          if (value && parse(value) instanceof Error) {
            cliLogger.warn(
              `Ignoring unsupported ${envName}=${value}: falling back to the default`,
            )
          }
        }
        // A per-person --credentials mode is itself an opt-in to pools.
        const perPersonCredentials = credentialsMode === 'per-person' || credentialsMode === 'per-person-fallback'

        // Opt-in shell isolation (--isolate-shells / ROADIE_ISOLATE_SHELLS).
        // The flag wins over the env, matching the other ROADIE_* flags.
        const isolateShellsUser = (() => {
          const requested = (options.isolateShells ?? process.env[ISOLATE_SHELLS_ENV])?.trim()
          if (requested === undefined || requested === '') return undefined
          return requested
        })()

        // Extra agent tool-shell variables (--shell-env / ROADIE_SHELL_ENV).
        // Strict on both sources: a typo'd name or an unknown template field
        // must stop the bot, never export an empty or wrong variable.
        const shellEnvTemplates = (() => {
          const parsed = parseShellEnvTemplates({
            flag: options.shellEnv,
            json: process.env[SHELL_ENV_TEMPLATES_ENV],
          })
          if (parsed instanceof Error) {
            cliLogger.error(parsed.message)
            process.exit(EXIT_NO_RESTART)
          }
          return parsed
        })()

        store.setState({
          ...(defaultVerbosity && {
            defaultVerbosity,
          }),
          ...(options.mentionMode && { defaultMentionMode: true }),
          ...(options.enableFooterMentions && { footerMentionsEnabled: true }),
          ...(options.allowAllUsers && { allowAllUsers: true }),
          ...(options.restrictDirectories && { restrictExternalDirectories: true }),
          ...(isolateShellsUser && { isolateShellsUser }),
          ...(permissionTimeoutMs !== undefined && { permissionTimeoutMs }),
          ...(options.noAutoUpgrade && { autoUpgradeEnabled: false }),
          // An explicit --no-credential-pools wins even over a per-person
          // --credentials mode: the user asked to turn pools off entirely.
          ...(perPersonCredentials && { credentialPoolsEnabled: true }),
          ...(options.credentialPools === false && { credentialPoolsEnabled: false }),
          ...(credentialsMode && { credentialsMode }),
          ...(threadBilling && { threadBilling }),
          ...(options.allowMention && { allowedMentions: options.allowMention }),
          ...(Object.keys(shellEnvTemplates).length > 0 && { shellEnvTemplates }),
        })

        // Fail fast on shell isolation before any Discord connection: wrong
        // privileges, a missing agent user or missing binaries must stop the
        // bot here, not when the first session starts.
        if (isolateShellsUser) {
          const isolation = await ensureIsolatedShellWrapper({
            dataDir: getDataDir(),
            username: isolateShellsUser,
          })
          if (isolation instanceof Error) {
            cliLogger.error(isolation.message)
            process.exit(EXIT_NO_RESTART)
          }
          cliLogger.log(
            `Shell isolation enabled: agent tool shells run as ${isolateShellsUser} (uid ${isolation.account.uid}) via ${isolation.shellPath}`,
          )
          const accessProblems = checkIsolatedShellSetup({
            dataDir: getDataDir(),
            projectDirectories: [getProjectsDir()],
            account: isolation.account,
          })
          for (const problem of accessProblems) {
            cliLogger.warn(`Shell isolation check: ${problem}`)
          }
          if (accessProblems.length === 0) {
            cliLogger.log(
              'Shell isolation check: project directories are agent-writable; the data dir and Pi agent dir are not agent-readable',
            )
          }
        }

        if (options.contextProvider) {
          setContextProviderCommand(options.contextProvider)
        }
        if (options.promptConfig) {
          setPromptConfigPath(path.resolve(options.promptConfig))
        }
        if (options.channelsConfig) {
          setChannelsConfigPath(path.resolve(options.channelsConfig))
        }
        if (isChannelPolicyConfigured()) {
          cliLogger.log(
            `Channel policy enabled: ${getChannelsConfigPath()} (unconfigured channels are not answered)`,
          )
        }
        if (isIdentityConfigured()) {
          cliLogger.log(
            'Identity enabled: access and capabilities come from the person filter, not Discord roles',
          )
        }
        if (options.allowAllUsers) {
          cliLogger.log(
            'Allow all users: any Discord member can start sessions (no-roadie role still blocks)',
          )
        }
        if (options.restrictDirectories) {
          cliLogger.log(
            'Restricted directories: the agent asks before reading outside the working directory',
          )
        }
        if (Object.keys(shellEnvTemplates).length > 0) {
          cliLogger.log(
            `Shell env templates configured for agent tool shells: ${Object.keys(shellEnvTemplates).join(', ')}`,
          )
        }
        if (permissionTimeoutMs !== undefined) {
          cliLogger.log(`Permission timeout set to ${options.permissionTimeoutMinutes} minutes`)
        }

        if (options.verbosity) {
          cliLogger.log(`Default verbosity: ${options.verbosity}`)
        }
        if (options.mentionMode) {
          cliLogger.log(
            'Default mention mode: enabled (bot only responds when @mentioned)',
          )
        }
        if (options.useWorktrees) {
          cliLogger.log('--use-worktrees is a no-op: create checkouts with host tooling and use roadie send --cwd')
        }
        if (options.noCritique) {
          cliLogger.log('--no-critique is a no-op: critique support was removed')
        }
        if (options.enableFooterMentions) {
          cliLogger.log(
            'Footer mentions enabled: final session footers will mention thread creators',
          )
        }
        if (options.noAutoUpgrade) {
          cliLogger.log(
            'Auto-upgrade disabled: roadie will not check for updates on startup',
          )
        }
        if (options.credentialPools === true) {
          cliLogger.log('--credential-pools is a no-op: credential pools are enabled by default')
        }
        if (store.getState().credentialPoolsEnabled) {
          cliLogger.log(
            'Credential pools enabled: the shared pool rotations are exposed as roadie/<rotation> models',
          )
        } else {
          cliLogger.log(
            'Credential pools disabled: Pi\'s own auth applies',
          )
        }
        if (perPersonCredentials) {
          cliLogger.log(
            `Credential routing: ${credentialsMode} (thread billing: ${threadBilling ?? 'owner'})`,
          )
        }
        if (options.noAnalytics) {
          cliLogger.log('--no-analytics is a no-op: Roadie no longer sends product analytics')
        }

        if (options.installUrl) {
          await printDiscordInstallUrlAndExit()
        }

        // Built-in platforms register first so a plugin that reuses their id
        // fails at plugin load; plugins register their hooks and platforms
        // before anything reads them.
        registerBuiltinChatPlatforms()
        const plugins = await loadPlugins(resolvePluginSpecs(options.plugin))
        if (plugins instanceof Error) {
          cliLogger.error(plugins.message)
          process.exit(EXIT_NO_RESTART)
        }
        // Pi bills to the credential pools through a loopback proxy.
        // Registered external pool clients (#171) use the same proxy.
        if (store.getState().credentialPoolsEnabled) {
          const { startPiPool } = await import('./agent-backend/pi/pool-startup.js')
          const pool = await startPiPool()
          if (pool instanceof Error) cliLogger.warn(`Pi credential pool proxy not started: ${pool.message}`)
          else {
            setPiPool(pool)
            const remotePool = process.env['ROADIE_POOL_URL']?.trim()
            cliLogger.log(remotePool
              ? `Credential pool: remote ${remotePool} (relay on ${pool.baseUrl})`
              : `Credential pool proxy listening on ${pool.baseUrl}`)
          }
        }
        let backend
        try {
          backend = resolveAgentBackendProvider()
        } catch (error) {
          // e.g. the pi binary is missing or too old.
          cliLogger.error(error instanceof Error ? error.message : String(error))
          process.exit(EXIT_NO_RESTART)
        }
        cliLogger.log(`Agent backend: ${backend.id}`)
        const platformIds = parseChatPlatformIds(
          options.platform ?? process.env.ROADIE_PLATFORM,
        )
        // Children (agent tool shells, `roadie send`) see the running platforms.
        process.env.ROADIE_PLATFORM = platformIds.join(',')
        if (platformIds.length > 1) {
          cliLogger.log(`Chat platforms: ${platformIds.join(', ')}`)
        }
        // Single-instance enforcement is handled by the hrana server binding
        // the lock port. runChatPlatforms() starts it (evicting any existing
        // instance), then every requested platform through the registry.
        const result = await runChatPlatforms({
          platformIds,
          options: {
            restartOnboarding: options.restartOnboarding,
            addChannels: options.addChannels,
            dataDir: options.dataDir,
          },
        })
        if (result instanceof Error) {
          cliLogger.error(result.message)
          process.exit(EXIT_NO_RESTART)
        }
        return
      } catch (error) {
        cliLogger.error('Unhandled error:', formatErrorWithStack(error))
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

// Every subcommand — and the agent-remote child, which execs this entry with a
// subcommand — must resolve the same agent backend the bot does (plugins plus
// Pi channels), or Pi sessions stay invisible to session commands. Runs once
// per process, before the matched command action.
cli.use(() => resolveSubcommandAgentBackendProvider())

cli.use(botCommands)
cli.use(credentialsCommands)
cli.use(miscCommands)
cli.use(sendCommands)
cli.use(taskCommands)
cli.use(projectCommands)
cli.use(threadCommands)
cli.use(channelCommands)
cli.use(userCommands)
cli.use(sessionCommands)
cli.use(maintenanceCommands)

// The external identity command was removed (#312): identity comes only from
// a plugin's `person` filter. Fail loudly instead of a bare unknown-option error.
const removedIdentityFlag = process.argv.slice(2).find((arg) => /^--identity[-_]?hook(=|$)/i.test(arg))
if (removedIdentityFlag) {
  cliLogger.error(
    `${removedIdentityFlag.split('=')[0]} was removed. Identity now comes only from the \`person\` filter: register it in a Roadie plugin with roadie.addFilter('person', ...) (see "Plugins and hooks" in the README).`,
  )
  process.exit(EXIT_NO_RESTART)
}

cli.version(getCurrentVersion())
cli.help()
void cli.parse()
