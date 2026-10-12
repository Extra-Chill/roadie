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
// person replies. Pi's own defaults allow everything, like Roadie's OpenCode
// setup, so `allow` is the fallback and session rules override it.
//
// Gaps (spike): no MCP, no question tool, no slash commands, no workspace-bound
// forks or fork-at-message, no OAuth through Roadie (sign in with `pi` itself).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { evaluatePermission } from '../../permission-policy.js'
import type { AgentEvent, AgentSession, AgentStatus } from '../events.js'
import {
  AgentRequestError,
  type AgentBackend,
  type AgentBackendEvent,
  type AgentBackendProvider,
  type AgentPermissionRule,
  type AgentPromptPart,
  type AgentProviderCatalog,
  type AgentSessionOperations,
} from '../types.js'
import { PiEventTranslator, toAgentHistory, type PiMessage } from './events.js'
import { PiProcess, type PiRecord } from './rpc.js'
import { roadieToolSchemas, runRoadieTool } from '../../roadie-tools.js'

const PERMISSION_TITLE = 'roadie:permission'
const TOOL_TITLE = 'roadie:tool'
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high']

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
}

type PiModel = { id: string; name?: string; provider: string; reasoning?: boolean; contextWindow?: number }

type PendingPermission = { uiId: string; sessionId: string; permission: string; patterns: string[] }

type RunningSession = {
  id: string
  directory: string
  sessionFile: string
  systemFile: string
  process: PiProcess
  translator: PiEventTranslator
  title: string
  createdAt: number
  updatedAt: number
  busy: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  model?: { provider: string; id: string }
  thinking?: string
}

function extensionPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const ts = path.join(here, 'roadie-extension.ts')
  return fs.existsSync(ts) ? ts : path.join(here, 'roadie-extension.js')
}

/** Which permission and targets a Pi tool call asks for, in OpenCode's vocabulary. */
export function permissionForToolCall({ tool, input, cwd }: { tool: string; input: Record<string, unknown>; cwd: string }): Array<{ permission: string; targets: string[] }> {
  const filePath = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : undefined
  const checks: Array<{ permission: string; targets: string[] }> = []
  if (tool === 'bash') checks.push({ permission: 'bash', targets: [String(input.command ?? '')] })
  else if (tool === 'edit' || tool === 'write') checks.push({ permission: 'edit', targets: filePath ? [filePath] : [] })
  else if (tool === 'read' || tool === 'grep' || tool === 'find' || tool === 'ls') checks.push({ permission: tool === 'read' ? 'read' : tool, targets: filePath ? [filePath] : [] })
  else checks.push({ permission: tool, targets: [] })
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
    const action = evaluatePermission({ rules, permission: check.permission, targets: check.targets, fallback: 'allow' })
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
  private starting = new Map<string, Promise<RunningSession | Error>>()
  private titles = new Map<string, string>()
  private permissionRules = new Map<string, AgentPermissionRule[]>()
  private pendingPermissions = new Map<string, PendingPermission & { session: RunningSession }>()
  private subscribers = new Set<(event: AgentBackendEvent) => void>()
  private catalogCache: Promise<AgentProviderCatalog | Error> | undefined
  private backend: AgentBackend
  private toolsFile: string

  constructor(readonly options: PiBackendOptions) {
    fs.mkdirSync(options.sessionDir, { recursive: true })
    this.toolsFile = path.join(options.sessionDir, 'roadie-tools.json')
    fs.writeFileSync(this.toolsFile, JSON.stringify(roadieToolSchemas()))
    this.backend = {
      sessions: this.sessionOperations(),
      catalog: {
        providers: () => this.providers(),
        config: async () => (options.model ? { model: options.model } : {}),
        agents: async () => [{ name: 'build', description: 'Pi coding agent', mode: 'primary' }],
      },
      auth: {
        methods: async () => ({}),
        startOAuth: async () => new AgentRequestError({ detail: 'Sign in to providers with `pi` itself; Roadie does not manage Pi credentials yet.' }),
        finishOAuth: async () => new AgentRequestError({ detail: 'Sign in to providers with `pi` itself.' }),
        setApiKey: async () => new AgentRequestError({ detail: 'Configure Pi API keys in its auth.json; Roadie does not manage Pi credentials yet.' }),
      },
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

  /** Stop every Pi process. */
  dispose() {
    for (const session of this.sessions.values()) session.process.kill()
    this.sessions.clear()
  }

  private emit(events: AgentEvent[], raw: unknown) {
    if (events.length === 0) return
    for (const subscriber of this.subscribers) subscriber({ events, raw })
  }

  private findSessionFile(sessionId: string): string | undefined {
    const running = this.sessions.get(sessionId)
    if (running) return running.sessionFile
    if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return undefined
    const name = fs.readdirSync(this.options.sessionDir).find((file) => file.endsWith(`_${sessionId}.jsonl`))
    return name ? path.join(this.options.sessionDir, name) : undefined
  }

  private spawnArgs(extra: string[]): string[] {
    return [
      '--session-dir', this.options.sessionDir,
      '-e', extensionPath(),
      ...(this.options.model ? ['--model', this.options.model] : []),
      ...extra,
    ]
  }

  /** Start a Pi process and wire it to the event stream. */
  private async start({ directory, extra, title }: { directory: string; extra: string[]; title?: string }): Promise<RunningSession | Error> {
    const systemFile = path.join(this.options.sessionDir, `system-${crypto.randomUUID()}.md`)
    fs.writeFileSync(systemFile, '')
    const child = new PiProcess({
      bin: this.options.bin,
      args: this.spawnArgs(extra),
      cwd: directory,
      env: { ...process.env, ...this.options.env, ROADIE_PI_SYSTEM_FILE: systemFile, ROADIE_PI_TOOLS_FILE: this.toolsFile },
    })
    const state = await child.request<{ sessionId: string; sessionFile: string; sessionName?: string; model?: PiModel; thinkingLevel?: string }>({ type: 'get_state' })
    if (state instanceof Error) {
      child.kill()
      return state
    }
    const header = readSessionHeader(state.sessionFile)
    const session: RunningSession = {
      id: state.sessionId,
      directory,
      sessionFile: state.sessionFile,
      systemFile,
      process: child,
      translator: new PiEventTranslator(state.sessionId),
      title: title ?? state.sessionName ?? this.titles.get(state.sessionId) ?? '',
      createdAt: header?.createdAt || Date.now(),
      updatedAt: Date.now(),
      busy: false,
      ...(state.model && { model: { provider: state.model.provider, id: state.model.id } }),
      ...(state.thinkingLevel && { thinking: state.thinkingLevel }),
    }
    this.sessions.set(session.id, session)
    this.scheduleIdleStop(session)
    child.onRecord((record) => this.onRecord(session, record))
    child.onExit(() => {
      clearTimeout(session.idleTimer)
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id)
      fs.rmSync(systemFile, { force: true })
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
    if (record.type === 'agent_end') {
      session.busy = false
      this.touch(session)
    }
    this.emit(session.translator.translate(record), record)
  }

  private onUiRequest(session: RunningSession, record: PiRecord) {
    const uiId = String(record.id)
    if (record.method === 'notify') {
      const level = record.notifyType === 'error' ? 'error' : record.notifyType === 'warning' ? 'warning' : 'info'
      this.emit([{ type: 'notice', message: String(record.message ?? ''), level }], record)
      return
    }
    if (record.method === 'input' && record.title === TOOL_TITLE) {
      void this.runTool(session, uiId, String(record.placeholder ?? ''))
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
      rules: this.permissionRules.get(session.id) ?? [],
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

  private touch(session: RunningSession) {
    session.updatedAt = Date.now()
    this.scheduleIdleStop(session)
  }

  /** (Re)arm the idle stop. Never stops a busy session or one awaiting a permission reply. */
  private scheduleIdleStop(session: RunningSession) {
    clearTimeout(session.idleTimer)
    const timeout = this.options.idleTimeoutMs ?? 5 * 60_000
    if (timeout <= 0) return
    session.idleTimer = setTimeout(() => {
      const waiting = [...this.pendingPermissions.values()].some((pending) => pending.session === session)
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
    this.catalogCache ??= (async () => {
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
    const result = await this.catalogCache
    if (result instanceof Error) this.catalogCache = undefined
    return result
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
          title: this.titles.get(header.id) ?? '',
          directory: header.cwd,
          createdAt: header.createdAt,
          updatedAt: fs.statSync(full).mtimeMs,
        }]
      })
  }

  private sessionOperations(): AgentSessionOperations {
    return {
      create: async ({ directory, permission, title }) => {
        const session = await this.start({ directory, extra: [], ...(title && { title }) })
        if (session instanceof Error) return session
        if (permission) this.permissionRules.set(session.id, permission)
        if (title) await session.process.request({ type: 'set_session_name', name: title })
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
          title: this.titles.get(sessionId) ?? '',
          directory: header.cwd,
          createdAt: header.createdAt,
          updatedAt: fs.statSync(file).mtimeMs,
        })
      },
      setPermissions: async ({ sessionId, permission }) => {
        this.permissionRules.set(sessionId, permission)
      },
      messages: async ({ sessionId, directory, limit }) => {
        const session = await this.ensure(sessionId, directory)
        if (session instanceof Error) return session
        const result = await session.process.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
        if (result instanceof Error) return new AgentRequestError({ detail: result.message })
        const history = toAgentHistory({ messages: result.messages, sessionId })
        return limit !== undefined ? history.slice(-limit) : history
      },
      prompt: async ({ sessionId, directory, parts, system, model, variant, noReply }) => {
        // Pi has no "record without a turn"; Roadie uses noReply for context-only messages.
        if (noReply) return undefined
        const session = await this.ensure(sessionId, directory)
        if (session instanceof Error) return session
        if (system !== undefined) fs.writeFileSync(session.systemFile, system)
        if (model && (model.providerId !== session.model?.provider || model.modelId !== session.model?.id)) {
          const set = await session.process.request<PiModel>({ type: 'set_model', provider: model.providerId, modelId: model.modelId })
          if (set instanceof Error) return new AgentRequestError({ detail: set.message })
          session.model = { provider: set.provider, id: set.id }
        }
        if (variant && THINKING_LEVELS.includes(variant) && variant !== session.thinking) {
          const set = await session.process.request({ type: 'set_thinking_level', level: variant })
          if (!(set instanceof Error)) session.thinking = variant
        }
        const { message, images } = promptText(parts)
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
      command: async ({ command }) => new AgentRequestError({ detail: `Pi sessions do not support /${command} yet` }),
      abort: async ({ sessionId }) => {
        const session = this.sessions.get(sessionId)
        if (!session) return undefined
        const result = await session.process.request({ type: 'abort' })
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
          const rules = this.permissionRules.get(pending.sessionId) ?? []
          const patterns = pending.patterns.length > 0 ? pending.patterns : ['*']
          this.permissionRules.set(pending.sessionId, [
            ...rules,
            ...patterns.map((pattern) => ({ permission: pending.permission, pattern, action: 'allow' as const })),
          ])
        }
        pending.session.process.send({ type: 'extension_ui_response', id: requestId, confirmed: reply !== 'reject' })
        this.emit([{ type: 'permission.replied', sessionId: pending.sessionId, requestId, reply }], { type: 'permission_replied' })
        return undefined
      },
      setTitle: async ({ sessionId, title }) => {
        this.titles.set(sessionId, title)
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
        if (file) fs.rmSync(file, { force: true })
        return undefined
      },
      fork: async ({ sessionId, directory, messageId, targetDirectory }) => {
        if (messageId || targetDirectory) {
          return new AgentRequestError({ detail: 'Pi sessions can only be forked whole, in place, for now' })
        }
        const file = this.findSessionFile(sessionId)
        if (!file) return new AgentRequestError({ detail: `Pi session ${sessionId} not found` })
        const cwd = directory ?? readSessionHeader(file)?.cwd
        if (!cwd) return new AgentRequestError({ detail: `Pi session ${sessionId} has no working directory` })
        const source = this.sessions.get(sessionId)
        const forked = await this.start({ directory: cwd, extra: ['--fork', file], title: source?.title ?? '' })
        if (forked instanceof Error) return forked
        const rules = this.permissionRules.get(sessionId)
        if (rules) this.permissionRules.set(forked.id, rules)
        return this.toAgentSession(forked)
      },
      summarize: async ({ sessionId, directory }) => {
        const session = await this.ensure(sessionId, directory)
        if (session instanceof Error) return session
        const result = await session.process.request({ type: 'compact' })
        return result instanceof Error ? new AgentRequestError({ detail: result.message }) : undefined
      },
    }
  }
}
