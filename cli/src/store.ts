// Centralized zustand/vanilla store for global bot state.
// Replaces scattered module-level `let` variables, process.env mutations,
// and mutable arrays with a single immutable state atom.

import { createStore } from 'zustand/vanilla'
import type { VerbosityLevel } from './schema.js'
import type { ThreadRunState } from './session-handler/thread-runtime-state.js'
import {
  parseCredentialPoolsEnabled,
  parseCredentialsMode,
  parseThreadBilling,
  type CredentialsMode,
  type ThreadBilling,
} from './credentials/person-pool.js'

// Registered user commands, populated by registerCommands() in cli.ts.
// discordCommandName is the full sanitized Discord slash command name
// (including -cmd or -skill suffix), while name is the original session
// command name (may contain :, /, etc).
export type RegisteredUserCommand = {
  name: string
  discordCommandName: string
  description: string
  source?: 'command' | 'mcp' | 'skill'
}

export type RoadieState = {
  // ── Config state (set once at CLI startup, read everywhere) ──────────

  // Path to the roadie data directory (default ~/.roadie).
  // Changes: set once at startup by setDataDir() or auto-created on first
  // getDataDir() call. Under vitest, auto-creates a temp dir.
  // Read by: database paths, heap snapshot dir, log file path, hrana server.
  dataDir: string | null

  // Default output verbosity for sessions when no channel-level override
  // exists in the DB. Controls which tool outputs are shown in Discord.
  // Changes: set once at startup from --verbosity CLI flag.
  // Read by: database.ts (fallback in getChannelVerbosity), message formatting.
  defaultVerbosity: VerbosityLevel

  // When true, the bot only responds to messages that @mention it in text
  // channels (threads are unaffected). Fallback when no channel override in DB.
  // Changes: set once at startup from --mention-mode CLI flag.
  // Read by: native chat guards when no channel policy is configured.
  defaultMentionMode: boolean


  // Whether final session footers mention the thread creator.
  // Changes: set once at startup from --enable-footer-mentions (default off).
  // Read by: ThreadSessionRuntime.emitFooter().
  footerMentionsEnabled: boolean


  // Which mention types the bot is allowed to trigger in messages.
  // Maps directly to Discord's allowedMentions.parse array.
  // Valid values: 'users', 'roles', 'everyone'.
  // Changes: set once at startup from --allow-mention CLI flag.
  // Read by: discord-bot.ts (Client constructor default), cli-runner.ts (raw REST calls).
  allowedMentions: Array<'users' | 'roles' | 'everyone'>

  // When true, all Discord users can start sessions and use commands without
  // needing the Roadie role, Administrator, Manage Server, or being the owner.
  // The "no-roadie" role still blocks access even when this is enabled.
  // Changes: set once at startup from --allow-all-users CLI flag.
  // Read by: discord-utils.ts hasRoadieBotPermission().
  allowAllUsers: boolean

  // When true, the agent may only touch the session working directory and a
  // small set of known-safe paths; anything else triggers an external_directory
  // permission prompt. When false (default), every directory is allowed and the
  // user is expected to add their own `deny`/`ask` rules in opencode.json for
  // folders they want to protect.
  // Changes: set once at startup from --restrict-directories CLI flag.
  // Read by: permission-policy.ts (external directory checks).
  restrictExternalDirectories: boolean

  // Permission button TTL in milliseconds. When a permission prompt is shown
  // in Discord, buttons remain active for this duration before auto-rejecting.
  // Defaults to 10 minutes. A timeout rejection lets the model continue
  // (try alternatives or explain it couldn't proceed).
  // Changes: set once at startup from --permission-timeout-minutes CLI flag.
  // Read by: commands/permissions.ts showPermissionButtons().
  permissionTimeoutMs: number

  // Whether background auto-upgrade of roadie is enabled on startup.
  // When true (default), roadie checks npm for a newer version and installs
  // it in the background. Set to false via --no-auto-upgrade CLI flag.
  // Changes: set once at startup.
  // Read by: cli-runner.ts run() before calling backgroundUpgradeRoadie().
  autoUpgradeEnabled: boolean


  // Whether credential pools are enabled: pool store under
  // <dataDir>/credentials/, the roadie provider (roadie/<rotation> models),
  // and the Pi messages proxy. Also gates the /credentials
  // commands. On by default since phase 4a; disable with
  // --no-credential-pools or ROADIE_CREDENTIAL_POOLS=0 to fall back to Pi's
  // own agent-dir auth.json, managed with `pi` on the host.
  // Changes: set once at startup.
  // Read by: command registration, interaction-handler.ts, session runtime.
  credentialPoolsEnabled: boolean

  // How LLM requests are routed to credential pools (credential pools phase
  // 2a): `global` bills everything to the shared pool (today's behavior),
  // `per-person` bills each session to its owner's pool, and
  // `per-person-fallback` tries the owner's pool first, then shared. Only
  // read when credentialPoolsEnabled is on. Opt-in via --credentials or
  // ROADIE_CREDENTIALS; default global.
  // Changes: set once at startup.
  // Read by: credential pool routing.
  credentialsMode: CredentialsMode

  // Who pays for a thread in per-person modes: `owner` bills every turn to
  // the session owner, `speaker` bills each turn to whoever sent it. Opt-in
  // via --thread-billing or ROADIE_THREAD_BILLING; default owner.
  // Changes: set once at startup.
  // Read by: per-turn credential pool attribution.
  threadBilling: ThreadBilling

  // Unprivileged user that agent tool shells run as (opt-in shell isolation,
  // phase 3 step 2). When set, the Pi backend generates a setpriv + env -i
  // wrapper under <dataDir>/bin/isolated-shell/bash and sets Pi's shellPath
  // to it, so bash tool calls run as this user
  // with an allowlisted environment. Null (default, --isolate-shells unset)
  // keeps today's behavior: shells run as the bot's own OS user and SHELL is
  // unchanged.
  // Changes: set once at startup from --isolate-shells or
  // ROADIE_ISOLATE_SHELLS.
  // Read by: agent-backend/registry.ts and the Pi backend.
  isolateShellsUser: string | null

  // Base URL for Discord REST API calls (default https://discord.com).
  // Changes: overridden only by tests that point Roadie at a mock Discord.
  // Read by: discord-urls.ts (getDiscordRestApiUrl), REST client construction.
  discordBaseUrl: string

  // Extra agent tool-shell variables from --shell-env / ROADIE_SHELL_ENV
  // (turn-attribution-env.ts): variable name → template over session fields.
  // Validated at startup (invalid names or unknown template fields stop the
  // bot). Empty when nothing is configured.
  // Changes: set once at startup from --shell-env and ROADIE_SHELL_ENV.
  // Read by: the Pi backend options (registry.ts).
  shellEnvTemplates: Record<string, string>

  // Service auth token (client_id:client_secret) used to authenticate
  // control-plane requests like /roadie/wake. Always set at startup in all
  // modes so localhost and internet paths share one auth model.
  // Changes: set in cli.ts after credential resolution and persisted in sqlite.
  // Read by: hrana-server.ts to validate Authorization bearer token.
  gatewayToken: string | null

  // User-defined slash commands registered with Discord, populated after
  // registerCommands() completes during startup. Maps sanitized Discord
  // command names back to original session command names.
  // Changes: set once during startup after Discord API registration.
  // Read by: user-command handler dispatch and /command detection.
  registeredUserCommands: RegisteredUserCommand[]

  // ── Per-thread runtime state ────────────────────────────────────────
  // The main mutable state at runtime. One ThreadRunState per active thread.
  // All mutations are immutable: each updateThread() creates a new Map + new
  // ThreadRunState object via store.setState(). See thread-runtime-state.ts.
  // Changes: on every message enqueue, prompt dispatch, phase transition,
  // abort, and finish.
  // Read by: runtime state helpers (isRunActive, canDispatchNext), session
  // orchestration in ThreadSessionRuntime, /abort and /queue via runtime APIs.
  threads: Map<string, ThreadRunState>
}

export const store = createStore<RoadieState>(() => ({
  dataDir: null,
  defaultVerbosity: 'text_and_essential_tools',
  defaultMentionMode: false,
  footerMentionsEnabled: false,
  allowedMentions: ['users'],
  allowAllUsers: false,
  restrictExternalDirectories: false,
  permissionTimeoutMs: 10 * 60 * 1000,
  autoUpgradeEnabled: true,
  credentialPoolsEnabled: parseCredentialPoolsEnabled(process.env.ROADIE_CREDENTIAL_POOLS),
  credentialsMode: parseCredentialsMode(process.env.ROADIE_CREDENTIALS),
  threadBilling: parseThreadBilling(process.env.ROADIE_THREAD_BILLING),
  isolateShellsUser: process.env.ROADIE_ISOLATE_SHELLS?.trim() || null,
  discordBaseUrl: 'https://discord.com',
  shellEnvTemplates: {},
  gatewayToken: null,
  registeredUserCommands: [],
  threads: new Map(),
}))
