// OpenCode single-server process manager.
//
// Architecture: ONE opencode serve process shared by all project directories.
// Each SDK client uses the x-opencode-directory header to scope requests to a
// specific project. The server lazily creates and caches an Instance per unique
// directory path internally.
//
// Permission layering — READ THIS BEFORE ADDING A PERMISSION RULE.
//
// opencode evaluates permissions with findLast() over a flattened list, so the
// last matching rule wins. The order is:
//
//   opencode built-in defaults
//     ▼
//   merged config files  ── roadie's generated config, THEN the user's
//     ▼                     project opencode.json (deep-merged on top)
//   config.agent.<name>.permission
//     ▼
//   session.permission   ── resolveSessionPermissionRules() (permission-policy.ts), always wins
//
// Directory ALLOW rules therefore belong in the generated server config, never
// in session rules or an agent block: a project opencode.json must still be
// able to `deny` or `ask` for specific folders. Anything placed in
// session.permission silently overrides the user.
//
// external_directory is `{ '*': 'allow' }` by default. opencode's own default
// is `ask`, which meant the agent had to interrupt the user for ordinary reads
// outside the project, and an unanswered prompt was auto-rejected on TTL. Users
// who want stricter behaviour add `deny`/`ask` rules to their own
// opencode.json, or start roadie with --restrict-directories.
//
// session.permission carries exactly one thing: the worktree original-checkout
// deny, which must beat user config on purpose.
//
// Uses errore for type-safe error handling.

import { recordAgentServerPid, clearAgentServerPid } from './service-lifecycle.js'
import { stopOwnedChild } from './owned-process.js'
import { createBoundedLogFile } from './bounded-log-file.js'
import {
  PROCESS_GROUP_SPAWN_OPTIONS,
  signalProcessGroup,
  terminateProcessGroup,
} from './process-group.js'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { applyFiltersAsync } from './hooks.js'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import {
  createOpencodeClient,
  type OpencodeClient,
  type Config as SdkConfig,
} from '@opencode-ai/sdk/v2'

import {
  restartGlobalEventListener,
  waitForGlobalEventListener,
} from './session-handler/global-event-listener.js'
import {
  getDataDir,
  getLockPort,
  getRestrictExternalDirectories,
  getOpencodeHostname,
  getOpencodePort,
} from './config.js'
import { store } from './store.js'
import { getHranaUrl } from './hrana-server.js'
import { ensureAgentTokenSecret } from './agent-token.js'
import { ensureIsolatedShellWrapper } from './isolated-shell.js'

export function resolveSubrouterPluginSpec({ isDev }: { isDev: boolean }) {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@subrouter/opencode')
  if (isDev) return pathToFileURL(entry).href

  const packageJsonPath = require.resolve('@subrouter/opencode/package.json')
  const version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
  if (typeof version !== 'string' || !version) {
    throw new Error(`Missing @subrouter/opencode version in ${packageJsonPath}`)
  }
  return `@subrouter/opencode@${version}`
}

/**
 * Plugins the OpenCode server loads: Roadie's own plugin, plus subrouter for
 * subscription rotation (subrouter/<preset> models) unless disabled. npm
 * identity for subrouter lets opencode dedupe a user-installed copy.
 */
export function buildServerPluginList({
  isDev,
  subrouterEnabled,
}: {
  isDev: boolean
  subrouterEnabled: boolean
}): string[] {
  return [
    new URL(
      isDev ? './roadie-opencode-plugin.ts' : './roadie-opencode-plugin.js',
      import.meta.url,
    ).href,
    ...(subrouterEnabled ? [resolveSubrouterPluginSpec({ isDev })] : []),
  ]
}

export type RoadiePoolProviderConfig = {
  name: string
  npm: string
  options: Record<string, string>
  models: Record<string, { name: string; tool_call: boolean }>
}

/**
 * OpenCode provider entry for credential pools: one model per rotation named
 * in the shared pool (model id = rotation name, e.g. `roadie/default`). The
 * npm module URL loads cli/src/credentials/provider.ts, which resolves the
 * pool account per request. Returns null when credential pools are disabled
 * or the shared pool has no usable rotation, so the generated config stays
 * byte-for-byte unchanged with the flag off.
 */
export async function buildRoadiePoolProviderConfig({
  dataDir,
  isDev,
  baseURL,
}: {
  dataDir: string
  isDev: boolean
  baseURL?: string
}): Promise<RoadiePoolProviderConfig | null> {
  const rotations = readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })
  if (rotations instanceof Error) return null
  const rotationNames = Object.keys(rotations)
    .filter((name) => (rotations[name]?.length ?? 0) > 0)
    .sort()
  if (rotationNames.length === 0) return null
  const models: RoadiePoolProviderConfig['models'] = {}
  for (const name of rotationNames) {
    models[name] = { name: `Roadie pool ${name}`, tool_call: true }
  }
  return {
    name: 'Roadie credential pool',
    npm: new URL(
      isDev ? './credentials/provider.ts' : './credentials/provider.js',
      import.meta.url,
    ).href,
    options: { ...(baseURL && { baseURL }) },
    models,
  }
}

// SDK Config type is simplified; opencode accepts nested permission objects with path patterns
type PermissionAction = 'ask' | 'allow' | 'deny'
type PermissionRule = PermissionAction | Record<string, PermissionAction>
type Config = Omit<SdkConfig, 'permission'> & {
  permission?: {
    edit?: PermissionRule
    bash?: PermissionRule
    external_directory?: PermissionRule
    webfetch?: PermissionRule
    [key: string]: PermissionRule | undefined
  }
}
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'
import {
  DirectoryNotAccessibleError,
  ServerStartError,
  ServerNotReadyError,
  FetchError,
  OpencodeIncompatibleVersionError,
  type OpenCodeErrors,
} from './errors.js'
import {
  ensureRoadieCommandShim,
  getIncompatibleOpencodeVersionError,
  getPathEnvKey,
  getSpawnCommandAndArgs,
  prependPathEntry,
  selectResolvedCommand,
} from './opencode-command.js'
import { execAsync } from './exec-async.js'
import { computeSkillPermission } from './skill-filter.js'
import { readPoolRotations, SHARED_POOL_ID } from './credentials/store.js'
import {
  CREDENTIAL_POOLS_ENV,
} from './credential-pools-plugin.js'
import {
  CREDENTIALS_MODE_ENV,
  THREAD_BILLING_ENV,
} from './credentials/person-pool.js'
import { ROADIE_PROVIDER_ID, SUBROUTER_ALIAS_ENV, SUBROUTER_ALIAS_PROVIDER_ID } from './credentials/provider.js'
import { hasSubrouterHandoff } from './credentials/migrate-subrouter.js'

const opencodeLogger = createLogger(LogPrefix.OPENCODE)

/**
 * Pure server config for `opencode serve`, written to
 * <dataDir>/opencode-config.json and passed via OPENCODE_CONFIG. Extracted so
 * tests can assert the generated shape, including that credential pools are
 * absent (flag off) or present (flag on) without spawning a server.
 */
export function buildOpencodeServerConfig({
  externalDirectoryPermissions,
  skillPermission,
  pluginList,
  roadiePoolProvider,
  subrouterAlias = false,
}: {
  externalDirectoryPermissions: Record<string, 'ask' | 'allow' | 'deny'>
  skillPermission: ReturnType<typeof computeSkillPermission>
  pluginList: string[]
  roadiePoolProvider: RoadiePoolProviderConfig | null
  /** Serve `subrouter/<rotation>` from the pool after the subrouter handoff. */
  subrouterAlias?: boolean
}) {
  return {
    $schema: 'https://opencode.ai/config.json',
    // Git snapshots of the working tree on every step only served undo/redo,
    // which Roadie does not offer. Skipping them saves disk and CPU per turn.
    snapshot: false,
    lsp: false,
    formatter: false,
    plugin: pluginList,
    permission: {
      edit: 'allow',
      bash: 'allow',
      external_directory: externalDirectoryPermissions,
      webfetch: 'allow',
      ...(skillPermission && { skill: skillPermission }),
    },
    agent: {
      explore: {
        permission: {
          '*': 'deny',
          grep: 'allow',
          glob: 'allow',
          list: 'allow',
          read: {
            '*': 'allow',
            '*.env': 'deny',
            '*.env.*': 'deny',
            '*.env.example': 'allow',
          },
          webfetch: 'allow',
          websearch: 'allow',
          codesearch: 'allow',
          // No external_directory here on purpose. opencode composes agents as
          // merge(defaults, agentSpecific, userConfig) and then appends
          // config.agent.<name>.permission LAST, so anything set here would beat
          // the user's own top-level opencode.json rules. The top-level
          // permission block above already covers this agent.
        },
      },
    },
    // When a permission prompt times out and is auto-rejected, the model sees
    // the rejection as a tool error and continues working (tries alternatives
    // or explains it couldn't proceed) instead of the session going dead.
    experimental: {
      continue_loop_on_deny: true,
    },
    provider: {
      xai: {
        models: {
          'grok-composer-2.5-fast': {
            name: 'Grok Composer 2.5 Fast',
            attachment: true,
            tool_call: true,
            limit: {
              context: 256000,
              output: 256000,
            },
            cost: {
              input: 0.50,
              output: 2.50,
              cache_read: 0.20,
            },
          },
        },
      },
      ...(roadiePoolProvider && { [ROADIE_PROVIDER_ID]: roadiePoolProvider }),
      ...(roadiePoolProvider && subrouterAlias && {
        [SUBROUTER_ALIAS_PROVIDER_ID]: { ...roadiePoolProvider, name: 'Roadie credential pool (subrouter names)' },
      }),
    },
  } satisfies Config
}

/**
 * Build Basic auth headers from OPENCODE_SERVER_PASSWORD env var.
 * Returns empty object when no password is set.
 */
export function getOpencodeServerAuthHeaders(): Record<string, string> {
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD
  if (!serverPassword) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  const encoded = Buffer.from(`${username}:${serverPassword}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

export function publicOpencodeBindRequiresPassword({
  hostname,
}: {
  hostname: string | null | undefined
}): boolean {
  if (!hostname) return false
  return !LOOPBACK_HOSTNAMES.has(hostname)
}

// Always pass --hostname so opencode.json server.hostname / mdns cannot bind 0.0.0.0.
const DEFAULT_OPENCODE_HOSTNAME = '127.0.0.1'

/** OpenCode server log lines below WARN go here (in the data dir), not roadie.log. */
export const OPENCODE_SERVER_LOG_FILE = 'opencode-server.log'
const OPENCODE_SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024
const OPENCODE_LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const
type OpencodeLogLevel = (typeof OPENCODE_LOG_LEVELS)[number]

/**
 * Level the OpenCode server logs at. INFO by default so the reason for a
 * cancelled run (an abort request, an instance disposal) is on record.
 * Override with ROADIE_OPENCODE_LOG_LEVEL.
 */
export function getOpencodeLogLevel(env: NodeJS.ProcessEnv = process.env): OpencodeLogLevel {
  const value = env.ROADIE_OPENCODE_LOG_LEVEL?.trim().toUpperCase()
  return OPENCODE_LOG_LEVELS.find((level) => level === value) ?? 'INFO'
}

const VERBOSE_SERVER_LOG_LINE = /^timestamp=\S+ level=(?:INFO|DEBUG)\b/

/** Structured OpenCode log lines below WARN, which stay out of roadie.log. */
export function isVerboseOpencodeLogLine(line: string): boolean {
  return VERBOSE_SERVER_LOG_LINE.test(line)
}

export function buildOpencodeServeArgs({
  port,
  hostname,
  logLevel = getOpencodeLogLevel(),
}: {
  port: number
  hostname?: string | null
  logLevel?: OpencodeLogLevel
}): string[] {
  return [
    'serve',
    '--port',
    port.toString(),
    '--hostname',
    hostname || DEFAULT_OPENCODE_HOSTNAME,
    '--print-logs',
    '--log-level',
    logLevel,
  ]
}

// Tracks directories that have been initialized, to avoid repeated log spam.
const initializedDirectories = new Set<string>()

const STARTUP_STDERR_TAIL_LIMIT = 30
const STARTUP_STDERR_LINE_MAX_LENGTH = 120
const STARTUP_ERROR_REASON_MAX_LENGTH = 1500
const ANSI_ESCAPE_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export async function requestHealthcheck({
  url,
  timeoutMs = 2000,
}: {
  url: string
  timeoutMs?: number
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | null = null
    const settle = (
      handler: () => void,
    ) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      handler()
    }

    const req = http.request(
      url,
      {
        method: 'GET',
        headers: {
          connection: 'close',
          ...getOpencodeServerAuthHeaders(),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          settle(() => {
            resolve({
              status: res.statusCode || 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          })
        })
        res.on('error', (error) => {
          settle(() => reject(error))
        })
      },
    )
    req.on('error', (error) => {
      settle(() => reject(error))
    })
    timeout = setTimeout(() => {
      settle(() => {
        req.destroy()
        reject(new Error(`Health check request timed out after ${timeoutMs}ms`))
      })
    }, timeoutMs)
    req.end()
  })
}

function truncateWithEllipsis({
  value,
  maxLength,
}: {
  value: string
  maxLength: number
}): string {
  if (maxLength <= 3) {
    return value.slice(0, maxLength)
  }
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 3)}...`
}

function stripAnsiCodes(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_REGEX, '')
}

function sanitizeOutputLine(line: string): string {
  return stripAnsiCodes(line).trim()
}

function sanitizeForCodeFence(line: string): string {
  return line.replaceAll('```', '`\u200b``')
}

function pushStartupStderrTail({
  stderrTail,
  line,
}: {
  stderrTail: string[]
  line: string
}): void {
  const sanitizedLine = sanitizeOutputLine(line)
  if (sanitizedLine.length === 0) {
    return
  }

  const truncatedLine = truncateWithEllipsis({
    value: sanitizeForCodeFence(sanitizedLine),
    maxLength: STARTUP_STDERR_LINE_MAX_LENGTH,
  })

  stderrTail.push(truncatedLine)
  if (stderrTail.length > STARTUP_STDERR_TAIL_LIMIT) {
    stderrTail.splice(0, stderrTail.length - STARTUP_STDERR_TAIL_LIMIT)
  }
}

function subscribeToProcessLogStream({
  stream,
  onLine,
}: {
  stream: NodeJS.ReadableStream | null | undefined
  onLine: (line: string) => void
}): readline.Interface | null {
  if (!stream) {
    return null
  }

  const logReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  logReader.on('line', (line) => {
    const sanitizedLine = sanitizeOutputLine(line)
    if (sanitizedLine.length === 0) {
      return
    }
    onLine(sanitizedLine)
  })

  return logReader
}

function buildStartupTimeoutReason({
  maxAttempts,
  stderrTail,
}: {
  maxAttempts: number
  stderrTail: string[]
}): string {
  const timeoutSeconds = Math.round((maxAttempts * 100) / 1000)
  const baseReason = `Server did not start after ${timeoutSeconds} seconds`
  if (stderrTail.length === 0) {
    return baseReason
  }

  const formatReason = ({
    lines,
    omitted,
  }: {
    lines: string[]
    omitted: number
  }): string => {
    const omittedLine =
      omitted > 0
        ? `[... ${omitted} older stderr lines omitted to fit Discord ...]\n`
        : ''
    const stderrCodeBlock = `${omittedLine}${lines.join('\n')}`
    return `${baseReason}\nLast opencode stderr lines:\n\`\`\`text\n${stderrCodeBlock}\n\`\`\``
  }

  let lines = [...stderrTail]
  let omitted = 0
  let formattedReason = formatReason({ lines, omitted })

  while (
    formattedReason.length > STARTUP_ERROR_REASON_MAX_LENGTH &&
    lines.length > 0
  ) {
    lines = lines.slice(1)
    omitted += 1
    formattedReason = formatReason({ lines, omitted })
  }

  return truncateWithEllipsis({
    value: formattedReason,
    maxLength: STARTUP_ERROR_REASON_MAX_LENGTH,
  })
}

// ── Single server state ──────────────────────────────────────────
// One opencode serve process, shared by all project directories.
// Clients are created per-directory with the x-opencode-directory header.

type SingleServer = {
  process: ChildProcess | null
  port: number
  baseUrl: string
  /** True when this server was discovered from the bot's hrana endpoint,
   *  not spawned by this process. We must not kill it on cleanup. */
  discovered?: boolean
}

type ServerLifecycleEvent =
  | { type: 'started'; port: number }
  | { type: 'stopped' }

let singleServer: SingleServer | null = null
let serverRetryCount = 0
const serverLifecycleListeners = new Set<(event: ServerLifecycleEvent) => void>()
let processCleanupHandlersRegistered = false
let startingServerProcess: ChildProcess | null = null
const clientCache = new Map<string, OpencodeClient>()

function notifyServerLifecycle(event: ServerLifecycleEvent): void {
  for (const listener of serverLifecycleListeners) {
    listener(event)
  }
}

export function subscribeOpencodeServerLifecycle(
  listener: (event: ServerLifecycleEvent) => void,
): () => void {
  serverLifecycleListeners.add(listener)
  return () => {
    serverLifecycleListeners.delete(listener)
  }
}

function killSingleServerProcessNow({
  reason,
}: {
  reason: string
}): void {
  if (!singleServer) {
    return
  }

  // Never kill a server we didn't spawn (discovered from another process)
  if (singleServer.discovered || !singleServer.process) {
    return
  }

  const serverProcess = singleServer.process
  const pid = serverProcess.pid
  if (!pid || serverProcess.killed) {
    return
  }

  const killResult = errore.try(
    { try: () => {
      signalProcessGroup(pid, 'SIGTERM')
    }, catch: (error) => {
      return new Error('Failed to send SIGTERM to opencode server', {
        cause: error,
      })
    } },
  )

  if (killResult instanceof Error) {
    opencodeLogger.warn(
      `[cleanup:${reason}] ${killResult.message} (pid: ${pid}, port: ${singleServer.port})`,
    )
    return
  }

  opencodeLogger.log(
    `[cleanup:${reason}] Sent SIGTERM to opencode server (pid: ${pid}, port: ${singleServer.port})`,
  )
}

function killStartingServerProcessNow({
  reason,
}: {
  reason: string
}): void {
  const serverProcess = startingServerProcess
  if (!serverProcess) {
    return
  }

  const pid = serverProcess.pid
  if (!pid || serverProcess.killed) {
    return
  }

  const killResult = errore.try(
    { try: () => {
      signalProcessGroup(pid, 'SIGTERM')
    }, catch: (error) => {
      return new Error('Failed to send SIGTERM to starting opencode server', {
        cause: error,
      })
    } },
  )

  if (killResult instanceof Error) {
    opencodeLogger.warn(
      `[cleanup:${reason}] ${killResult.message} (pid: ${pid})`,
    )
    return
  }

  opencodeLogger.log(
    `[cleanup:${reason}] Sent SIGTERM to starting opencode server (pid: ${pid})`,
  )
}

function ensureProcessCleanupHandlersRegistered(): void {
  if (processCleanupHandlersRegistered) {
    return
  }
  processCleanupHandlersRegistered = true

  opencodeLogger.log('Registering process cleanup handlers for opencode server')

  process.on('exit', () => {
    killSingleServerProcessNow({ reason: 'process-exit' })
    killStartingServerProcessNow({ reason: 'process-exit' })
  })

  // Fallback for CLI subcommands without their own signal handling. Any signal
  // listener disables Node's default exit, so if we are the only listener we
  // must exit ourselves. Otherwise the process ignores Ctrl+C and, in the bot,
  // keeps holding the hrana lock port. If another owner exists (the bot
  // lifecycle handlers, a subcommand), it decides when to exit.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      killSingleServerProcessNow({ reason: signal.toLowerCase() })
      killStartingServerProcessNow({ reason: signal.toLowerCase() })
      if (process.listenerCount(signal) > 1) {
        return
      }
      process.exit(128 + os.constants.signals[signal])
    })
  }
}

// ── Resolve opencode binary ──────────────────────────────────────
// Resolve the full path to the opencode binary so we can spawn without
// shell: true. Using shell: true creates an intermediate sh process — when
// cleanup sends SIGTERM it only kills the shell, leaving the actual opencode
// process orphaned (reparented to PID 1). Resolving the path upfront lets
// us spawn the binary directly and SIGTERM reaches the right process.
//
// Resolution order:
// 1. OPENCODE_PATH env var (explicit user override)
// 2. `which opencode` / `where opencode` (system PATH)
// 3. Fall back to bare "opencode" (spawn will fail with a clear error)
//
// OpenCode must be installed globally before running roadie. The bot startup
// checks for it via ensureCommandAvailable and prompts to install if missing.

let resolvedOpencodeCommand: string | null = null

export function resolveOpencodeCommand(): string {
  if (resolvedOpencodeCommand) {
    return resolvedOpencodeCommand
  }

  const envPath = process.env.OPENCODE_PATH
  if (envPath) {
    const resolvedFromEnv = selectResolvedCommand({
      output: envPath,
      isWindows: process.platform === 'win32',
    })
    if (resolvedFromEnv) {
      resolvedOpencodeCommand = resolvedFromEnv
      return resolvedFromEnv
    }
  }

  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where' : 'which'
  const result = errore.try(
    { try: () => {
      const commandOutput = execFileSync(whichCmd, ['opencode'], {
        encoding: 'utf8',
        timeout: 5000,
      })
      const resolved = selectResolvedCommand({
        output: commandOutput,
        isWindows,
      })
      if (resolved) {
        return resolved
      }
      throw new Error('opencode not found in PATH')
    }, catch: () => new Error('opencode not found in PATH') },
  )

  if (result instanceof Error) {
    // Fall back to bare command name — spawn will fail with a clear error
    // if it can't find the binary.
    opencodeLogger.warn('Could not resolve opencode path via which, falling back to "opencode"')
    return 'opencode'
  }

  resolvedOpencodeCommand = result
  opencodeLogger.log(`Resolved opencode binary: ${result}`)
  return result
}

export async function assertCompatibleOpencodeVersion({
  resolvedCommand = resolveOpencodeCommand(),
}: {
  resolvedCommand?: string
} = {}): Promise<OpencodeIncompatibleVersionError | true> {
  const { command, args } = getSpawnCommandAndArgs({
    resolvedCommand,
    baseArgs: ['--version'],
  })
  const result = await execAsync(
    { command, args },
    { timeout: 5000, encoding: 'utf8' },
  ).catch((cause) => {
    return new Error('Failed to read OpenCode version', { cause })
  })
  if (result instanceof Error) {
    opencodeLogger.warn(result.message)
    return true
  }
  const incompatible = getIncompatibleOpencodeVersionError(
    `${result.stdout}\n${result.stderr}`,
  )
  if (incompatible) return incompatible
  return true
}
async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => {
          resolve(port)
        })
      } else {
        reject(new Error('Failed to get port'))
      }
    })
    server.on('error', reject)
  })
}

async function waitForServer({
  port,
  directory,
  maxAttempts = 300,
  startupStderrTail,
}: {
  port: number
  directory?: string
  maxAttempts?: number
  startupStderrTail: string[]
}): Promise<ServerStartError | true> {
  const endpoint = new URL(`http://127.0.0.1:${port}/api/health`)
  if (directory) {
    endpoint.searchParams.set('directory', directory)
  }
  for (let i = 0; i < maxAttempts; i++) {
    const response = await requestHealthcheck({ url: endpoint.toString() })
      .catch((e) => new FetchError({ url: endpoint.toString(), cause: e }))
    if (response instanceof Error) {
      // Connection refused or other transient errors - continue polling.
      // Use 100ms interval instead of 1s so we detect readiness faster.
      // Critical for scale-to-zero cold starts where every ms matters.
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    if (response.status < 500) {
      return true
    }
    const body = response.body
    // Fatal errors that won't resolve with retrying
    if (body.includes('BunInstallFailedError')) {
      return new ServerStartError({ port, reason: body.slice(0, 200) })
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return new ServerStartError({
    port,
    reason: buildStartupTimeoutReason({
      maxAttempts,
      stderrTail: startupStderrTail,
    }),
  })
}

// ── Single server lifecycle ──────────────────────────────────────
// The server is started lazily on first initializeOpencodeForDirectory() call.
// It uses permissive defaults (edit: allow, bash: allow, webfetch: allow, and
// external_directory: '*' allow unless --restrict-directories is set).

// In-flight promise to prevent concurrent startups from racing
let startingServer: Promise<
  ServerStartError | OpencodeIncompatibleVersionError | SingleServer
> | null = null
let preferredStartupDirectory: string | null = null

function ensureOpencodeHomeDirectories({
  directories,
}: {
  directories: Record<string, string>
}) {
  Object.values(directories).map((directory) => {
    fs.mkdirSync(directory, { recursive: true })
  })
}

/**
 * Try to discover an OpenCode server already running in the bot process.
 * Queries the hrana server on the lock port for the OpenCode server port,
 * then verifies the server is healthy. Returns null if no server found.
 */
async function discoverExistingServer(): Promise<SingleServer | null> {
  const lockPort = getLockPort()
  try {
    const portResponse = await requestHealthcheck({
      url: `http://127.0.0.1:${lockPort}/roadie/opencode-port`,
      timeoutMs: 2000,
    })
    if (portResponse.status !== 200) {
      return null
    }
    const parsed = JSON.parse(portResponse.body)
    const port = parsed?.port
    if (typeof port !== 'number') {
      return null
    }

    // Verify the OpenCode server is actually healthy
    const healthResponse = await requestHealthcheck({
      url: `http://127.0.0.1:${port}/api/health`,
      timeoutMs: 2000,
    })
    if (healthResponse.status >= 500) {
      return null
    }

    opencodeLogger.log(
      `Discovered existing OpenCode server on port ${port} via hrana lock port ${lockPort}`,
    )
    return {
      process: null,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      discovered: true,
    }
  } catch {
    // Connection refused or other network error — no bot running
    return null
  }
}

async function ensureSingleServer({
  directory,
}: {
  directory?: string
} = {}): Promise<ServerStartError | OpencodeIncompatibleVersionError | SingleServer> {
  const startupDirectory = directory || preferredStartupDirectory || undefined
  if (singleServer && !singleServer.process?.killed) {
    return singleServer
  }

  // Deduplicate concurrent startup attempts (covers both discovery and spawn)
  if (startingServer) {
    return startingServer
  }

  // Wrap discovery + spawn in a single shared promise so concurrent callers
  // don't each run discoverExistingServer() and then each spawn a server.
  startingServer = (async () => {
    // Try to discover an already-running server from the bot process via
    // the hrana server's /roadie/opencode-port endpoint. This lets CLI
    // subcommands (roadie session list, archive, wait, etc.) reuse the
    // bot's OpenCode server instead of spawning a redundant one.
    const discovered = await discoverExistingServer()
    if (discovered) {
      singleServer = discovered
      return discovered
    }

    const compatibility = await assertCompatibleOpencodeVersion()
    if (compatibility instanceof Error) return compatibility

    return startSingleServer({ directory: startupDirectory })
  })()

  try {
    return await startingServer
  } finally {
    startingServer = null
  }
}

async function startSingleServer({
  directory,
}: {
  directory?: string
} = {}): Promise<ServerStartError | SingleServer> {
  ensureProcessCleanupHandlersRegistered()

  const configuredPort = getOpencodePort()
  const port = configuredPort ?? (await getOpenPort())
  const hostname = getOpencodeHostname() ?? DEFAULT_OPENCODE_HOSTNAME

  if (
    publicOpencodeBindRequiresPassword({ hostname }) &&
    !process.env.OPENCODE_SERVER_PASSWORD
  ) {
    return new ServerStartError({
      port,
      reason: `OPENCODE_SERVER_PASSWORD is required when --opencode-hostname is ${hostname}`,
    })
  }

  const serveArgs = buildOpencodeServeArgs({ port, hostname })

  const {
    command: spawnCommand,
    args: spawnArgs,
    windowsVerbatimArguments,
  } = getSpawnCommandAndArgs({
    resolvedCommand: resolveOpencodeCommand(),
    baseArgs: serveArgs,
  })

  // Server config uses permissive defaults. By default every external directory
  // is allowed: opencode's own 'ask' default produced constant permission
  // prompts for ordinary reads, and users who want protection can add their own
  // `deny`/`ask` rules in opencode.json (project config is loaded after this
  // file, so it wins).
  // With --restrict-directories the old behaviour comes back: only a small set
  // of known-safe paths is pre-allowed and everything else falls through to the
  // user's opencode.json default (which is 'ask' unless they changed it).
  const externalDirectoryPermissions = buildServerExternalDirectoryPermissions()
  // Opt-in shell isolation (--isolate-shells): OpenCode picks its tool shell
  // from $SHELL, so generate the setpriv + env -i wrapper and point SHELL at
  // it. Fails fast with a clear reason when the bot lacks the privileges or
  // the agent user/binaries are missing. With the flag unset (default) SHELL
  // is inherited unchanged.
  const isolateShellsUser = store.getState().isolateShellsUser
  const shellIsolation = isolateShellsUser
    ? await ensureIsolatedShellWrapper({ dataDir: getDataDir(), username: isolateShellsUser })
    : null
  if (shellIsolation instanceof Error) {
    return new ServerStartError({ port, reason: shellIsolation.message })
  }
  if (shellIsolation) {
    opencodeLogger.log(
      `Shell isolation: tool shells run as ${isolateShellsUser} via ${shellIsolation.shellPath}`,
    )
  }
  const roadieShimDirectory = ensureRoadieCommandShim({
    dataDir: getDataDir(),
    execPath: process.execPath,
    execArgv: process.execArgv,
    entryScript: process.argv[1] || fileURLToPath(new URL('../bin.js', import.meta.url)),
  })
  const pathEnvKey = getPathEnvKey(process.env)
  const pathEnv = roadieShimDirectory instanceof Error
    ? process.env[pathEnvKey]
    : prependPathEntry({
        entry: roadieShimDirectory,
        existingPath: process.env[pathEnvKey],
      })
  if (roadieShimDirectory instanceof Error) {
    opencodeLogger.warn(roadieShimDirectory.message)
  }
  const vitestOpencodeEnv = (() => {
    if (process.env.ROADIE_VITEST !== '1') {
      return {}
    }
    const root = path.join(getDataDir(), 'opencode-vitest-home')
    const directories = {
      OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG_DIR: path.join(root, '.opencode-roadie'),
      XDG_CONFIG_HOME: path.join(root, '.config'),
      XDG_DATA_HOME: path.join(root, '.local', 'share'),
      XDG_CACHE_HOME: path.join(root, '.cache'),
      XDG_STATE_HOME: path.join(root, '.local', 'state'),
    }
    // OpenCode writes state/config files into these XDG locations during boot.
    // In CI, a fresh temp data dir means the parent folders may not exist yet,
    // and some writes fail closed with NotFound before OpenCode has a chance to
    // create them lazily. Pre-create the directories so startup-time tests do
    // not flap based on process scheduling.
    ensureOpencodeHomeDirectories({ directories })
    return directories
  })()

  // Write config to a file instead of passing via OPENCODE_CONFIG_CONTENT env var.
  // OPENCODE_CONFIG (file path) is loaded before project config in opencode's
  // priority chain, so project-level opencode.json can override roadie defaults.
  // OPENCODE_CONFIG_CONTENT was loaded last and overrode user project configs,
  // causing issue #90 (project permissions not being respected).
  const isDev = import.meta.url.endsWith('.ts') || import.meta.url.endsWith('.tsx')
  // Skill whitelist/blacklist from --enable-skill / --disable-skill CLI flags.
  // Applied as opencode permission.skill rules so every agent inherits the
  // filter via Permission.merge(defaults, agentRules, user).
  const skillPermission = computeSkillPermission({
    enabledSkills: store.getState().enabledSkills,
    disabledSkills: store.getState().disabledSkills,
  })
  // Opt-in credential pools (--credential-pools): expose the shared pool's
  // rotations as roadie/<rotation> models backed by the pool provider. Null
  // when disabled, so the generated config is unchanged with the flag off.
  const credentialPoolsEnabled = store.getState().credentialPoolsEnabled
  const subrouterHandedOff = credentialPoolsEnabled && hasSubrouterHandoff({ dataDir: getDataDir() })
  const roadiePoolProvider = credentialPoolsEnabled
    ? await buildRoadiePoolProviderConfig({
        dataDir: getDataDir(),
        isDev,
        baseURL: process.env.ROADIE_CREDENTIAL_POOLS_BASE_URL,
      })
    : null
  if (roadiePoolProvider) {
    opencodeLogger.log(
      `Credential pools enabled: roadie provider models [${Object.keys(roadiePoolProvider.models).join(', ')}]`,
    )
  }
  const opencodeConfig = buildOpencodeServerConfig({
    externalDirectoryPermissions,
    skillPermission,
    // After the subrouter handoff the pool is the only store that may refresh
    // those accounts, so subrouter is not loaded and its model names are served
    // from the pool instead.
    pluginList: buildServerPluginList({
      isDev,
      subrouterEnabled: store.getState().subrouterEnabled && !subrouterHandedOff,
    }),
    roadiePoolProvider,
    subrouterAlias: subrouterHandedOff,
  })
  const runtimeConfig = await applyFiltersAsync('opencode_server_config', opencodeConfig, {})
  if (runtimeConfig instanceof Error) return new ServerStartError({ port, reason: runtimeConfig.message, cause: runtimeConfig })
  const opencodeConfigPath = path.join(getDataDir(), 'opencode-config.json')
  const opencodeConfigJson = JSON.stringify(runtimeConfig, null, 2)
  const existingContent = (() => {
    try {
      return fs.readFileSync(opencodeConfigPath, 'utf-8')
    } catch {
      return ''
    }
  })()
  if (existingContent !== opencodeConfigJson) {
    fs.writeFileSync(opencodeConfigPath, opencodeConfigJson, { mode: 0o600 })
  }
  fs.chmodSync(opencodeConfigPath, 0o600)

  const serverProcess = spawn(
    spawnCommand,
    spawnArgs,
    {
      stdio: 'pipe',
      // Own process group, so stopping the server also stops everything it
      // spawned instead of leaving children writing to the data dir (#88).
      ...PROCESS_GROUP_SPAWN_OPTIONS,
      windowsVerbatimArguments,
      // No project-specific cwd — the server handles all directories via
      // x-opencode-directory header. Use home dir as a neutral working dir.
      cwd: os.homedir(),
      env: {
        ...process.env,
        OPENCODE_CONFIG: opencodeConfigPath,
        OPENCODE_PORT: port.toString(),
        ROADIE: '1',
        // The browser is not on this machine, so no localhost callback fires.
        SUBROUTER_MANUAL_OAUTH: '1',
        OPENCODE_ENABLE_EXA: '1',
        ROADIE_DATA_DIR: getDataDir(),
        ROADIE_LOCK_PORT: getLockPort().toString(),
        ROADIE_PARENT_LOCK_PORT: getLockPort().toString(),
        // Opt-in credential pools: the plugin and provider read this inside
        // the OpenCode process (config.ts state is not available there).
        ...(credentialPoolsEnabled && { [CREDENTIAL_POOLS_ENV]: '1' }),
        ...(subrouterHandedOff && { [SUBROUTER_ALIAS_ENV]: '1' }),
        // Per-person routing (phase 2a): mode and billing for the
        // chat.headers hook. Set only with pools enabled, so the default
        // (global) environment is unchanged.
        ...(credentialPoolsEnabled && {
          [CREDENTIALS_MODE_ENV]: store.getState().credentialsMode,
          [THREAD_BILLING_ENV]: store.getState().threadBilling,
        }),
        // Guard: prevents agents from running `roadie` root command inside
        // an OpenCode session, which would steal the lock port and break the bot.
        ROADIE_OPENCODE_PROCESS: '1',
        ...(getHranaUrl() && { ROADIE_DB_URL: getHranaUrl()! }),
        // The shell.env hook (running in this server process) mints
        // per-session agent tokens for tool shells from this secret and
        // blanks it again in the same env, so shells hold a token bound to
        // their own session instead of the database credentials.
        ROADIE_AGENT_TOKEN_SECRET: ensureAgentTokenSecret(),
        // Opt-in shell isolation: every bash tool call runs as the agent
        // user through the generated wrapper (see isolated-shell.ts).
        ...(shellIsolation && { SHELL: shellIsolation.shellPath }),
        ...(process.env.ROADIE_SENTRY_DSN && {
          ROADIE_SENTRY_DSN: process.env.ROADIE_SENTRY_DSN,
        }),
        ...vitestOpencodeEnv,
        ...(pathEnv && { [pathEnvKey]: pathEnv }),
      },
    },
  )

  startingServerProcess = serverProcess
  if (serverProcess.pid) recordAgentServerPid(serverProcess.pid)

  // Buffer logs until we know if server started successfully.
  const logBuffer: string[] = []
  const startupStderrTail: string[] = []
  let serverReady = false

  logBuffer.push(
    `Spawned opencode ${serveArgs.join(' ')} (pid: ${serverProcess.pid})`,
  )

  const stdoutReader = subscribeToProcessLogStream({
    stream: serverProcess.stdout,
    onLine: (line) => {
      if (!serverReady) {
        logBuffer.push(`[stdout] ${line}`)
        return
      }
      opencodeLogger.log(line)
    },
  })

  const serverLog = createBoundedLogFile({
    filePath: path.join(getDataDir(), OPENCODE_SERVER_LOG_FILE),
    maxBytes: OPENCODE_SERVER_LOG_MAX_BYTES,
  })
  const stderrReader = subscribeToProcessLogStream({
    stream: serverProcess.stderr,
    onLine: (line) => {
      serverLog.append(line)
      if (isVerboseOpencodeLogLine(line)) {
        return
      }
      if (!serverReady) {
        logBuffer.push(`[stderr] ${line}`)
        pushStartupStderrTail({ stderrTail: startupStderrTail, line })
        return
      }
      opencodeLogger.error(line)
    },
  })

  serverProcess.on('error', (error) => {
    logBuffer.push(`Failed to start server on port ${port}: ${error}`)
  })

  serverProcess.on('exit', (code, signal) => {
    stdoutReader?.close()
    stderrReader?.close()
    if (serverProcess.pid) clearAgentServerPid(serverProcess.pid)

    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }

    opencodeLogger.log(
      `Opencode server exited with code: ${code}, signal: ${signal}`,
    )
    singleServer = null
    clientCache.clear()
    notifyServerLifecycle({ type: 'stopped' })

    // Intentional kills should not trigger auto-restart:
    // - SIGTERM from our cleanup/restart code
    // - SIGINT propagated from Ctrl+C (parent process group signal)
    // - any exit during bot shutdown (shuttingDown flag)
    // Only unexpected crashes (non-zero exit without signal) get retried.
    if (serverProcess.killed || signal === 'SIGTERM' || signal === 'SIGINT' || global.shuttingDown) {
      serverRetryCount = 0
      return
    }
    if (code !== 0) {
      if (serverRetryCount < 5) {
        serverRetryCount += 1
        opencodeLogger.log(
          `Restarting server (attempt ${serverRetryCount}/5)`,
        )
        void ensureSingleServer().then(
          (result) => {
            if (result instanceof Error) {
              opencodeLogger.error(`Failed to restart opencode server:`, result)
              void notifyError(result, `OpenCode server restart failed`)
            }
          },
        )
      } else {
        const crashError = new Error(
          `Server crashed too many times (5), not restarting`,
        )
        opencodeLogger.error(crashError.message)
        void notifyError(crashError, `OpenCode server crash loop exhausted`)
      }
    } else {
      serverRetryCount = 0
    }
  })

  const waitResult = await waitForServer({
    port,
    directory,
    startupStderrTail,
  })
  if (waitResult instanceof Error) {
    killStartingServerProcessNow({ reason: 'startup-failed' })
    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }

    // Dump buffered logs on failure
    opencodeLogger.error(`Server failed to start:`)
    for (const line of logBuffer) {
      opencodeLogger.error(`  ${line}`)
    }
    return waitResult
  }
  serverReady = true
  // stopOpencodeServer() may have run while we waited (bot shutdown). Never
  // publish a server that nobody will stop.
  if (global.shuttingDown || serverProcess.killed) {
    killStartingServerProcessNow({ reason: 'stopped-during-startup' })
    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }
    return new ServerStartError({ port, reason: 'stopped during startup' })
  }
  opencodeLogger.log(`Server ready on port ${port}`)

  // Always dump startup logs so plugin loading errors and other startup output
  // are visible in roadie.log.
  for (const line of logBuffer) {
    opencodeLogger.log(line)
  }

  const server: SingleServer = {
    process: serverProcess,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  }
  if (startingServerProcess === serverProcess) {
    startingServerProcess = null
  }
  singleServer = server
  notifyServerLifecycle({ type: 'started', port })
  return server
}

function getOrCreateClient({
  baseUrl,
  directory,
}: {
  baseUrl: string
  directory: string
}): OpencodeClient {
  const cached = clientCache.get(directory)
  if (cached) {
    return cached
  }

  const fetchWithTimeout = (request: Request) =>
    fetch(request, {
      // @ts-ignore
      timeout: false,
    })

  const client = createOpencodeClient({
    baseUrl,
    directory,
    fetch: fetchWithTimeout as typeof fetch,
    headers: getOpencodeServerAuthHeaders(),
  })
  clientCache.set(directory, client)
  return client
}

// ── Public API ───────────────────────────────────────────────────
// Same signatures as before so callers don't need to change.

/**
 * Initialize OpenCode server for a directory.
 * Starts the single shared server if not running, then returns a client
 * factory scoped to the given directory via x-opencode-directory header.
 *
 * @param directory - The project directory to scope requests to
 * @param options.originalRepoDirectory - For worktrees: the original repo directory
 *   (no longer used for server-level permissions — use resolveSessionPermissionRules
 *   at session.create() time instead)
 */
export async function initializeOpencodeForDirectory(
  directory: string,
  _options?: { originalRepoDirectory?: string; channelId?: string },
): Promise<OpenCodeErrors | (() => OpencodeClient)> {
  // Verify directory exists and is accessible
  const accessCheck = errore.tryFn({
    try: () => {
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK)
    },
    catch: () => new DirectoryNotAccessibleError({ directory }),
  })
  if (accessCheck instanceof Error) return accessCheck

  preferredStartupDirectory = directory

  const server = await ensureSingleServer({ directory })
  if (server instanceof Error) return server

  if (!initializedDirectories.has(directory)) {
    initializedDirectories.add(directory)
  }

  return () => {
    if (!singleServer) {
      throw new ServerNotReadyError({ directory })
    }
    return getOrCreateClient({
      baseUrl: singleServer.baseUrl,
      directory,
    })
  }
}

/**
 * Known-safe paths that never need an external_directory prompt, used only when
 * --restrict-directories is active. Without the flag every path is allowed and
 * this list is irrelevant.
 */
function knownSafeExternalDirectories(): string[] {
  const tmpdir = os.tmpdir().replaceAll('\\', '/')
  const homeDirectory = ({ relativePath }: { relativePath: string }) => {
    return path.resolve(os.homedir(), relativePath.replaceAll('\\', '/'))
  }
  return [
    '/tmp',
    '/private/tmp',
    tmpdir,
    // The agent can read the global AGENTS.md and opencode config; the path is
    // visible in the system prompt so models routinely try to open it.
    homeDirectory({ relativePath: '.config/opencode' }),
    // The Anthropic plugin rewrites the name in the system prompt, so some
    // models try this misspelled path instead.
    homeDirectory({ relativePath: '.config/openc0de' }),
    // Cached opensrc checkouts.
    homeDirectory({ relativePath: '.opensrc' }),
    // Roadie data dir (logs, db, etc).
    homeDirectory({ relativePath: '.roadie' }),
    // Prior opencode tool outputs.
    homeDirectory({ relativePath: '.local/share/opencode/tool-output' }),
    // Language toolchain caches, so builds can inspect downloaded modules.
    homeDirectory({ relativePath: '.cache/zig' }),
    homeDirectory({ relativePath: '.cargo' }),
    homeDirectory({ relativePath: '.cache/go-build' }),
    homeDirectory({ relativePath: 'go/pkg' }),
  ]
}

/**
 * Build the server-level `permission.external_directory` value.
 *
 * Default: `{ '*': 'allow' }` — no prompt for any directory.
 * With --restrict-directories: an allow-list of known-safe paths only. There is
 * deliberately no catch-all '*': 'ask' entry so opencode's own 'ask' default
 * still applies to everything else.
 *
 * Always an object, never the plain string 'allow'. opencode deep-merges config
 * files (remeda mergeDeep) and this file is loaded before the project's
 * opencode.json, so object keys from the project merge on top of these and win
 * via findLast(). A plain string would instead be replaced wholesale by the
 * project object, dropping allow-all for every unmatched path.
 */
function buildServerExternalDirectoryPermissions(): Record<
  string,
  'ask' | 'allow' | 'deny'
> {
  if (!getRestrictExternalDirectories()) {
    return { '*': 'allow' }
  }

  const permissions: Record<string, 'ask' | 'allow' | 'deny'> = {}
  for (const directory of knownSafeExternalDirectories()) {
    permissions[directory] = 'allow'
    permissions[`${directory}/*`] = 'allow'
  }
  return permissions
}

// ── Injection guard per-session config ───────────────────────────
// Per-session injection guard patterns are written as JSON files to
// <dataDir>/injection-guard/<sessionId>.json. The injection guard plugin
// (running inside the opencode server process) reads ROADIE_DATA_DIR env
// var to find these files in tool.execute.after.
// This avoids needing env vars (which are per-process, not per-session).

function getInjectionGuardDir(): string {
  return path.join(getDataDir(), 'injection-guard')
}

/**
 * Write per-session injection guard config so the plugin picks it up.
 * Only call this if injectionGuardPatterns is non-empty.
 */
export function writeInjectionGuardConfig({
  sessionId,
  scanPatterns,
}: {
  sessionId: string
  scanPatterns: string[]
}): void {
  if (scanPatterns.length === 0) {
    return
  }
  try {
    const dir = getInjectionGuardDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${sessionId}.json`),
      JSON.stringify({ scanPatterns }),
    )
  } catch {
    // Best effort -- don't crash the bot if data dir write fails
  }
}

/**
 * Remove per-session injection guard config file.
 */
export function removeInjectionGuardConfig({ sessionId }: { sessionId: string }): void {
  try {
    fs.unlinkSync(path.join(getInjectionGuardDir(), `${sessionId}.json`))
  } catch {
    // File may already be gone
  }
}

/**
 * Read per-session injection guard config. Used by the roadie plugin
 * inside the opencode server process.
 */
export function readInjectionGuardConfig({ sessionId }: { sessionId: string }): { scanPatterns: string[] } | null {
  try {
    const raw = fs.readFileSync(
      path.join(getInjectionGuardDir(), `${sessionId}.json`),
      'utf-8',
    )
    return JSON.parse(raw) as { scanPatterns: string[] }
  } catch {
    return null
  }
}

// ── Public helpers ───────────────────────────────────────────────
// These helpers expose the single shared server and directory-scoped clients.

export function getOpencodeServerPort(_directory?: string): number | null {
  return singleServer?.port ?? null
}

export function getOpencodeServerBaseUrl(): string | null {
  return singleServer?.baseUrl ?? null
}

export function getOpencodeClient(directory: string): OpencodeClient | null {
  if (!singleServer) {
    return null
  }
  return getOrCreateClient({
    baseUrl: singleServer.baseUrl,
    directory,
  })
}

// Structural union of the OpenCode v2 SDK error response shapes. The concrete
// type of `result.error` varies per route, so we describe the fields each shape
// may carry instead of importing every per-route error union:
//   - NotFoundError / BadRequestError: { name, data: { message } }
//   - InvalidRequestError: { _tag, message }
//   - EffectHttpApiErrorBadRequest: { _tag: "BadRequest" } (no message)
//   - some routes also surface { errors: [...] }
export type SdkErrorResponse = {
  data?: { message?: string; ref?: string } | null
  message?: string
  errors?: unknown[]
  _tag?: string
  name?: string
}

/**
 * Extract a human-readable message from an OpenCode SDK error response.
 * Probes each known shape and falls back to a generic message.
 */
export function extractSdkErrorMessage(error: SdkErrorResponse | null | undefined): string {
  if (!error) {
    return 'Unknown OpenCode API error'
  }

  if (error.data?.message) {
    const name = error.name ? `${error.name}: ` : ''
    const ref = error.data.ref ? ` (${error.data.ref})` : ''
    return `${name}${error.data.message}${ref}`
  }

  if (error.message) {
    return error.message
  }

  if (error.errors && error.errors.length > 0) {
    return JSON.stringify(error.errors)
  }

  if (error._tag) {
    return error._tag
  }

  if (error.name) {
    return error.name
  }

  return 'Unknown OpenCode API error'
}

/**
 * Stop the single opencode server.
 * Used for process teardown, tests, and explicit restarts.
 */
export async function stopOpencodeServer(): Promise<boolean> {
  const starting = startingServerProcess
  const server = singleServer
  startingServerProcess = null
  const children = new Set<ChildProcess>()
  if (starting) children.add(starting)
  // A discovered server belongs to another process and is never ours to stop.
  if (server?.process && !server.discovered) children.add(server.process)
  for (const child of children) {
    opencodeLogger.log(`Stopping owned OpenCode process ${child.pid}`)
    const stopped = await stopOwnedChild({ child })
    // Legacy callers expect exceptions on a teardown failure. Do not report
    // success or permit file cleanup while the writer can still be alive.
    if (stopped instanceof Error) throw stopped
  }
  // The owned children are closed, but anything they spawned shares their
  // process group and can still be writing to the data dir. Stop the rest of
  // each group before reporting success (#88).
  for (const child of children) {
    if (!child.pid) continue
    const groupStopped = await terminateProcessGroup(child)
    if (!groupStopped) {
      throw new Error(`OpenCode process group ${child.pid} outlived SIGKILL`)
    }
  }
  singleServer = null
  clientCache.clear()
  serverRetryCount = 0
  // Don't dispose the global listener here — it will reconnect when
  // the server restarts. Only abort the current SSE connection so it
  // doesn't hang on a dead server.
  restartGlobalEventListener()
  return Boolean(server || starting)
}

/**
 * Restart the single opencode server.
 * Kills the existing process and starts a new one.
 * Used for resolving opencode state issues, refreshing auth, plugins, etc.
 */
export async function restartOpencodeServer(): Promise<OpenCodeErrors | true> {
  if (singleServer) {
    await stopOpencodeServer()
  }

  // Reset retry count for the fresh start
  serverRetryCount = 0

  const result = await ensureSingleServer()
  if (result instanceof Error) return result
  restartGlobalEventListener()
  await waitForGlobalEventListener()
  return true
}
