// Pi as a Roadie agent backend (#51): one `pi --mode rpc` child per session.
//
// Pi has no server. Each session is a child process started in the session's
// directory, persisting to a JSONL file under Roadie's data dir. A session not
// running (after a restart, or never prompted here) is started lazily with
// `--session <file>` the first time it is read or prompted.
//
// Permissions: the Roadie Pi extension (./roadie-extension.ts) turns every tool
// call into a `confirm` UI request. The backend answers it from the session's
// Roadie permission rules, or emits `permission.asked` and answers when the
// person replies. Pi's own defaults allow everything, so `allow` is the
// fallback and session rules override it — except per-person MCP tools
// (PERSON_MCP_TOOL_GLOB), denied unless the session's rules allow them.
//
// Shell isolation (--isolate-shells): Pi ignores $SHELL and picks its tool
// shell from `shellPath` in its agent dir's settings.json, so Roadie writes
// the isolation wrapper there when the pools give it a Roadie-owned agent dir,
// and refuses Pi sessions when it cannot (see prepareShellIsolation).
//
// Agents (./agents.ts): Pi has no agent concept, so the OpenCode-format
// definitions a project already has are mapped onto turns — catalog lists
// them, and a selected agent contributes its system prompt, model and
// permission rules to that turn.
//
// noReply: Pi's RPC has no "record without a turn", so context-only messages
// go through the extension's /roadie:append command (`sendMessage` with
// `triggerTurn: false`): they land in the session history without a model
// turn, and the model reads them as user messages on the next turn.
//
// Delegation: the extension's `task` tool (OpenCode's argument contract) asks
// Roadie through a `roadie:task` UI request. The backend spawns a child Pi
// session in the same directory, prompts it, and answers with its final
// assistant text. Children inherit the parent's permission rules plus a task
// deny, so delegation is one level deep, and aborting a parent aborts its
// running children.
//
// Gap: no OAuth through Roadie (sign in with `pi` itself).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { evaluatePermission, matchesPermissionPattern } from '../../permission-policy.js'
import { PERSON_MCP_TOOL_GLOB } from '../../person-mcp.js'
import type { AgentEvent, AgentQuestion, AgentSession, AgentStatus } from '../events.js'
import {
  AgentRequestError,
  type AgentBackend,
  type AgentBackendEvent,
  type AgentBackendProvider,
  type AgentCommand,
  type AgentPermissionRule,
  type AgentPromptPart,
  type AgentProviderCatalog,
  type AgentSessionOperations,
} from '../types.js'
import { PiEventTranslator, finalAssistantText, toAgentHistory, type PiMessage } from './events.js'
import { PiProcess, type PiRecord } from './rpc.js'
import { roadieToolSchemas, runRoadieTool } from '../../roadie-tools.js'
import { ROADIE_PI_BASE_PROMPT } from './prompt.js'
import { agentFor, piAgents } from './agents.js'
import { ROADIE_APPEND_COMMAND } from './roadie-extension.js'
import { openCodeToolName, projectMcpServers, writeMcpFile, type PiMcpServer } from './mcp.js'
import { appendFileEditEvents, isFileEditTool } from '../../file-edit-log.js'
import { resolveGitState, shouldInjectBranch, type GitState } from '../../git-context.js'
import { TITLE_PROMPT_MAX_CHARS, TITLE_REQUEST_SYSTEM } from '../../title-request.js'
import { AGENT_TOKEN_SECRET_ENV, SCRUBBED_SHELL_ENV_NAMES, applyAgentShellEnv } from '../../agent-token.js'
import {
  applyShellEnvTemplates,
  applyTurnAttributionEnv,
  resolveTurnAttribution,
} from '../../turn-attribution-env.js'
import { ensureIsolatedShellWrapper } from '../../isolated-shell.js'
import { PI_KEY_ENV } from './pool.js'

const ROADIE_SESSION_ID_ENV = 'ROADIE_SESSION_ID'

/** This process's environment without anything a tool shell must not see. */
export function scrubbedProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const name of SCRUBBED_SHELL_ENV_NAMES) delete clean[name]
  delete clean[AGENT_TOKEN_SECRET_ENV]
  return clean
}

/**
 * Point Pi's bash tool at the isolation wrapper: merge `shellPath` into a
 * Roadie-owned agent dir's settings.json, keeping every other key (the pools'
 * `transport` setting, user-set keys). Idempotent. Pi reads the file when a
 * process boots, so it must be written before the first spawn.
 */
export function writePiShellPath({ agentDir, shellPath }: { agentDir: string; shellPath: string }): string | Error {
  const file = path.join(agentDir, 'settings.json')
  try {
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {}
    if (settings['shellPath'] !== shellPath) {
      fs.writeFileSync(file, JSON.stringify({ ...settings, shellPath }, null, 2), { mode: 0o600 })
    }
    return file
  } catch (error) {
    return new Error(`Could not write shellPath into ${file}`, { cause: error })
  }
}

const PERMISSION_TITLE = 'roadie:permission'
const TOOL_TITLE = 'roadie:tool'
const QUESTION_TITLE = 'roadie:question'
const TASK_TITLE = 'roadie:task'
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high']

/**
 * Roadie-owned per-session state (title, permission rules), persisted beside
 * the Pi session file so both survive a restart: Pi's own session file does
 * not store titles, and Roadie's rules must survive the process that decided
 * them. Written atomically like the MCP file; read whenever the in-memory
 * cache misses (a fresh process resuming an old session).
 */
type PersistedSessionState = { title?: string; permissionRules?: AgentPermissionRule[] }

function sessionStatePath(sessionDir: string, sessionId: string): string {
  // Ids arrive from the runtime and remote callers; no path separators.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(sessionDir, `roadie-${safe}.json`)
}

function readSessionState(file: string): PersistedSessionState {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedSessionState
    return state && typeof state === 'object' ? state : {}
  } catch {
    return {}
  }
}

function writeSessionState(file: string, state: PersistedSessionState): void {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(temp, file)
}

export type PiBackendOptions = {
  /** The `pi` executable. */
  bin: string
  /** Where Pi session files (and Roadie's per-session system prompt files) live. */
  sessionDir: string
  /** Default model as "provider/model", passed to every new process. */
  model?: string
  /** Extra environment for Pi (e.g. PI_CODING_AGENT_DIR for auth and models). */
  env?: NodeJS.ProcessEnv
  /**
   * Stop a session's process after this long idle; it resumes from its file on
   * the next read or prompt. Each process holds ~150 MB, so idle threads must
   * not keep one. Default 5 minutes; 0 disables.
   */
  idleTimeoutMs?: number
  /** Roadie data dir for the file-edit log (`roadie session editors`). */
  fileEditLogDir?: string
  /** Model for title generation (a small one), as "provider/model". Defaults to `model`. */
  titleModel?: string
  /** Base system prompt replacing Pi's default. Defaults to ROADIE_PI_BASE_PROMPT. */
  systemPrompt?: string
  /** Load the project's AGENTS.md / CLAUDE.md files, like OpenCode. Default true. */
  contextFiles?: boolean
  /**
   * How long the model catalog (credential pools and models Pi reports) is
   * trusted before it is probed again; the pools can change what a session
   * sees. Default 5 minutes; 0 disables caching (a probe per call).
   */
  catalogTtlMs?: number
  /**
   * Extra tool-shell variables from --shell-env / ROADIE_SHELL_ENV
   * (turn-attribution-env.ts): variable name → template over session fields.
   * Applied to every session's shell env file.
   */
  shellEnvTemplates?: Record<string, string>
  /**
   * Roadie's per-session injection guard config directory: the session runtime
   * writes `<sessionId>.json` files there for `send --injection-guard`, and
   * the Roadie Pi extension reads them (via ROADIE_PI_INJECTION_GUARD_DIR in
   * the session's env) to scan matched tool results.
   */
  injectionGuardDir?: string
  /**
   * Bill model calls to Roadie's credential pools through the loopback proxy.
   * Each process gets a key in ROADIE_PI_KEY that the proxy maps to its session.
   */
  pool?: {
    issueKey(sessionId: () => string | undefined): string
    revokeKey(key: string): void
    /** End the session's turn affinity (called when a run ends). */
    endTurn?(sessionId: string): void
  }
  /**
   * Shell isolation contract (--isolate-shells): require every session's bash
   * tool to run through the setpriv + `env -i` wrapper (isolated-shell.ts).
   * Pi ignores $SHELL: it picks its
   * tool shell from `shellPath` in its agent dir's settings.json
   * (PI_CODING_AGENT_DIR), which Roadie owns only for the credential pools.
   * `agentDir` is that dir and gets `shellPath` written before the first
   * process spawns; null means Roadie cannot reach Pi's shell config (Pi
   * would read the user's own ~/.pi/agent, which is not Roadie's to edit), so
   * sessions are refused instead of running unisolated.
   */
  isolateShells?: { username: string; dataDir: string; agentDir: string | null }
  /** Injectable for tests: how the isolation wrapper is ensured. Defaults to the real setup. */
  ensureIsolatedShell?: typeof ensureIsolatedShellWrapper
}

type PiCommand = { name: string; description?: string; source: 'extension' | 'prompt' | 'skill' }

type PiModel = { id: string; name?: string; provider: string; reasoning?: boolean; contextWindow?: number }

type PendingPermission = { uiId: string; sessionId: string; permission: string; patterns: string[] }

type RunningSession = {
  id: string
  directory: string
  sessionFile: string
  systemFile: string
  mcpFile: string
  shellEnvFile: string
  process: PiProcess
  translator: PiEventTranslator
  title: string
  createdAt: number
  updatedAt: number
  busy: boolean
  /** Git state last announced to the model (branch notes). */
  gitState?: GitState
  idleTimer?: ReturnType<typeof setTimeout>
  model?: { provider: string; id: string }
  thinking?: string
  /** The thinking level Pi itself started with; clearing a variant returns here. */
  defaultThinking?: string
  /** Set when this session was spawned by a parent's task tool. */
  childOf?: string
  /** Resolved when the session's current turn ends (task children wait on it). */
  idleWaiters: Array<() => void>
}

function extensionPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const ts = path.join(here, 'roadie-extension.ts')
  return fs.existsSync(ts) ? ts : path.join(here, 'roadie-extension.js')
}

/**
 * Absolute path-like tokens in a bash command, as a best-effort token scan:
 * shell metacharacters and env-assignment separators split tokens, and any
 * piece starting with a single `/` counts — redirects (`> /etc/hosts`), quoted
 * paths and `VAR=/path` assignments included, while `https://…` URL remainders
 * (a leading `//`) are not filesystem paths. Not a shell parser: computed
 * paths (`> "$OUT"`) stay invisible, so like OpenCode's own bash gate this is
 * a safety net, not a sandbox.
 */
export function bashCommandPaths({ command }: { command: string }): string[] {
  const tokens = command.split(/[\s"'`;&|<>()=,:!{}]+/)
  return [...new Set(tokens.filter((token) => token.startsWith('/') && !token.startsWith('//')))]
}

/** Directories outside `cwd` that a bash command's path-like tokens touch, with the same parent-dir target a file tool reports. */
export function bashExternalDirectories({ command, cwd }: { command: string; cwd: string }): string[] {
  const inside = `${cwd}${path.sep}`
  return [...new Set(bashCommandPaths({ command }).flatMap((candidate) => {
    const resolved = path.resolve(cwd, candidate)
    return resolved === cwd || resolved.startsWith(inside) ? [] : [path.dirname(resolved)]
  }))]
}

/** Which permission and targets a Pi tool call asks for, in OpenCode's vocabulary. */
export function permissionForToolCall({ tool, input, cwd }: { tool: string; input: Record<string, unknown>; cwd: string }): Array<{ permission: string; targets: string[] }> {
  const filePath = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : undefined
  const checks: Array<{ permission: string; targets: string[] }> = []
  if (tool === 'task') checks.push({ permission: 'task', targets: [String(input.subagent_type ?? '')] })
  else if (tool === 'bash') {
    const command = String(input.command ?? '')
    checks.push({ permission: 'bash', targets: [command] })
    // Bash has no path argument, so unlike the file tools its external paths
    // need a scan of the command itself (best effort, see bashCommandPaths):
    // absolute paths outside the session directory get the same
    // external_directory check OpenCode applies to its bash tool.
    const external = bashExternalDirectories({ command, cwd })
    if (external.length > 0) checks.push({ permission: 'external_directory', targets: external })
  }
  else if (tool === 'edit' || tool === 'write') checks.push({ permission: 'edit', targets: filePath ? [filePath] : [] })
  else if (tool === 'read' || tool === 'grep' || tool === 'find' || tool === 'ls') checks.push({ permission: tool === 'read' ? 'read' : tool, targets: filePath ? [filePath] : [] })
  else checks.push({ permission: openCodeToolName(tool), targets: [] })
  if (filePath) {
    const resolved = path.resolve(cwd, filePath)
    const inside = resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)
    if (!inside) checks.push({ permission: 'external_directory', targets: [path.dirname(resolved)] })
  }
  return checks
}

export function decidePermission({ rules, tool, input, cwd }: {
  rules: AgentPermissionRule[]
  tool: string
  input: Record<string, unknown>
  cwd: string
}): { action: 'allow' | 'deny' | 'ask'; permission: string; patterns: string[] } {
  const checks = permissionForToolCall({ tool, input, cwd })
  let asked: { permission: string; patterns: string[] } | undefined
  for (const check of checks) {
    // Per-person MCP tools are denied unless the session's own rules allow
    // them (the per-turn pair from person-mcp.ts), matching OpenCode's
    // server-wide deny of PERSON_MCP_TOOL_GLOB.
    const fallback = matchesPermissionPattern({ value: check.permission, pattern: PERSON_MCP_TOOL_GLOB }) ? 'deny' : 'allow'
    const action = evaluatePermission({ rules, permission: check.permission, targets: check.targets, fallback })
    if (action === 'deny') return { action, permission: check.permission, patterns: check.targets }
    if (action === 'ask' && !asked) asked = { permission: check.permission, patterns: check.targets }
  }
  if (asked) return { action: 'ask', ...asked }
  return { action: 'allow', permission: checks[0]!.permission, patterns: checks[0]!.targets }
}

function promptText(parts: AgentPromptPart[]): { message: string; images: Array<{ type: 'image'; data: string; mimeType: string }> } {
  const text: string[] = []
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
  for (const part of parts) {
    if (part.kind === 'text') {
      text.push(part.text)
      continue
    }
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.url)
    if (match && part.mime.startsWith('image/')) images.push({ type: 'image', data: match[2]!, mimeType: match[1]! })
    else text.push(`[Attached file ${part.filename ?? ''} (${part.mime}): ${part.url.startsWith('data:') ? 'inline data omitted' : part.url}]`)
  }
  return { message: text.join('\n\n'), images }
}

/** Point a session file's header at another working directory (atomic rewrite). */
function setSessionHeaderCwd(file: string, cwd: string) {
  const [first, ...rest] = fs.readFileSync(file, 'utf8').split('\n')
  const header = JSON.parse(first ?? '{}') as Record<string, unknown>
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, [JSON.stringify({ ...header, cwd }), ...rest].join('\n'))
  fs.renameSync(temp, file)
}

/** Session id and cwd from a Pi session file's header line. */
function readSessionHeader(file: string): { id: string; cwd: string; createdAt: number } | undefined {
  try {
    const fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(2048)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    fs.closeSync(fd)
    const first = buffer.subarray(0, read).toString('utf8').split('\n')[0]
    const header = JSON.parse(first ?? '') as { type?: string; id?: string; cwd?: string; timestamp?: string }
    if (header.type !== 'session' || !header.id || !header.cwd) return undefined
    return { id: header.id, cwd: header.cwd, createdAt: Date.parse(header.timestamp ?? '') || 0 }
  } catch {
    return undefined
  }
}

export class PiBackendProvider implements AgentBackendProvider {
  readonly id = 'pi'
  private sessions = new Map<string, RunningSession>()
  /**
   * Pool keys for tool shells, one per session. A Pi process's own key is
   * revoked when the process exits (idle stop, crash), but a tool shell can
   * start work that outlives it (a detached `pi -p`), so shells get a key
   * that lives as long as the session and is revoked on delete/dispose.
   */
  private shellPoolKeys = new Map<string, string>()
  private starting = new Map<string, Promise<RunningSession | Error>>()
  private titles = new Map<string, string>()
  private permissionRules = new Map<string, AgentPermissionRule[]>()
  private pendingPermissions = new Map<string, PendingPermission & { session: RunningSession }>()
  /** Tool arguments by call id, from start to end (end does not repeat them). */
  private toolArgs = new Map<string, unknown>()
  private pendingQuestions = new Map<string, { sessionId: string; session: RunningSession }>()
  private pendingTasks = new Map<string, { sessionId: string; session: RunningSession; cancelled: boolean }>()
  private subscribers = new Set<(event: AgentBackendEvent) => void>()
  /** The model catalog probe, and when it started; re-probed after catalogTtlMs. */
  private catalogCache?: { promise: Promise<AgentProviderCatalog | Error>; at: number }
  /** Servers added through the backend (per-person MCP), and enabled-state overrides, by directory. */
  private addedMcp = new Map<string, Record<string, PiMcpServer>>()
  private mcpEnabled = new Map<string, Map<string, boolean>>()
  /** Permission rules from the selected agent for the current turn, by session id. */
  private turnAgentRules = new Map<string, AgentPermissionRule[]>()
  private backend: AgentBackend
  private toolsFile: string
  /** The --isolate-shells gate, resolved once per provider. */
  private shellIsolation?: Promise<true | Error>

  constructor(readonly options: PiBackendOptions) {
    fs.mkdirSync(options.sessionDir, { recursive: true })
    this.toolsFile = path.join(options.sessionDir, 'roadie-tools.json')
    fs.writeFileSync(this.toolsFile, JSON.stringify(roadieToolSchemas()))
    this.backend = {
      sessions: this.sessionOperations(),
      catalog: {
        providers: () => this.providers(),
        config: async () => (options.model ? { model: options.model } : {}),
        agents: async ({ directory }) => piAgents(directory),
        commands: ({ directory }) => this.commands(directory),
      },
      mcp: {
        addRemote: async ({ directory, name, url, headers }) => {
          this.addedMcp.set(directory, { ...this.addedMcp.get(directory), [name]: { url, headers, enabled: true, exposure: 'direct' } })
          this.refreshMcp(directory)
        },
        status: async ({ directory }) => Object.fromEntries(Object.entries(this.mcpServersFor(directory)).map(([name, server]) => [
          name,
          // Disabled is accurate: the extension never registers the server, so
          // its tools cannot run. Enabled says nothing about the connection —
          // Pi exposes no MCP state to extensions (getMcpServers returns name,
          // config and source only) and no RPC to read it, so report unknown
          // instead of pretending every server is connected.
          { status: server.enabled ? 'unknown' as const : 'disabled' as const },
        ])),
        connect: async ({ directory, name }) => this.setMcpEnabled(directory, name, true),
        disconnect: async ({ directory, name }) => this.setMcpEnabled(directory, name, false),
      },
    }
  }

  private setMcpEnabled(directory: string, name: string, enabled: boolean): void | AgentRequestError {
    if (!this.mcpServersFor(directory)[name]) return new AgentRequestError({ detail: `No MCP server ${name}` })
    const overrides = this.mcpEnabled.get(directory) ?? new Map<string, boolean>()
    overrides.set(name, enabled)
    this.mcpEnabled.set(directory, overrides)
    this.refreshMcp(directory)
  }

  /** Project commands and skills Pi finds for a directory (extension commands are Pi's own UI). */
  private async commands(directory: string): Promise<AgentCommand[] | Error> {
    const running = [...this.sessions.values()].find((session) => session.directory === directory && !session.process.exited)
    const probe = running?.process ?? new PiProcess({
      bin: this.options.bin,
      args: [...this.spawnArgs([], directory).filter((arg, i, all) => arg !== '--session-dir' && all[i - 1] !== '--session-dir'), '--no-session'],
      cwd: directory,
      env: { ...process.env, ...this.options.env },
    })
    const result = await probe.request<{ commands: PiCommand[] }>({ type: 'get_commands' })
    if (!running) probe.kill()
    if (result instanceof Error) return result
    return result.commands.flatMap((command): AgentCommand[] => {
      if (command.source === 'prompt') return [{ name: command.name, ...(command.description && { description: command.description }), source: 'command' }]
      if (command.source === 'skill') return [{ name: command.name.replace(/^skill:/, ''), ...(command.description && { description: command.description }), source: 'skill' }]
      return []
    })
  }

  /**
   * Copy a session file into a new session, whole or up to (not including) a
   * user message, using Pi's own fork. A short-lived process does it; the
   * fork's process starts lazily on first use. The source file is unchanged.
   */
  private async forkFile({ file, messageId }: { file: string; messageId?: string }): Promise<{ sessionId: string; sessionFile: string } | Error> {
    const header = readSessionHeader(file)
    if (!header) return new AgentRequestError({ detail: `Unreadable Pi session file ${file}` })
    let entryId: string | undefined
    if (messageId) {
      const timestamp = Number(/^pi-user-(\d+)$/.exec(messageId)?.[1])
      entryId = fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
        try {
          const entry = JSON.parse(line) as { type?: string; id?: string; message?: { role?: string; timestamp?: number } }
          return entry.type === 'message' && entry.message?.role === 'user' && entry.message.timestamp === timestamp && entry.id ? [entry.id] : []
        } catch {
          return []
        }
      })[0]
      if (!entryId) return new AgentRequestError({ detail: `No user message ${messageId} in Pi session ${header.id}` })
    }
    const child = new PiProcess({
      bin: this.options.bin,
      args: [
        '--session-dir', this.options.sessionDir,
        '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        ...(this.options.model ? ['--model', this.options.model] : []),
        ...(entryId ? ['--session', file] : ['--fork', file]),
      ],
      cwd: header.cwd,
      env: { ...process.env, ...this.options.env },
    })
    try {
      if (entryId) {
        const forked = await child.request<{ cancelled?: boolean }>({ type: 'fork', entryId })
        if (forked instanceof Error) return new AgentRequestError({ detail: forked.message })
        if (forked?.cancelled) return new AgentRequestError({ detail: 'Pi cancelled the fork' })
      }
      const state = await child.request<{ sessionId: string; sessionFile: string }>({ type: 'get_state' })
      if (state instanceof Error) return state
      if (state.sessionFile === file) return new AgentRequestError({ detail: 'Pi did not create a fork' })
      // Pi writes a session file with its first entry; a fork has entries already.
      if (!fs.existsSync(state.sessionFile)) return new AgentRequestError({ detail: 'Pi fork file was not written' })
      return state
    } finally {
      child.kill()
    }
  }

  /**
   * A bounded, isolated title request: a throwaway Pi process with only Roadie's
   * title prompt, no tools, no session, no project context. It bills through
   * the pool as the session it names, under its own short-lived key.
   */
  private async generateTitle({ sessionId, directory, prompt }: { sessionId: string; directory: string; prompt: string }): Promise<string | Error> {
    const model = this.options.titleModel ?? this.options.model
    if (!model) return new AgentRequestError({ detail: 'No model configured for Pi titles' })
    const poolKey = this.options.pool?.issueKey(() => sessionId)
    const child = new PiProcess({
      bin: this.options.bin,
      args: ['--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        // `minimal`, not `off`: adaptive-thinking models reject disabled thinking.
        '--system-prompt', TITLE_REQUEST_SYSTEM, '--model', model, '--thinking', 'minimal'],
      cwd: directory,
      env: { ...scrubbedProcessEnv(), ...this.options.env, ...(poolKey && { [PI_KEY_ENV]: poolKey }) },
    })
    try {
      const done = new Promise<Extract<PiMessage, { role: 'assistant' }> | undefined>((resolve) => {
        child.onRecord((record) => {
          if (record.type === 'agent_end') {
            resolve((record.messages as PiMessage[] | undefined)?.findLast((m) => m.role === 'assistant') as Extract<PiMessage, { role: 'assistant' }> | undefined)
          }
        })
        child.onExit(() => resolve(undefined))
      })
      const accepted = await child.request({ type: 'prompt', message: prompt.slice(0, TITLE_PROMPT_MAX_CHARS) })
      if (accepted instanceof Error) return new AgentRequestError({ detail: accepted.message })
      const reply = await Promise.race([done, new Promise<undefined>((resolve) => setTimeout(resolve, 15_000))])
      const text = reply ? finalAssistantText([reply]) : ''
      if (text) return text
      if (reply?.errorMessage) return new AgentRequestError({ detail: `Title model failed: ${reply.errorMessage}` })
      return new AgentRequestError({ detail: reply ? 'Pi returned an empty title' : 'Title request ended without a reply' })
    } finally {
      child.kill()
      if (poolKey) this.options.pool?.revokeKey(poolKey)
    }
  }

  /** Whether `sessionId` is a Pi session this provider runs or can resume. */
  owns(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.findSessionFile(sessionId) !== undefined
  }

  getBackend(): AgentBackend {
    return this.backend
  }

  async initializeForDirectory() {
    return () => this.backend
  }

  subscribeEvents({ signal }: { signal: AbortSignal }) {
    const queue: AgentBackendEvent[] = []
    let wake: (() => void) | undefined
    const push = (event: AgentBackendEvent) => {
      queue.push(event)
      wake?.()
    }
    this.subscribers.add(push)
    signal.addEventListener('abort', () => {
      this.subscribers.delete(push)
      wake?.()
    }, { once: true })
    const iterable: AsyncIterable<AgentBackendEvent> = {
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = queue.shift()
          if (next) {
            yield next
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    }
    return Promise.resolve(iterable)
  }

  onStarted() {}

  /** Stop every Pi process; resolves once they have all exited. */
  async dispose(): Promise<void> {
    const processes = [...this.sessions.values()].map((session) => session.process)
    this.sessions.clear()
    for (const key of this.shellPoolKeys.values()) this.options.pool?.revokeKey(key)
    this.shellPoolKeys.clear()
    await Promise.all(processes.map((process) => process.kill()))
  }

  private emit(events: AgentEvent[], raw: unknown) {
    if (events.length === 0) return
    for (const subscriber of this.subscribers) subscriber({ events, raw, backend: this.id })
  }

  private findSessionFile(sessionId: string): string | undefined {
    const running = this.sessions.get(sessionId)
    if (running) return running.sessionFile
    if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return undefined
    const name = fs.readdirSync(this.options.sessionDir).find((file) => file.endsWith(`_${sessionId}.jsonl`))
    return name ? path.join(this.options.sessionDir, name) : undefined
  }

  private spawnArgs(extra: string[], directory: string): string[] {
    return [
      '--session-dir', this.options.sessionDir,
      '--system-prompt', this.options.systemPrompt ?? ROADIE_PI_BASE_PROMPT,
      // Projects bound to Roadie channels are operator-approved: Pi loads
      // their skills, prompt templates and `.pi` resources.
      '--approve',
      ...(this.options.contextFiles === false ? ['--no-context-files'] : []),
      '-e', extensionPath(),
      ...(this.options.model ? ['--model', this.options.model] : []),
      ...extra,
    ]
  }

  /**
   * The --isolate-shells gate, resolved once per provider: without a
   * Roadie-owned agent dir Pi sessions are refused (the user's ~/.pi/agent is
   * not Roadie's to edit); otherwise the wrapper is ensured with the same
   * setup the OpenCode server start runs, and shellPath is written into the
   * agent dir's settings.json so Pi's bash tool execs it.
   */
  private prepareShellIsolation(): Promise<true | Error> {
    this.shellIsolation ??= (async () => {
      const isolation = this.options.isolateShells
      if (!isolation) return true
      if (isolation.agentDir === null) {
        return new Error(
          'Pi sessions are refused while shell isolation is on (--isolate-shells): Roadie can only point ' +
            "Pi's bash tool at the isolation wrapper through the Roadie-owned Pi agent dir that the " +
            'credential pools provide (PI_CODING_AGENT_DIR). Enable credential pools for Pi channels, or ' +
            'unset --isolate-shells; running Pi with its own shell would skip the isolation.',
        )
      }
      const wrapper = await (this.options.ensureIsolatedShell ?? ensureIsolatedShellWrapper)({
        dataDir: isolation.dataDir,
        username: isolation.username,
      })
      if (wrapper instanceof Error) return wrapper
      const written = writePiShellPath({ agentDir: isolation.agentDir, shellPath: wrapper.shellPath })
      if (written instanceof Error) return written
      return true
    })()
    return this.shellIsolation
  }

  /** Start a Pi process and wire it to the event stream. */
  private async start({ directory, extra, title }: { directory: string; extra: string[]; title?: string }): Promise<RunningSession | Error> {
    // Fail closed: under --isolate-shells a session whose bash tool would run
    // unisolated must not start at all.
    if (this.options.isolateShells) {
      const prepared = await this.prepareShellIsolation()
      if (prepared instanceof Error) return new AgentRequestError({ detail: prepared.message })
    }
    const processId = crypto.randomUUID()
    const systemFile = path.join(this.options.sessionDir, `system-${processId}.md`)
    fs.writeFileSync(systemFile, '')
    const mcpFile = path.join(this.options.sessionDir, `mcp-${processId}.json`)
    writeMcpFile(mcpFile, this.mcpServersFor(directory))
    let ownSessionId: string | undefined
    const poolKey = this.options.pool?.issueKey(() => ownSessionId)
    const shellEnvFile = path.join(this.options.sessionDir, `shell-env-${processId}.json`)
    fs.writeFileSync(shellEnvFile, '{}', { mode: 0o600 })
    const child = new PiProcess({
      bin: this.options.bin,
      args: this.spawnArgs(extra, directory),
      cwd: directory,
      env: {
        // Pi's tool shells inherit Pi's environment, so the bot's database
        // credentials and the agent-token secret never enter it.
        ...scrubbedProcessEnv(),
        ...this.options.env,
        ROADIE_PI_SHELL_ENV_FILE: shellEnvFile,
        ROADIE_PI_SYSTEM_FILE: systemFile,
        ROADIE_PI_TOOLS_FILE: this.toolsFile,
        ROADIE_PI_MCP_FILE: mcpFile,
        // The extension's injection guard reads per-session scan patterns
        // (`send --injection-guard`) from this directory.
        ...(this.options.injectionGuardDir && { ROADIE_PI_INJECTION_GUARD_DIR: this.options.injectionGuardDir }),
        ...(poolKey && { [PI_KEY_ENV]: poolKey }),
      },
    })
    const state = await child.request<{ sessionId: string; sessionFile: string; sessionName?: string; model?: PiModel; thinkingLevel?: string }>({ type: 'get_state' })
    if (state instanceof Error) {
      child.kill()
      fs.rmSync(mcpFile, { force: true })
      fs.rmSync(shellEnvFile, { force: true })
      if (poolKey) this.options.pool?.revokeKey(poolKey)
      return state
    }
    ownSessionId = state.sessionId
    await this.writeShellEnv(shellEnvFile, state.sessionId)
    const header = readSessionHeader(state.sessionFile)
    const session: RunningSession = {
      id: state.sessionId,
      directory,
      sessionFile: state.sessionFile,
      systemFile,
      mcpFile,
      shellEnvFile,
      process: child,
      translator: new PiEventTranslator(state.sessionId),
      title: title ?? state.sessionName ?? this.titleFor(state.sessionId),
      createdAt: header?.createdAt || Date.now(),
      updatedAt: Date.now(),
      busy: false,
      idleWaiters: [],
      ...(state.model && { model: { provider: state.model.provider, id: state.model.id } }),
      ...(state.thinkingLevel && { thinking: state.thinkingLevel, defaultThinking: state.thinkingLevel }),
    }
    this.sessions.set(session.id, session)
    this.scheduleIdleStop(session)
    child.onRecord((record) => this.onRecord(session, record))
    child.onExit(() => {
      clearTimeout(session.idleTimer)
      for (const resolve of session.idleWaiters.splice(0)) resolve()
      if (poolKey) this.options.pool?.revokeKey(poolKey)
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id)
      fs.rmSync(systemFile, { force: true })
      fs.rmSync(mcpFile, { force: true })
      fs.rmSync(shellEnvFile, { force: true })
      if (session.busy) {
        session.busy = false
        this.emit([
          { type: 'error', sessionId: session.id, error: { name: 'APIError', message: 'Pi process exited mid-turn' } },
          { type: 'status', sessionId: session.id, status: { state: 'idle' } },
          { type: 'idle', sessionId: session.id },
        ], { type: 'process_exit' })
      }
    })
    return session
  }

  /** The running process for a session, resuming it from its file if needed. */
  private async ensure(sessionId: string, directory?: string): Promise<RunningSession | Error> {
    const running = this.sessions.get(sessionId)
    if (running && !running.process.exited) return running
    const inFlight = this.starting.get(sessionId)
    if (inFlight) return inFlight
    const file = this.findSessionFile(sessionId)
    if (!file) return new AgentRequestError({ detail: `Pi session ${sessionId} not found` })
    const cwd = readSessionHeader(file)?.cwd ?? directory
    if (!cwd) return new AgentRequestError({ detail: `Pi session ${sessionId} has no working directory` })
    const started = this.start({ directory: cwd, extra: ['--session', file] })
    this.starting.set(sessionId, started)
    const result = await started
    this.starting.delete(sessionId)
    return result
  }

  private onRecord(session: RunningSession, record: PiRecord) {
    if (record.type === 'extension_ui_request') {
      this.onUiRequest(session, record)
      return
    }
    if (record.type === 'agent_start') session.busy = true
    if (record.type === 'tool_execution_start') this.toolArgs.set(String(record.toolCallId), record.args)
    if (record.type === 'tool_execution_end') {
      const args = this.toolArgs.get(String(record.toolCallId))
      this.toolArgs.delete(String(record.toolCallId))
      if (!record.isError) this.recordFileEdit(session, String(record.toolName ?? ''), args)
    }
    if (record.type === 'agent_end') {
      session.busy = false
      for (const resolve of session.idleWaiters.splice(0)) resolve()
      this.touch(session)
      this.options.pool?.endTurn?.(session.id)
    }
    this.emit(session.translator.translate(record), record)
  }

  /** `roadie session editors` reads this log; Pi's edit/write take `path`. */
  private recordFileEdit(session: RunningSession, tool: string, rawArgs: unknown) {
    const dataDir = this.options.fileEditLogDir
    if (!dataDir || !isFileEditTool(tool)) return
    const args = (rawArgs ?? {}) as { path?: unknown; file_path?: unknown }
    const filePath = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined
    if (!filePath) return
    appendFileEditEvents({ dataDir, events: [{ v: 1, at: Date.now(), sessionId: session.id, file: path.resolve(session.directory, filePath), tool }] })
  }

  private onUiRequest(session: RunningSession, record: PiRecord) {
    const uiId = String(record.id)
    if (record.method === 'notify') {
      const level = record.notifyType === 'error' ? 'error' : record.notifyType === 'warning' ? 'warning' : 'info'
      this.emit([{ type: 'notice', message: String(record.message ?? ''), level }], record)
      return
    }
    if (record.method === 'input' && record.title === QUESTION_TITLE) {
      this.onQuestion(session, uiId, String(record.placeholder ?? ''))
      return
    }
    if (record.method === 'input' && record.title === TOOL_TITLE) {
      void this.runTool(session, uiId, String(record.placeholder ?? ''))
      return
    }
    if (record.method === 'input' && record.title === TASK_TITLE) {
      void this.runTask(session, uiId, String(record.placeholder ?? ''))
      return
    }
    if (record.method !== 'confirm' || record.title !== PERMISSION_TITLE) {
      // Only Roadie's own dialogs are supported; dismiss anything else so Pi does not block.
      if (['select', 'confirm', 'input', 'editor'].includes(String(record.method))) {
        session.process.send({ type: 'extension_ui_response', id: uiId, cancelled: true })
      }
      return
    }
    let call: { tool: string; callId: string; input: Record<string, unknown>; cwd: string }
    try {
      call = JSON.parse(String(record.message))
    } catch {
      session.process.send({ type: 'extension_ui_response', id: uiId, confirmed: false })
      return
    }
    const decision = decidePermission({
      // The selected agent's rules first, so the session's Roadie rules still
      // win — OpenCode evaluates session rules after agent ones, last match wins.
      rules: [...(this.turnAgentRules.get(session.id) ?? []), ...this.rulesFor(session.id)],
      tool: call.tool,
      input: call.input,
      cwd: call.cwd || session.directory,
    })
    if (decision.action !== 'ask') {
      session.process.send({ type: 'extension_ui_response', id: uiId, confirmed: decision.action === 'allow' })
      return
    }
    const pending = { uiId, sessionId: session.id, permission: decision.permission, patterns: decision.patterns, session }
    this.pendingPermissions.set(uiId, pending)
    this.emit([{
      type: 'permission.asked',
      request: {
        id: uiId,
        sessionId: session.id,
        permission: decision.permission,
        patterns: decision.patterns,
        always: decision.patterns,
        metadata: { tool: call.tool, input: call.input },
      },
    }], record)
  }

  /** Surface a `question` tool call as Roadie's question event; replyQuestion answers it. */
  private onQuestion(session: RunningSession, uiId: string, request: string) {
    let parsed: { callId?: string; questions?: AgentQuestion[] }
    try {
      parsed = JSON.parse(request)
    } catch {
      session.process.send({ type: 'extension_ui_response', id: uiId, cancelled: true })
      return
    }
    this.pendingQuestions.set(uiId, { sessionId: session.id, session })
    const messageId = parsed.callId ? session.translator.messageIdForCall(parsed.callId) : undefined
    this.emit([{
      type: 'question.asked',
      request: {
        id: uiId,
        sessionId: session.id,
        questions: (parsed.questions ?? []).map((q) => ({ ...q, options: q.options ?? [] })),
        ...(parsed.callId && messageId && { toolCall: { messageId, callId: parsed.callId } }),
      },
    }], { type: 'question_asked' })
  }

  /**
   * Dismiss a session's open questions and task calls (abort): the tools error
   * and the run can stop. With `permissions`, open permission asks are rejected
   * too — used when the process is gone and can never answer them itself.
   */
  private cancelQuestions(sessionId: string, { permissions = false }: { permissions?: boolean } = {}) {
    for (const [uiId, pending] of this.pendingQuestions) {
      if (pending.sessionId !== sessionId) continue
      this.pendingQuestions.delete(uiId)
      pending.session.process.send({ type: 'extension_ui_response', id: uiId, cancelled: true })
      this.emit([{ type: 'question.rejected', sessionId, requestId: uiId }], { type: 'question_rejected' })
    }
    for (const [uiId, pending] of this.pendingTasks) {
      if (pending.sessionId !== sessionId) continue
      this.pendingTasks.delete(uiId)
      pending.cancelled = true
      pending.session.process.send({ type: 'extension_ui_response', id: uiId, cancelled: true })
    }
    if (!permissions) return
    for (const [uiId, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue
      this.pendingPermissions.delete(uiId)
      pending.session.process.send({ type: 'extension_ui_response', id: uiId, confirmed: false })
      this.emit([{ type: 'permission.replied', sessionId, requestId: uiId, reply: 'reject' }], { type: 'permission_replied' })
    }
  }

  /** Run a Roadie tool the extension forwarded, and answer with its result. */
  private async runTool(session: RunningSession, uiId: string, request: string) {
    let call: { tool: string; args: unknown }
    try {
      call = JSON.parse(request)
    } catch {
      session.process.send({ type: 'extension_ui_response', id: uiId, value: JSON.stringify({ error: 'Malformed Roadie tool request' }) })
      return
    }
    const result = await runRoadieTool({ name: call.tool, args: call.args, context: { sessionId: session.id, directory: session.directory } })
    const answer = result instanceof Error
      ? { error: result.message }
      : typeof result === 'string' ? { output: result } : result
    session.process.send({ type: 'extension_ui_response', id: uiId, value: JSON.stringify(answer) })
  }

  /**
   * Run the task tool: spawn a child Pi session in the same directory, prompt
   * it, and answer with its final assistant text (OpenCode's task contract).
   * The parent's tool part carries `subagent`, from which child_session_*
   * events and lineage derive. Children inherit the parent's permission rules
   * plus a task deny; aborting the parent aborts its running children.
   */
  private async runTask(session: RunningSession, uiId: string, request: string) {
    const pending = { sessionId: session.id, session, cancelled: false }
    this.pendingTasks.set(uiId, pending)
    // A cancelled task (parent abort) already answered Pi; drop the late result.
    const respond = (answer: { output?: string; error?: string }) => {
      this.pendingTasks.delete(uiId)
      if (pending.cancelled) return
      session.process.send({ type: 'extension_ui_response', id: uiId, value: JSON.stringify(answer) })
    }
    let call: { callId?: string; args?: Record<string, unknown> }
    try {
      call = JSON.parse(request)
    } catch {
      respond({ error: 'Malformed Roadie task request' })
      return
    }
    const args = call.args ?? {}
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    const agent = typeof args.subagent_type === 'string' && args.subagent_type.trim() ? args.subagent_type.trim() : 'general'
    const description = typeof args.description === 'string' ? args.description.trim() : ''
    if (!prompt.trim()) {
      respond({ error: 'The task tool needs a prompt' })
      return
    }
    if (session.childOf) {
      respond({ error: 'Subagent depth limit reached (1); subagents cannot delegate further' })
      return
    }
    const child = await this.start({ directory: session.directory, extra: [] })
    if (child instanceof Error) {
      respond({ error: `Could not start the subagent session: ${child.message}` })
      return
    }
    child.childOf = session.id
    // Children run one level deep: the parent's rules plus a task deny, like
    // OpenCode's task children.
    const childRules = [...this.rulesFor(session.id), { permission: 'task', pattern: '*', action: 'deny' as const }]
    this.permissionRules.set(child.id, childRules)
    this.persistSessionState(child.id, { permissionRules: childRules })
    if (description) {
      const title = `${description} (@${agent} subagent)`
      this.titles.set(child.id, title)
      this.persistSessionState(child.id, { title })
      void child.process.request({ type: 'set_session_name', name: title })
    }
    const idle = new Promise<void>((resolve) => child.idleWaiters.push(resolve))
    const accepted = await child.process.request({ type: 'prompt', message: prompt })
    if (accepted instanceof Error) {
      respond({ error: `Could not prompt the subagent: ${accepted.message}` })
      child.process.kill()
      return
    }
    // The child is committed to its turn: announce the delegation, so the part
    // carries the child session and child_session_started lands while it runs.
    this.emit(
      session.translator.registerSubagent(String(call.callId ?? ''), { childSessionId: child.id, agent, ...(description && { description }) }),
      { type: 'task_child_started' },
    )
    const result = await this.finishChildTurn(child, idle)
    respond(result instanceof Error ? { error: result.message } : { output: result })
    // One-shot subagent: the session file stays for lineage and /fork-subagent;
    // the process does not outlive the task.
    child.process.kill()
  }

  /** Collect a finished child turn; its final assistant text is the tool result. */
  private async finishChildTurn(child: RunningSession, idle: Promise<void>): Promise<string | Error> {
    await idle
    const messages = await child.process.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
    if (messages instanceof Error) return new AgentRequestError({ detail: messages.message })
    const text = finalAssistantText(messages.messages)
    return text || new AgentRequestError({ detail: 'The subagent returned no text' })
  }

  private mcpServersFor(directory: string): Record<string, PiMcpServer> {
    const servers = { ...projectMcpServers(directory), ...this.addedMcp.get(directory) }
    for (const [name, enabled] of this.mcpEnabled.get(directory) ?? []) {
      if (servers[name]) servers[name] = { ...servers[name], enabled }
    }
    return servers
  }

  /** Rewrite the MCP file of every running session in a directory; Pi picks it up before the next run. */
  private refreshMcp(directory: string) {
    const servers = this.mcpServersFor(directory)
    for (const session of this.sessions.values()) {
      if (session.directory === directory && !session.process.exited) writeMcpFile(session.mcpFile, servers)
    }
  }

  /**
   * The per-turn tool-shell environment, as OpenCode's shell.env hook builds it:
   * the session's scoped agent token, ROADIE_SESSION_ID, the current turn's
   * attribution and the configured --shell-env templates. The extension
   * prepends it to every bash command.
   */
  /** The session's tool-shell pool key, issued once and kept across its Pi processes. */
  private shellPoolKey(sessionId: string): string | undefined {
    const pool = this.options.pool
    if (!pool) return undefined
    let key = this.shellPoolKeys.get(sessionId)
    if (!key) {
      key = pool.issueKey(() => sessionId)
      this.shellPoolKeys.set(sessionId, key)
    }
    return key
  }

  private async writeShellEnv(file: string, sessionId: string) {
    const env: Record<string, string> = {}
    applyAgentShellEnv({ env, secret: process.env[AGENT_TOKEN_SECRET_ENV], sessionId })
    env[ROADIE_SESSION_ID_ENV] = sessionId
    const shellKey = this.shellPoolKey(sessionId)
    if (shellKey) env[PI_KEY_ENV] = shellKey
    const attribution = await resolveTurnAttribution(sessionId).catch(() => undefined)
    applyTurnAttributionEnv({ env, attribution })
    applyShellEnvTemplates({
      env,
      sessionId,
      attribution,
      templates: this.options.shellEnvTemplates,
    })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(env), { mode: 0o600 })
    fs.renameSync(temp, file)
  }

  private touch(session: RunningSession) {
    session.updatedAt = Date.now()
    this.scheduleIdleStop(session)
  }

  /**
   * Record a context-only (`noReply`) message without starting a model turn.
   * Pi's RPC has no append primitive, so the backend prompts the Roadie
   * extension's `/roadie:append` command (extension commands run immediately,
   * even mid-turn) and the extension records the message with
   * `pi.sendMessage(..., { triggerTurn: false })`: it lands in the session
   * history, persisted, and the model reads it as a user message on the next
   * turn. An empty message records nothing.
   */
  private async appendContextMessage(session: RunningSession, text: string, images: Array<{ type: 'image'; data: string; mimeType: string }>): Promise<AgentRequestError | undefined> {
    if (!text && images.length === 0) return undefined
    const accepted = await session.process.request<{ disposition?: string }>({
      type: 'prompt',
      message: `/${ROADIE_APPEND_COMMAND} ${JSON.stringify({ text, images })}`,
    })
    if (accepted instanceof Error) return new AgentRequestError({ detail: accepted.message })
    if (accepted.disposition !== 'handled') {
      // The command never ran: Pi started a real turn with the literal message.
      session.translator.markAborting()
      await session.process.request({ type: 'abort' })
      return new AgentRequestError({ detail: 'Pi did not record the context-only message (Roadie append command missing)' })
    }
    return undefined
  }

  /** (Re)arm the idle stop. Never stops a busy session or one awaiting a permission reply. */
  private scheduleIdleStop(session: RunningSession) {
    clearTimeout(session.idleTimer)
    const timeout = this.options.idleTimeoutMs ?? 5 * 60_000
    if (timeout <= 0) return
    session.idleTimer = setTimeout(() => {
      const waiting = [...this.pendingPermissions.values(), ...this.pendingQuestions.values()].some((pending) => pending.session === session)
      // Pi writes the session file with the first message; before that the
      // session could not be resumed, so it keeps its process.
      if (session.busy || waiting || !fs.existsSync(session.sessionFile)) {
        this.scheduleIdleStop(session)
        return
      }
      session.process.kill()
    }, timeout)
    session.idleTimer.unref?.()
  }

  private toAgentSession(session: { id: string; title: string; directory: string; createdAt: number; updatedAt: number; model?: { provider: string; id: string } }): AgentSession {
    return {
      id: session.id,
      title: session.title,
      directory: session.directory,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.model && { model: { providerId: session.model.provider, modelId: session.model.id } }),
    }
  }

  private async providers(): Promise<AgentProviderCatalog | Error> {
    const ttl = this.options.catalogTtlMs ?? 5 * 60_000
    const cached = this.catalogCache
    // A TTL of 0 disables caching: every call re-probes.
    if (cached && ttl > 0 && Date.now() - cached.at < ttl) {
      const result = await cached.promise
      if (result instanceof Error) this.catalogCache = undefined
      return result
    }
    const probe = (async () => {
      // Any running process can list models; otherwise start a throwaway one.
      const running = [...this.sessions.values()].find((session) => !session.process.exited)
      const probe = running?.process ?? new PiProcess({
        bin: this.options.bin,
        args: ['--no-session', '--no-extensions', ...(this.options.model ? ['--model', this.options.model] : [])],
        cwd: this.options.sessionDir,
        env: { ...process.env, ...this.options.env },
      })
      const result = await probe.request<{ models: PiModel[] }>({ type: 'get_available_models' })
      if (!running) probe.kill()
      if (result instanceof Error) return result
      const byProvider = new Map<string, PiModel[]>()
      for (const model of result.models) {
        byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
      }
      const providers = [...byProvider].map(([id, models]) => ({
        id,
        name: id,
        models: Object.fromEntries(models.map((model) => [model.id, {
          id: model.id,
          name: model.name || model.id,
          ...(model.contextWindow && { contextLimit: model.contextWindow }),
          variants: model.reasoning ? THINKING_LEVELS : [],
        }])),
      }))
      const [defaultProvider, defaultModel] = (this.options.model ?? '').split('/')
      return {
        providers,
        connected: providers.map((provider) => provider.id),
        defaults: defaultProvider && defaultModel ? { [defaultProvider]: defaultModel } : {},
      }
    })()
    this.catalogCache = { promise: probe, at: Date.now() }
    const result = await probe
    if (result instanceof Error) this.catalogCache = undefined
    return result
  }

  /** A session's title: the in-memory cache first, else the persisted state (a restart emptied the cache). */
  private titleFor(sessionId: string): string {
    return this.titles.get(sessionId) ?? readSessionState(sessionStatePath(this.options.sessionDir, sessionId)).title ?? ''
  }

  /** A session's permission rules: the in-memory cache first, else the persisted state. */
  private rulesFor(sessionId: string): AgentPermissionRule[] {
    return this.permissionRules.get(sessionId) ?? readSessionState(sessionStatePath(this.options.sessionDir, sessionId)).permissionRules ?? []
  }

  /** Keep a session's title and/or rules with its session file, so they outlive this process. */
  private persistSessionState(sessionId: string, patch: { title?: string; permissionRules?: AgentPermissionRule[] }) {
    try {
      const file = sessionStatePath(this.options.sessionDir, sessionId)
      const state = { ...readSessionState(file), ...patch }
      writeSessionState(file, state)
    } catch {
      // Best effort: an unwritable state file must not fail the operation.
    }
  }

  private listOnDisk(): Array<{ id: string; title: string; directory: string; createdAt: number; updatedAt: number }> {
    return fs.readdirSync(this.options.sessionDir)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) => {
        const full = path.join(this.options.sessionDir, file)
        const header = readSessionHeader(full)
        if (!header) return []
        return [{
          id: header.id,
          title: this.titleFor(header.id),
          directory: header.cwd,
          createdAt: header.createdAt,
          updatedAt: fs.statSync(full).mtimeMs,
        }]
      })
  }

  private sessionOperations(): AgentSessionOperations {
    return {
      generateTitle: async (input) => this.generateTitle(input),
      create: async ({ directory, permission, title }) => {
        const session = await this.start({ directory, extra: [], ...(title && { title }) })
        if (session instanceof Error) return session
        if (permission) {
          this.permissionRules.set(session.id, permission)
          this.persistSessionState(session.id, { permissionRules: permission })
        }
        if (title) {
          this.titles.set(session.id, title)
          this.persistSessionState(session.id, { title })
          await session.process.request({ type: 'set_session_name', name: title })
        }
        const agentSession = this.toAgentSession(session)
        this.emit([{ type: 'session.created', session: agentSession }], { type: 'session_created' })
        return agentSession
      },
      get: async ({ sessionId }) => {
        const running = this.sessions.get(sessionId)
        if (running) return this.toAgentSession(running)
        const file = this.findSessionFile(sessionId)
        if (!file) return undefined
        const header = readSessionHeader(file)
        if (!header) return undefined
        return this.toAgentSession({
          id: sessionId,
          title: this.titleFor(sessionId),
          directory: header.cwd,
          createdAt: header.createdAt,
          updatedAt: fs.statSync(file).mtimeMs,
        })
      },
      setPermissions: async ({ sessionId, permission }) => {
        this.permissionRules.set(sessionId, permission)
        this.persistSessionState(sessionId, { permissionRules: permission })
      },
      messages: async ({ sessionId, directory, limit }) => {
        const session = await this.ensure(sessionId, directory)
        if (session instanceof Error) return session
        const result = await session.process.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
        if (result instanceof Error) return new AgentRequestError({ detail: result.message })
        const history = toAgentHistory({ messages: result.messages, sessionId })
        return limit !== undefined ? history.slice(-limit) : history
      },
      prompt: async ({ sessionId, directory, parts, system, agent, model, variant, noReply }) => {
        const session = await this.ensure(sessionId, directory)
        if (session instanceof Error) return session
        // The turn's agent: its system prompt, model and permission rules apply
        // like OpenCode applies an agent definition to a prompt. Unknown names
        // are rejected instead of silently running as the default agent.
        let turnSystem = system
        if (agent !== undefined) {
          const definition = agentFor({ directory: session.directory, agent })
          if (!definition) return new AgentRequestError({ detail: `Pi has no agent ${agent}` })
          if (definition.prompt) turnSystem = turnSystem !== undefined ? `${turnSystem}\n\n${definition.prompt}` : definition.prompt
          if (!noReply && !model && definition.model && (definition.model.providerId !== session.model?.provider || definition.model.modelId !== session.model?.id)) {
            const set = await session.process.request<PiModel>({ type: 'set_model', provider: definition.model.providerId, modelId: definition.model.modelId })
            if (set instanceof Error) return new AgentRequestError({ detail: set.message })
            session.model = { provider: set.provider, id: set.id }
          }
          if (definition.permission.length > 0 && !noReply) this.turnAgentRules.set(sessionId, definition.permission)
          else this.turnAgentRules.delete(sessionId)
        } else {
          this.turnAgentRules.delete(sessionId)
        }
        // Pi messages carry no agent; the turn's is stamped on its replies.
        if (!noReply) session.translator.setTurnAgent(agent)
        if (turnSystem !== undefined) fs.writeFileSync(session.systemFile, turnSystem)
        await this.writeShellEnv(session.shellEnvFile, sessionId)
        if (model && (model.providerId !== session.model?.provider || model.modelId !== session.model?.id)) {
          const set = await session.process.request<PiModel>({ type: 'set_model', provider: model.providerId, modelId: model.modelId })
          if (set instanceof Error) return new AgentRequestError({ detail: set.message })
          session.model = { provider: set.provider, id: set.id }
        }
        // The turn's variant: a thinking level applies to this and later turns;
        // clearing it (no variant) returns to the level Pi itself started with,
        // instead of silently keeping the previous override. Unknown variant
        // names are ignored, as before.
        if (variant && THINKING_LEVELS.includes(variant)) {
          if (variant !== session.thinking) {
            const set = await session.process.request({ type: 'set_thinking_level', level: variant })
            if (!(set instanceof Error)) session.thinking = variant
          }
        } else if (!variant && session.defaultThinking !== undefined && session.thinking !== session.defaultThinking) {
          const reset = await session.process.request({ type: 'set_thinking_level', level: session.defaultThinking })
          if (!(reset instanceof Error)) session.thinking = session.defaultThinking
        }
        const { message: typed, images } = promptText(parts)
        // Context-only message: record it without a model turn, so the agent
        // sees it on the next turn (see appendContextMessage).
        if (noReply) {
          const recorded = await this.appendContextMessage(session, typed, images)
          if (recorded) return recorded
          this.touch(session)
          return undefined
        }
        // Branch awareness: a note when the
        // checkout's branch (or detached HEAD) differs from the last one announced.
        const gitState = await resolveGitState({ directory: session.directory }).catch(() => null)
        const branch = shouldInjectBranch({ previousGitState: session.gitState, currentGitState: gitState })
        if (branch.inject) session.gitState = gitState!
        const message = branch.inject ? `${typed}\n${branch.text}` : typed
        const accepted = await session.process.request({
          type: 'prompt',
          message,
          ...(images.length > 0 && { images }),
          ...(session.busy && { streamingBehavior: 'followUp' }),
        })
        if (accepted instanceof Error) return new AgentRequestError({ detail: accepted.message })
        this.touch(session)
        return undefined
      },
      command: async ({ sessionId, directory, command, arguments: args, system, agent, model, variant }) => {
        const session = await this.ensure(sessionId, directory)
        if (session instanceof Error) return session
        const listed = await session.process.request<{ commands: PiCommand[] }>({ type: 'get_commands' })
        const names = new Set(listed instanceof Error ? [] : listed.commands.map((c) => c.name))
        const piName = names.has(command) ? command : names.has(`skill:${command}`) ? `skill:${command}` : undefined
        if (!piName) return new AgentRequestError({ detail: `Unknown command /${command}` })
        return this.backend.sessions.prompt({
          sessionId,
          directory,
          parts: [{ kind: 'text', text: `/${piName}${args ? ` ${args}` : ''}` }],
          ...(system !== undefined && { system }),
          ...(agent && { agent }),
          ...(model && { model }),
          ...(variant && { variant }),
        })
      },
      abort: async ({ sessionId }) => {
        const session = this.sessions.get(sessionId)
        const dead = !session || session.process.exited
        // A session that is not running cannot be aborted, but prompts it left
        // pending (an open question, task call or permission ask whose process
        // exited) must not outlive the abort — dismiss them so nothing answers
        // a dead process or resumes after it.
        this.cancelQuestions(sessionId, { permissions: dead })
        // Aborting a parent stops its running task children too.
        for (const child of this.sessions.values()) {
          if (child.childOf === sessionId && !child.process.exited) {
            child.translator.markAborting()
            void child.process.request({ type: 'abort' })
          }
        }
        if (dead) return undefined
        session!.translator.markAborting()
        const result = await session!.process.request({ type: 'abort' })
        return result instanceof Error ? new AgentRequestError({ detail: result.message }) : undefined
      },
      status: async ({ directory }) => {
        const statuses: Record<string, AgentStatus> = {}
        for (const session of this.sessions.values()) {
          if (session.busy && session.directory === directory) statuses[session.id] = { state: 'busy' }
        }
        return statuses
      },
      replyPermission: async ({ requestId, reply }) => {
        const pending = this.pendingPermissions.get(requestId)
        if (!pending) return new AgentRequestError({ detail: `No pending Pi permission request ${requestId}` })
        this.pendingPermissions.delete(requestId)
        if (reply === 'always') {
          const rules = this.rulesFor(pending.sessionId)
          const patterns = pending.patterns.length > 0 ? pending.patterns : ['*']
          const updated = [
            ...rules,
            ...patterns.map((pattern) => ({ permission: pending.permission, pattern, action: 'allow' as const })),
          ]
          this.permissionRules.set(pending.sessionId, updated)
          this.persistSessionState(pending.sessionId, { permissionRules: updated })
        }
        pending.session.process.send({ type: 'extension_ui_response', id: requestId, confirmed: reply !== 'reject' })
        this.emit([{ type: 'permission.replied', sessionId: pending.sessionId, requestId, reply }], { type: 'permission_replied' })
        return undefined
      },
      questions: async ({ directory }) => [...this.pendingQuestions.entries()]
        .filter(([, pending]) => pending.session.directory === directory)
        .map(([id, pending]) => ({ id, sessionId: pending.sessionId })),
      replyQuestion: async ({ requestId, answers }) => {
        const pending = this.pendingQuestions.get(requestId)
        if (!pending) return new AgentRequestError({ detail: `No pending Pi question ${requestId}` })
        this.pendingQuestions.delete(requestId)
        pending.session.process.send({ type: 'extension_ui_response', id: requestId, value: JSON.stringify({ answers }) })
        this.emit([{ type: 'question.replied', sessionId: pending.sessionId, requestId, answers }], { type: 'question_replied' })
        return undefined
      },
      setTitle: async ({ sessionId, title }) => {
        this.titles.set(sessionId, title)
        // A session that is not running has no Pi-side name to update, but its
        // persisted title must still move, or the old one comes back after a
        // restart (listOnDisk reads this state).
        this.persistSessionState(sessionId, { title })
        const session = this.sessions.get(sessionId)
        if (!session) return undefined
        session.title = title
        const result = await session.process.request({ type: 'set_session_name', name: title })
        if (result instanceof Error) return new AgentRequestError({ detail: result.message })
        this.emit([{ type: 'session.updated', session: this.toAgentSession(session) }], { type: 'session_renamed' })
        return undefined
      },
      list: async ({ directory }) => {
        const byId = new Map(this.listOnDisk().map((session) => [session.id, session]))
        for (const session of this.sessions.values()) byId.set(session.id, session)
        return [...byId.values()]
          .filter((session) => directory === undefined || session.directory === directory)
          .map((session) => this.toAgentSession(session))
      },
      delete: async ({ sessionId }) => {
        const file = this.findSessionFile(sessionId)
        this.sessions.get(sessionId)?.process.kill()
        this.sessions.delete(sessionId)
        this.turnAgentRules.delete(sessionId)
        const shellKey = this.shellPoolKeys.get(sessionId)
        if (shellKey) this.options.pool?.revokeKey(shellKey)
        this.shellPoolKeys.delete(sessionId)
        if (file) fs.rmSync(file, { force: true })
        fs.rmSync(sessionStatePath(this.options.sessionDir, sessionId), { force: true })
        return undefined
      },
      fork: async ({ sessionId, messageId, targetDirectory }) => {
        const file = this.findSessionFile(sessionId)
        if (!file) return new AgentRequestError({ detail: `Pi session ${sessionId} not found` })
        const forked = await this.forkFile({ file, messageId })
        if (forked instanceof Error) return forked
        // A fork bound to a workspace runs there: Roadie resumes a session in
        // the directory its header names.
        if (targetDirectory) setSessionHeaderCwd(forked.sessionFile, targetDirectory)
        const rules = this.rulesFor(sessionId)
        if (rules.length > 0) {
          this.permissionRules.set(forked.sessionId, rules)
          this.persistSessionState(forked.sessionId, { permissionRules: rules })
        }
        const title = this.sessions.get(sessionId)?.title || this.titleFor(sessionId) || undefined
        if (title) {
          this.titles.set(forked.sessionId, title)
          this.persistSessionState(forked.sessionId, { title })
        }
        const session = await this.backend.sessions.get({ sessionId: forked.sessionId })
        if (!session || session instanceof Error) return session ?? new AgentRequestError({ detail: 'Pi fork produced no session' })
        return session
      },
      summarize: async ({ sessionId, directory, model }) => {
        const session = await this.ensure(sessionId, directory)
        if (session instanceof Error) return session
        // Pi's compact runs on the session's current model, but the caller
        // asked for one (the model the conversation was driven with): switch
        // to it for the summary, then give the session its own model back.
        const previous = session.model
        const switching = Boolean(model && (model.providerId !== previous?.provider || model.modelId !== previous?.id))
        if (switching) {
          const set = await session.process.request<PiModel>({ type: 'set_model', provider: model!.providerId, modelId: model!.modelId })
          if (set instanceof Error) return new AgentRequestError({ detail: set.message })
          session.model = { provider: set.provider, id: set.id }
        }
        const restore = async () => {
          if (!switching || !previous) return
          const set = await session.process.request<PiModel>({ type: 'set_model', provider: previous.provider, modelId: previous.id })
          if (!(set instanceof Error)) session.model = { provider: set.provider, id: set.id }
        }
        const result = await session.process.request({ type: 'compact' })
        if (result instanceof Error) {
          await restore()
          return new AgentRequestError({ detail: result.message })
        }
        await restore()
        return undefined
      },
    }
  }
}
