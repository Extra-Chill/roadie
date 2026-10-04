#!/usr/bin/env node
// Main CLI entrypoint for the Roadie Discord bot.
// Handles interactive setup, Discord OAuth, slash command registration,
// project channel creation, and launching the bot with opencode integration.
import { loadPlugins, resolvePluginSpecs } from './plugins.js'
import { resolveAgentBackendProvider } from './agent-backend/registry.js'
import { goke } from 'goke'
import { z } from 'zod'
import path from 'node:path'
import { createLogger, formatErrorWithStack, initLogFile, LogPrefix } from './logger.js'
import {
  setDataDir,
  setProjectsDir,
  getDataDir,
  getProjectsDir,
} from './config.js'
import { getCurrentVersion } from './upgrade.js'
import { store } from './store.js'
import { publicOpencodeBindRequiresPassword } from './opencode.js'
import botCommands from './cli-commands/bot.js'
import maintenanceCommands from './cli-commands/maintenance.js'
import miscCommands from './cli-commands/misc.js'
import projectCommands from './cli-commands/project.js'
import sendCommands from './cli-commands/send.js'
import sessionCommands from './cli-commands/session.js'
import taskCommands from './cli-commands/task.js'
import threadCommands from './cli-commands/thread.js'
import userCommands from './cli-commands/user.js'
import { isIdentityHookConfigured, setIdentityHookCommand } from './identity.js'
import {
  getChannelsConfigPath,
  isChannelPolicyConfigured,
  setChannelsConfigPath,
} from './channel-policy.js'
import { setPromptConfigPath } from './prompt-config.js'
import { setContextProviderCommand } from './context-provider.js'
import {
  EXIT_NO_RESTART,
  printDiscordInstallUrlAndExit,
  run,
} from './cli-runner.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke('roadie')

process.title = 'roadie'

cli
  .command('', 'Set up and run the Roadie Discord bot')
  .option('--restart-onboarding', 'Prompt for new credentials even if saved')
  .option(
    '--add-channels',
    'Select OpenCode projects to create Discord channels before starting',
  )
  .option(
    '--data-dir <path>',
    'Data directory for config and database (default: ~/.roadie)',
  )
  .option(
    '--projects-dir <path>',
    'Directory where new projects are created (default: <data-dir>/projects)',
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
    '--identity-hook <command>',
    'Command that maps a chat user to a person and their capabilities (JSON on stdin/stdout). Replaces role checks. Also ROADIE_IDENTITY_HOOK',
  )
  .option(
    '--restrict-directories',
    'Only allow the agent to access the session working directory and a few known-safe paths. Any other folder asks for permission. By default every directory is allowed and you protect folders with deny/ask rules in opencode.json',
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
    '--no-subrouter',
    'Do not load subrouter account rotation into the OpenCode backend. Same as ROADIE_SUBROUTER=0',
  )
  .option(
    '--no-analytics',
    'Deprecated no-op: Roadie no longer sends product analytics',
  )
  .option('--no-auto-upgrade', 'Disable background auto-upgrade on startup')
  .option(
    '--opencode-hostname <host>',
    'Hostname the OpenCode server listens on (default: 127.0.0.1). Use 0.0.0.0 to expose it on a VPS',
  )
  .option(
    '--opencode-port <port>',
    'Port the OpenCode server listens on (default: a random free port)',
  )
  .option(
    '--gateway',
    'Removed: Roadie only runs your own Discord bot (hosted gateway mode is not supported)',
  )
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
    '--enable-skill <name>',
    z
      .array(z.string())
      .optional()
      .describe(
        'Allow only the named skills. Skills come from your OpenCode setup (skills directories and plugins); all others are hidden from the model and are not registered as slash commands. Repeatable. Mutually exclusive with --disable-skill.',
      ),
  )
  .option(
    '--disable-skill <name>',
    z
      .array(z.string())
      .optional()
      .describe(
        'Hide the named skills from the model and from slash commands. Skills come from your OpenCode setup (skills directories and plugins). Repeatable. Mutually exclusive with --enable-skill.',
      ),
  )
  .action(
    async (options: {
      restartOnboarding?: boolean
      addChannels?: boolean
      dataDir?: string
      projectsDir?: string
      installUrl?: boolean
      useWorktrees?: boolean
      enableVoiceChannels?: boolean
      verbosity?: string
      mentionMode?: boolean
      noCritique?: boolean
      enableFooterMentions?: boolean
      allowAllUsers?: boolean
      identityHook?: string
      channelsConfig?: string
      promptConfig?: string
      contextProvider?: string
      restrictDirectories?: boolean
      permissionTimeoutMinutes?: string
      disableSync?: boolean
      subrouter?: boolean
      autoRestart?: boolean
      noAnalytics?: boolean
      noAutoUpgrade?: boolean
      gateway?: boolean
      allowMention?: Array<'users' | 'roles' | 'everyone'>
      enableSkill?: string[]
      plugin?: string[]
      disableSkill?: string[]
      opencodeHostname?: string
      opencodePort?: string
    }) => {
      // Guard: only one roadie bot process can run per lock port. Agents may run
      // a second dev bot only when they explicitly choose a different lock port.
      const parentLockPort = process.env.ROADIE_PARENT_LOCK_PORT
      const currentLockPort = process.env.ROADIE_LOCK_PORT
      const usesDifferentLockPort = currentLockPort !== parentLockPort

      if (process.env.ROADIE_OPENCODE_PROCESS && !usesDifferentLockPort) {
        cliLogger.error(
          'Cannot run `roadie` inside an OpenCode session — it would kill the already-running bot process.\n' +
          'Only one roadie bot can run at a time (they share a lock port).\n' +
          'Set ROADIE_LOCK_PORT to a different port for an isolated dev process, or use `roadie send`, `roadie session`, and other subcommands instead.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      if (process.env.ROADIE_OPENCODE_PROCESS && usesDifferentLockPort) {
        delete process.env['ROADIE_DB_URL']
        delete process.env['ROADIE_DB_AUTH_TOKEN']
      }

      try {
        // Set data directory early, before any database access
        if (options.dataDir) {
          setDataDir(options.dataDir)
          cliLogger.log(`Using data directory: ${getDataDir()}`)
        }

        if (options.projectsDir) {
          setProjectsDir(options.projectsDir)
          cliLogger.log(`Using projects directory: ${getProjectsDir()}`)
        }

        // Initialize file logging to <dataDir>/roadie.log
        initLogFile(getDataDir())

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

        // --enable-skill and --disable-skill are mutually exclusive: the user
        // either whitelists a small allowlist or blacklists a few unwanted
        // skills, never both. Applied later in opencode.ts as permission.skill
        // rules via computeSkillPermission().
        const enabledSkills = options.enableSkill ?? []
        const disabledSkills = options.disableSkill ?? []
        if (enabledSkills.length > 0 && disabledSkills.length > 0) {
          cliLogger.error(
            'Cannot use --enable-skill and --disable-skill at the same time. Use one or the other.',
          )
          process.exit(EXIT_NO_RESTART)
        }
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

        const opencodeHostname = options.opencodeHostname?.trim() || undefined
        const opencodePort = (() => {
          if (!options.opencodePort) return undefined
          const parsed = Number(options.opencodePort)
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
            cliLogger.error(
              `Invalid --opencode-port: ${options.opencodePort}. Must be an integer between 1 and 65535.`,
            )
            process.exit(EXIT_NO_RESTART)
          }
          return parsed
        })()

        if (
          publicOpencodeBindRequiresPassword({ hostname: opencodeHostname }) &&
          !process.env.OPENCODE_SERVER_PASSWORD
        ) {
          cliLogger.error(
            `OPENCODE_SERVER_PASSWORD is required when --opencode-hostname is ${opencodeHostname}. Binding the OpenCode server on a public address without a password lets anyone control the agent.`,
          )
          process.exit(EXIT_NO_RESTART)
        }

        store.setState({
          ...(defaultVerbosity && {
            defaultVerbosity,
          }),
          ...(options.mentionMode && { defaultMentionMode: true }),
          ...(options.enableFooterMentions && { footerMentionsEnabled: true }),
          ...(options.allowAllUsers && { allowAllUsers: true }),
          ...(options.restrictDirectories && { restrictExternalDirectories: true }),
          ...(permissionTimeoutMs !== undefined && { permissionTimeoutMs }),
          ...(options.noAutoUpgrade && { autoUpgradeEnabled: false }),
          ...(options.subrouter === false && { subrouterEnabled: false }),
          ...(enabledSkills.length > 0 && { enabledSkills }),
          ...(disabledSkills.length > 0 && { disabledSkills }),
          ...(options.allowMention && { allowedMentions: options.allowMention }),
          ...(opencodeHostname && { opencodeHostname }),
          ...(opencodePort !== undefined && { opencodePort }),
        })

        if (enabledSkills.length > 0) {
          cliLogger.log(
            `Skill whitelist enabled: only [${enabledSkills.join(', ')}] will be injected`,
          )
        }
        if (disabledSkills.length > 0) {
          cliLogger.log(
            `Skill blacklist enabled: [${disabledSkills.join(', ')}] will be hidden`,
          )
        }

        if (options.identityHook) {
          setIdentityHookCommand(options.identityHook)
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
        if (isIdentityHookConfigured()) {
          cliLogger.log(
            'Identity hook enabled: access and capabilities come from the hook, not Discord roles',
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
        if (options.noAnalytics) {
          cliLogger.log('--no-analytics is a no-op: Roadie no longer sends product analytics')
        }
        if (opencodeHostname) {
          cliLogger.log(`OpenCode server hostname: ${opencodeHostname}`)
        }
        if (opencodePort !== undefined) {
          cliLogger.log(`OpenCode server port: ${opencodePort}`)
        }

        if (options.gateway) {
          cliLogger.error(
            '--gateway is not supported: Roadie runs your own Discord bot. Remove the flag and set ROADIE_BOT_TOKEN or run the setup wizard.',
          )
          process.exit(EXIT_NO_RESTART)
        }

        if (options.installUrl) {
          await printDiscordInstallUrlAndExit()
        }

        // Plugins register their hooks before anything reads them.
        const plugins = await loadPlugins(resolvePluginSpecs(options.plugin))
        if (plugins instanceof Error) {
          cliLogger.error(plugins.message)
          process.exit(EXIT_NO_RESTART)
        }
        const backend = resolveAgentBackendProvider()
        if (backend.id !== 'opencode') {
          cliLogger.log(`Agent backend: ${backend.id}`)
        }

        // Single-instance enforcement is handled by the hrana server binding the lock port.
        // startHranaServer() in run() evicts any existing instance before binding.
        await run({
          restartOnboarding: options.restartOnboarding,
          addChannels: options.addChannels,
          dataDir: options.dataDir,
        })
      } catch (error) {
        cliLogger.error('Unhandled error:', formatErrorWithStack(error))
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

cli.use(botCommands)
cli.use(miscCommands)
cli.use(sendCommands)
cli.use(taskCommands)
cli.use(projectCommands)
cli.use(threadCommands)
cli.use(userCommands)
cli.use(sessionCommands)
cli.use(maintenanceCommands)

cli.version(getCurrentVersion())
cli.help()
void cli.parse()
