// Scoped agent endpoints for tool shells.
//
// An agent tool shell runs inside the OpenCode server's environment but must
// not hold the bot's database credentials (the shell.env hook blanks them and
// exports ROADIE_AGENT_TOKEN instead, see agent-token.ts). The `roadie`
// subcommands agents are told to run — send, session list/search/read/wait/
// editors/archive/abort/title/discord-url, task list/edit/delete, project
// list/add/create/remove/open-in-discord, thread list, user list — detect
// that mode here and call typed JSON endpoints on the bot's local HTTP server
// instead of opening the database.
//
// The bot never exposes SQL over these endpoints. Each endpoint maps a fixed
// request shape to the allowlisted arguments of one `roadie` subcommand and
// runs it as a child of the bot process (the same runner as /roadie/send),
// streaming its output back as NDJSON. The child does the database reads and
// writes and the Discord REST calls with the bot's own credentials, so the
// client relays byte-identical output and exit codes. Tasks (list, edit,
// delete) are scoped to the token's session or thread; search, read, project
// and listings stay as broad as the CLI already is for any local operator.
// Commands that manage the bot itself (bot token/status, credentials,
// upgrade, install URLs) and debug exports never reach an agent shell: the
// CLI refuses them in agent mode before touching the database.
//
// Agent tokens are never accepted on /v2 or /v2/pipeline (hrana) or by any
// admin route — only on the /roadie/agent/* paths below.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as errore from 'errore'
import { AGENT_TOKEN_ENV, verifyAgentToken } from './agent-token.js'
import { getLockPort, readRoadieSecret } from './config.js'
import { createLogger, LogPrefix } from './logger.js'
import {
  buildRemoteSendArgs,
  getRemoteSendRunner,
  readBody,
  relayRemoteRun,
  REMOTE_SEND_MAX_BODY_BYTES,
  type RemoteSendEvent,
} from './remote-send.js'
import { getScheduledTask, getThreadIdBySessionId } from './database.js'

const agentLogger = createLogger(LogPrefix.AGENT)

export const AGENT_SEND_PATH = '/roadie/agent/send'
export const AGENT_SESSION_SEARCH_PATH = '/roadie/agent/sessions/search'
export const AGENT_SESSION_EDITORS_PATH = '/roadie/agent/sessions/editors'
export const AGENT_SESSION_ARCHIVE_PATH = '/roadie/agent/sessions/archive'
export const AGENT_SESSION_TITLE_PATH = '/roadie/agent/sessions/title'
export const AGENT_SESSIONS_PATH = '/roadie/agent/sessions'
export const AGENT_TASKS_PATH = '/roadie/agent/tasks'
export const AGENT_PROJECTS_PATH = '/roadie/agent/projects'
export const AGENT_PROJECT_ADD_PATH = '/roadie/agent/projects/add'
export const AGENT_PROJECT_CREATE_PATH = '/roadie/agent/projects/create'
export const AGENT_PROJECT_REMOVE_PATH = '/roadie/agent/projects/remove'
export const AGENT_PROJECT_OPEN_IN_DISCORD_PATH = '/roadie/agent/projects/open-in-discord'
export const AGENT_THREADS_PATH = '/roadie/agent/threads'
export const AGENT_USERS_PATH = '/roadie/agent/users'

export class AgentRequestError extends Error {}

/** Message operator-only commands print when run inside an agent tool shell. */
export const AGENT_OPERATOR_ONLY_MESSAGE = 'this command is operator-only; ask the user to run it'

/**
 * True inside an agent tool shell: operator-only commands refuse there
 * instead of touching the database the shell cannot reach anyway.
 */
export function isAgentMode(): boolean {
  return !(resolveAgentCredentials() instanceof Error)
}

// ── Client side ──────────────────────────────────────────────────────

export type AgentCredentials = { token: string; port: number }

/**
 * Agent mode: running inside an OpenCode tool shell that holds a per-session
 * agent token and no usable database credential. Operator shells never have
 * ROADIE_OPENCODE_PROCESS set and keep opening the database directly.
 */
export function resolveAgentCredentials(): AgentCredentials | Error {
  if (!process.env.ROADIE_OPENCODE_PROCESS) {
    return new Error('Not running inside an OpenCode tool shell')
  }
  const token = process.env[AGENT_TOKEN_ENV]?.trim()
  if (!token) {
    return new Error('No agent token in this shell')
  }
  if (process.env.ROADIE_DB_URL) {
    return new Error('Database URL is available; not using agent endpoints')
  }
  const credential = errore.try({
    try: () => readRoadieSecret('ROADIE_DB_AUTH_TOKEN'),
    catch: (e) => new Error('Unreadable database credential', { cause: e }),
  })
  if (!(credential instanceof Error) && credential) {
    return new Error('Database credential is available; not using agent endpoints')
  }
  return { token, port: getLockPort() }
}

export type AgentCommandRequest = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  query?: Record<string, string>
  body?: unknown
}

/**
 * Call one agent endpoint on the running bot and relay its NDJSON stream to
 * stdout/stderr. Resolves with the remote exit code.
 */
export async function runAgentCommand({
  agent,
  request,
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  agent: AgentCredentials
  request: AgentCommandRequest
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
}): Promise<number> {
  const url = new URL(`http://127.0.0.1:${agent.port}${request.path}`)
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== '') url.searchParams.set(key, value)
  }
  const response = await fetch(url, {
    method: request.method,
    headers: {
      authorization: `Bearer ${agent.token}`,
      ...(request.body !== undefined && { 'content-type': 'application/json' }),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  }).catch((cause: unknown) => new Error(`Could not reach the running Roadie bot on port ${agent.port}`, { cause }))
  if (response instanceof Error) {
    stderr.write(`${response.message}\n`)
    return 1
  }
  if (!response.ok || !response.body) {
    stderr.write(`Roadie bot rejected the request (${response.status}): ${await response.text()}\n`)
    return 1
  }
  return relayRemoteRun(response.body, { stdout, stderr })
}

/** Query parameters for `session search` (the query text itself is `q`). */
export function sessionSearchQuery(options: {
  project?: string
  channel?: string
  all?: boolean
  days?: string | number
  limit?: string | number
  json?: boolean
}): Record<string, string> {
  const query: Record<string, string> = {}
  if (options.project) query.project = options.project
  if (options.channel) query.channel = options.channel
  if (options.all) query.all = '1'
  if (options.days !== undefined) query.days = String(options.days)
  if (options.limit !== undefined) query.limit = String(options.limit)
  if (options.json) query.json = '1'
  return query
}

/** Query parameters for `session read <sessionId>`. */
export function sessionReadQuery(options: {
  project?: string
  verbose?: boolean
  thinking?: boolean
  toolInputMaxChars?: string | number
}): Record<string, string> {
  const query: Record<string, string> = {}
  if (options.project) query.project = options.project
  if (options.verbose) query.verbose = '1'
  if (options.thinking) query.thinking = '1'
  if (options.toolInputMaxChars !== undefined) query.toolInputMaxChars = String(options.toolInputMaxChars)
  return query
}

/** Query parameters for `session list`. */
export function sessionListQuery(options: {
  project?: string
  all?: boolean
  active?: boolean
  exclude?: string
  json?: boolean
}): Record<string, string> {
  const query: Record<string, string> = {}
  if (options.project) query.project = options.project
  if (options.all) query.all = '1'
  if (options.active) query.active = '1'
  if (options.exclude) query.exclude = options.exclude
  if (options.json) query.json = '1'
  return query
}

/** Query parameters for `session editors <file>` (the file path itself is `file`). */
export function sessionEditorsQuery(options: {
  file: string
  json?: boolean
  limit?: string | number
}): Record<string, string> {
  const query: Record<string, string> = { file: options.file }
  if (options.json) query.json = '1'
  if (options.limit !== undefined) query.limit = String(options.limit)
  return query
}

/** Query parameters for `session discord-url <sessionId>`. */
export function sessionDiscordUrlQuery(options: {
  json?: boolean
}): Record<string, string> {
  const query: Record<string, string> = {}
  if (options.json) query.json = '1'
  return query
}

export type AgentSessionArchiveBody = {
  threadId?: string
  sessionId?: string
}

/** JSON body for `POST /roadie/agent/sessions/archive` (`session archive`). */
export function sessionArchiveBody(options: {
  threadId?: string
  session?: string
}): AgentSessionArchiveBody {
  const body: AgentSessionArchiveBody = {}
  if (options.threadId) body.threadId = options.threadId
  if (options.session) body.sessionId = options.session
  return body
}

export type AgentSessionTitleBody = {
  title: string
}

/** JSON body for `POST /roadie/agent/sessions/title` (`session title`). */
export function sessionTitleBody(options: {
  title: string
}): AgentSessionTitleBody {
  return { title: options.title }
}

/** Query parameters for `project list`. */
export function projectListQuery(options: {
  json?: boolean
  all?: boolean
  guild?: string
}): Record<string, string> {
  const query: Record<string, string> = {}
  if (options.json) query.json = '1'
  if (options.all) query.all = '1'
  if (options.guild) query.guild = options.guild
  return query
}

export type AgentProjectAddBody = {
  directory?: string
  guild?: string
  appId?: string
}

/** JSON body for `POST /roadie/agent/projects/add` (`project add`). */
export function projectAddBody(options: {
  directory?: string
  guild?: string
  appId?: string
}): AgentProjectAddBody {
  const body: AgentProjectAddBody = {}
  if (options.directory) body.directory = options.directory
  if (options.guild) body.guild = options.guild
  if (options.appId) body.appId = options.appId
  return body
}

export type AgentProjectCreateBody = {
  name: string
  guild?: string
  projectsDir?: string
}

/** JSON body for `POST /roadie/agent/projects/create` (`project create`). */
export function projectCreateBody(options: {
  name: string
  guild?: string
  projectsDir?: string
}): AgentProjectCreateBody {
  const body: AgentProjectCreateBody = { name: options.name }
  if (options.guild) body.guild = options.guild
  if (options.projectsDir) body.projectsDir = options.projectsDir
  return body
}

export type AgentProjectRemoveBody = {
  channelId: string
}

/** JSON body for `POST /roadie/agent/projects/remove` (`project remove`). */
export function projectRemoveBody(options: {
  channelId: string
}): AgentProjectRemoveBody {
  return { channelId: options.channelId }
}

export type AgentProjectOpenInDiscordBody = {
  directory: string
}

/** JSON body for `POST /roadie/agent/projects/open-in-discord`. */
export function projectOpenInDiscordBody(options: {
  directory: string
}): AgentProjectOpenInDiscordBody {
  return { directory: options.directory }
}

/** Query parameters for `thread list`. */
export function threadListQuery(options: {
  channel: string
  json?: boolean
  limit?: string | number
}): Record<string, string> {
  const query: Record<string, string> = { channel: options.channel }
  if (options.json) query.json = '1'
  if (options.limit !== undefined) query.limit = String(options.limit)
  return query
}

/** Query parameters for `user list` (the search text is `query`). */
export function userListQuery(options: {
  guild: string
  query?: string
}): Record<string, string> {
  const query: Record<string, string> = { guild: options.guild }
  if (options.query) query.query = options.query
  return query
}

export type AgentTaskEditBody = {
  prompt?: string
  sendAt?: string
  agent?: string
  model?: string
  preRun?: string
  allowConcurrency?: string
  user?: string
}

/** JSON body for `PATCH /roadie/agent/tasks/:id` (`task edit`). */
export function taskEditBody(options: {
  prompt?: string
  sendAt?: string
  agent?: string
  model?: string
  preRun?: string
  allowConcurrency?: string
  user?: string
}): AgentTaskEditBody {
  const body: AgentTaskEditBody = {}
  if (options.prompt !== undefined) body.prompt = options.prompt
  if (options.sendAt !== undefined) body.sendAt = options.sendAt
  if (options.agent !== undefined) body.agent = options.agent
  if (options.model !== undefined) body.model = options.model
  if (options.preRun !== undefined) body.preRun = options.preRun
  if (options.allowConcurrency !== undefined) body.allowConcurrency = options.allowConcurrency
  if (options.user !== undefined) body.user = options.user
  return body
}

// ── Bot side: request shape → allowlisted subcommand arguments ──────

function queryValue(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name)
  if (value === null || value === '') return undefined
  if (value.includes('\0')) throw new AgentRequestError(`${name} must not contain NUL characters`)
  return value
}

function requireQueryValue(query: URLSearchParams, name: string): string {
  const value = queryValue(query, name)
  if (value === undefined) throw new AgentRequestError(`${name} is required`)
  return value
}

function queryFlag(query: URLSearchParams, name: string): boolean {
  const value = query.get(name)
  return value === '1' || value === 'true'
}

function queryInteger(query: URLSearchParams, name: string, min: number): string | undefined {
  const value = queryValue(query, name)
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < min) {
    throw new AgentRequestError(`${name} must be an integer >= ${min}`)
  }
  return value
}

function pathSegment(segment: string, label: string): string {
  const value = errore.try({
    try: () => decodeURIComponent(segment),
    catch: (e) => new AgentRequestError(`Invalid ${label}`, { cause: e }),
  })
  if (value instanceof Error) throw value
  if (!value || value.includes('\0')) throw new AgentRequestError(`${label} is required`)
  return value
}

function parseAgentTaskId(segment: string): number {
  const value = pathSegment(segment, 'task id')
  const taskId = Number.parseInt(value, 10)
  if (Number.isNaN(taskId) || taskId < 1 || String(taskId) !== value) {
    throw new AgentRequestError(`Invalid task ID: ${value}`)
  }
  return taskId
}

export function buildAgentSessionSearchArgs(query: URLSearchParams): string[] {
  const args = ['session', 'search', requireQueryValue(query, 'q')]
  const project = queryValue(query, 'project')
  if (project) args.push(`--project=${project}`)
  const channel = queryValue(query, 'channel')
  if (channel) args.push(`--channel=${channel}`)
  if (queryFlag(query, 'all')) args.push('--all')
  const days = queryInteger(query, 'days', 0)
  if (days !== undefined) args.push(`--days=${days}`)
  const limit = queryInteger(query, 'limit', 1)
  if (limit !== undefined) args.push(`--limit=${limit}`)
  if (queryFlag(query, 'json')) args.push('--json')
  return args
}

export function buildAgentSessionReadArgs({
  sessionId,
  query,
}: {
  sessionId: string
  query: URLSearchParams
}): string[] {
  const args = ['session', 'read', sessionId]
  const project = queryValue(query, 'project')
  if (project) args.push(`--project=${project}`)
  if (queryFlag(query, 'verbose')) args.push('--verbose')
  if (queryFlag(query, 'thinking')) args.push('--thinking')
  const toolInputMaxChars = queryInteger(query, 'toolInputMaxChars', 1)
  if (toolInputMaxChars !== undefined) args.push(`--tool-input-max-chars=${toolInputMaxChars}`)
  return args
}

export function buildAgentSessionWaitArgs({ sessionId }: { sessionId: string }): string[] {
  return ['session', 'wait', sessionId]
}

export function buildAgentSessionListArgs(query: URLSearchParams): string[] {
  const args = ['session', 'list']
  const project = queryValue(query, 'project')
  if (project) args.push(`--project=${project}`)
  if (queryFlag(query, 'all')) args.push('--all')
  if (queryFlag(query, 'active')) args.push('--active')
  const exclude = queryValue(query, 'exclude')
  if (exclude) args.push(`--exclude=${exclude}`)
  if (queryFlag(query, 'json')) args.push('--json')
  return args
}

export function buildAgentSessionEditorsArgs(query: URLSearchParams): string[] {
  const args = ['session', 'editors', requireQueryValue(query, 'file')]
  if (queryFlag(query, 'json')) args.push('--json')
  const limit = queryInteger(query, 'limit', 1)
  if (limit !== undefined) args.push(`--limit=${limit}`)
  return args
}

export function buildAgentSessionArchiveArgs(body: unknown): string[] {
  const fields = jsonObjectBody(body)
  rejectUnknownFields(fields, ['threadId', 'sessionId'])
  const threadId = bodyString(fields, 'threadId')
  const sessionId = bodyString(fields, 'sessionId')
  // Same exclusive-or rule as the CLI.
  if (threadId && sessionId) {
    throw new AgentRequestError('Use either threadId or sessionId, not both')
  }
  const args = ['session', 'archive']
  if (threadId) args.push(threadId)
  if (sessionId) args.push(`--session=${sessionId}`)
  return args
}

export function buildAgentSessionTitleArgs({
  body,
  sessionId,
}: {
  body: unknown
  sessionId: string
}): string[] {
  const fields = jsonObjectBody(body)
  rejectUnknownFields(fields, ['title'])
  const title = bodyString(fields, 'title')
  if (!title || !title.trim()) {
    throw new AgentRequestError('Title must not be empty')
  }
  // The endpoint always retitles the token's own session; the client cannot
  // name another one.
  return ['session', 'title', title, `--session=${sessionId}`]
}

export function buildAgentSessionAbortArgs({ sessionId }: { sessionId: string }): string[] {
  return ['session', 'abort', sessionId]
}

export function buildAgentSessionDiscordUrlArgs({
  sessionId,
  query,
}: {
  sessionId: string
  query: URLSearchParams
}): string[] {
  const args = ['session', 'discord-url', sessionId]
  if (queryFlag(query, 'json')) args.push('--json')
  return args
}

export function buildAgentTaskListArgs(query: URLSearchParams, sessionId: string): string[] {
  const args = ['task', 'list']
  if (queryFlag(query, 'all')) args.push('--all')
  // The token decides the scope; the client cannot widen it.
  args.push(`--session=${sessionId}`)
  return args
}

export function buildAgentTaskDeleteArgs({ taskId }: { taskId: number }): string[] {
  return ['task', 'delete', String(taskId)]
}

const AGENT_TASK_EDIT_FIELDS = [
  ['prompt', '--prompt'],
  ['sendAt', '--send-at'],
  ['agent', '--agent'],
  ['model', '--model'],
  ['preRun', '--pre-run'],
  ['allowConcurrency', '--allow-concurrency'],
  ['user', '--user'],
] as const

export function buildAgentTaskEditArgs({
  taskId,
  body,
}: {
  taskId: number
  body: unknown
}): string[] {
  const fields = jsonObjectBody(body)
  rejectUnknownFields(fields, AGENT_TASK_EDIT_FIELDS.map(([field]) => field))
  const args = ['task', 'edit', String(taskId)]
  for (const [key, flag] of AGENT_TASK_EDIT_FIELDS) {
    const value = bodyString(fields, key)
    if (value === undefined) continue
    if (key === 'allowConcurrency' && value !== 'true' && value !== 'false') {
      throw new AgentRequestError('allowConcurrency must be "true" or "false"')
    }
    // Values travel as --flag=value, so one starting with '-' stays a value.
    args.push(`${flag}=${value}`)
  }
  return args
}

export function buildAgentProjectListArgs(query: URLSearchParams): string[] {
  const args = ['project', 'list']
  if (queryFlag(query, 'json')) args.push('--json')
  if (queryFlag(query, 'all')) args.push('--all')
  const guild = queryValue(query, 'guild')
  if (guild) args.push(`--guild=${guild}`)
  // --prune is deliberately unreachable: agents never delete mappings.
  return args
}

export function buildAgentProjectAddArgs(body: unknown): string[] {
  const fields = jsonObjectBody(body)
  rejectUnknownFields(fields, ['directory', 'guild', 'appId'])
  const args = ['project', 'add']
  const directory = bodyString(fields, 'directory')
  if (directory) args.push(directory)
  const guild = bodyString(fields, 'guild')
  if (guild) args.push(`--guild=${guild}`)
  const appId = bodyString(fields, 'appId')
  if (appId) args.push(`--app-id=${appId}`)
  return args
}

export function buildAgentProjectCreateArgs(body: unknown): string[] {
  const fields = jsonObjectBody(body)
  rejectUnknownFields(fields, ['name', 'guild', 'projectsDir'])
  const name = bodyString(fields, 'name')
  if (!name) throw new AgentRequestError('name is required')
  const args = ['project', 'create', name]
  const guild = bodyString(fields, 'guild')
  if (guild) args.push(`--guild=${guild}`)
  const projectsDir = bodyString(fields, 'projectsDir')
  if (projectsDir) args.push(`--projects-dir=${projectsDir}`)
  return args
}

export function buildAgentProjectRemoveArgs(body: unknown): string[] {
  const fields = jsonObjectBody(body)
  rejectUnknownFields(fields, ['channelId'])
  const channelId = bodyString(fields, 'channelId')
  if (!channelId) throw new AgentRequestError('channelId is required')
  return ['project', 'remove', channelId]
}

export function buildAgentProjectOpenInDiscordArgs(body: unknown): string[] {
  const fields = jsonObjectBody(body)
  rejectUnknownFields(fields, ['directory'])
  const directory = bodyString(fields, 'directory')
  if (!directory) throw new AgentRequestError('directory is required')
  return ['project', 'open-in-discord', directory]
}

export function buildAgentThreadListArgs(query: URLSearchParams): string[] {
  const args = ['thread', 'list', `--channel=${requireQueryValue(query, 'channel')}`]
  if (queryFlag(query, 'json')) args.push('--json')
  const limit = queryInteger(query, 'limit', 1)
  if (limit !== undefined) args.push(`--limit=${limit}`)
  return args
}

export function buildAgentUserListArgs(query: URLSearchParams): string[] {
  const args = ['user', 'list', `--guild=${requireQueryValue(query, 'guild')}`]
  const search = queryValue(query, 'query')
  if (search) args.push(`--query=${search}`)
  return args
}

// ── Bot side: JSON body shape checks ─────────────────────────────────

function jsonObjectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentRequestError('Body must be a JSON object')
  }
  return body as Record<string, unknown>
}

function rejectUnknownFields(fields: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      throw new AgentRequestError(`Unknown field: ${key}`)
    }
  }
}

function bodyString(fields: Record<string, unknown>, key: string): string | undefined {
  const value: unknown = fields[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new AgentRequestError(`${key} must be a string`)
  if (value.includes('\0')) throw new AgentRequestError(`${key} must not contain NUL characters`)
  return value
}

/** Tasks are scoped to the token's session or the thread bound to it. */
async function isTaskInAgentScope({
  taskId,
  sessionId,
}: {
  taskId: number
  sessionId: string
}): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (!task) return false
  if (task.session_id === sessionId) return true
  const threadId = await getThreadIdBySessionId(sessionId)
  return threadId !== undefined && task.thread_id === threadId
}

// ── Bot side: HTTP handling ──────────────────────────────────────────

function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : null
}

function respondJson(res: http.ServerResponse, status: number, payload: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Run the mapped subcommand as a child of the bot, streaming NDJSON back. */
async function runAgentChild(args: string[], res: http.ServerResponse): Promise<void> {
  agentLogger.log(`Agent run: ${args.filter((arg) => !arg.startsWith('--prompt=')).join(' ')}`)
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  const emit = (event: RemoteSendEvent) => {
    res.write(`${JSON.stringify(event)}\n`)
  }
  // `session wait` and `send --wait` can stay quiet for a long time; keep
  // idle timeouts away.
  const keepalive = setInterval(() => emit({ keepalive: true }), 20_000)
  const exit = await getRemoteSendRunner()(args, emit).finally(() => clearInterval(keepalive))
  emit({ exit })
  res.end()
}

async function runAgentSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req, REMOTE_SEND_MAX_BODY_BYTES)
  if (body instanceof Error) {
    respondJson(res, 413, { error: body.message })
    return
  }
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-agent-send-'))
  try {
    let args: string[]
    try {
      args = buildRemoteSendArgs(JSON.parse(body.toString('utf8')), fileDir)
    } catch (error) {
      respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    await runAgentChild(args, res)
  } finally {
    fs.rmSync(fileDir, { recursive: true, force: true })
  }
}

const AGENT_SESSION_READ_PATTERN = /^\/roadie\/agent\/sessions\/([^/]+)$/
const AGENT_SESSION_WAIT_PATTERN = /^\/roadie\/agent\/sessions\/([^/]+)\/wait$/
const AGENT_SESSION_ABORT_PATTERN = /^\/roadie\/agent\/sessions\/([^/]+)\/abort$/
const AGENT_SESSION_DISCORD_URL_PATTERN = /^\/roadie\/agent\/sessions\/([^/]+)\/discord-url$/
const AGENT_TASK_EDIT_PATTERN = /^\/roadie\/agent\/tasks\/([^/]+)$/

/**
 * Handle one /roadie/agent/* request. Authorization is the per-session
 * agent token; the service token and unauthenticated requests are rejected.
 */
export async function handleAgentRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { secret }: { secret: string },
): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const token = bearerToken(req)
  const verified = token ? verifyAgentToken({ secret, token }) : null
  if (!verified) {
    respondJson(res, 401, { error: 'unauthorized' })
    return
  }
  const { sessionId } = verified
  // Literal /roadie/agent/sessions/... paths are matched before the session
  // read pattern below, which would otherwise treat "editors" as a session id.
  try {
    if (req.method === 'POST' && url.pathname === AGENT_SEND_PATH) {
      await runAgentSend(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === AGENT_SESSION_SEARCH_PATH) {
      await runAgentChild(buildAgentSessionSearchArgs(url.searchParams), res)
      return
    }
    if (req.method === 'GET' && url.pathname === AGENT_SESSION_EDITORS_PATH) {
      await runAgentChild(buildAgentSessionEditorsArgs(url.searchParams), res)
      return
    }
    if (req.method === 'GET' && url.pathname === AGENT_SESSIONS_PATH) {
      await runAgentChild(buildAgentSessionListArgs(url.searchParams), res)
      return
    }
    if (req.method === 'GET' && url.pathname === AGENT_TASKS_PATH) {
      await runAgentChild(buildAgentTaskListArgs(url.searchParams, sessionId), res)
      return
    }
    if (req.method === 'GET' && url.pathname === AGENT_PROJECTS_PATH) {
      await runAgentChild(buildAgentProjectListArgs(url.searchParams), res)
      return
    }
    if (req.method === 'GET' && url.pathname === AGENT_THREADS_PATH) {
      await runAgentChild(buildAgentThreadListArgs(url.searchParams), res)
      return
    }
    if (req.method === 'GET' && url.pathname === AGENT_USERS_PATH) {
      await runAgentChild(buildAgentUserListArgs(url.searchParams), res)
      return
    }
    if (req.method === 'POST' && url.pathname === AGENT_SESSION_ARCHIVE_PATH) {
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      // Archive follows the CLI rules: any thread the caller names.
      await runAgentChild(buildAgentSessionArchiveArgs(body.value), res)
      return
    }
    if (req.method === 'POST' && url.pathname === AGENT_SESSION_TITLE_PATH) {
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      await runAgentChild(buildAgentSessionTitleArgs({ body: body.value, sessionId }), res)
      return
    }
    if (req.method === 'POST' && url.pathname === AGENT_PROJECT_ADD_PATH) {
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      await runAgentChild(buildAgentProjectAddArgs(body.value), res)
      return
    }
    if (req.method === 'POST' && url.pathname === AGENT_PROJECT_CREATE_PATH) {
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      await runAgentChild(buildAgentProjectCreateArgs(body.value), res)
      return
    }
    if (req.method === 'POST' && url.pathname === AGENT_PROJECT_REMOVE_PATH) {
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      await runAgentChild(buildAgentProjectRemoveArgs(body.value), res)
      return
    }
    if (req.method === 'POST' && url.pathname === AGENT_PROJECT_OPEN_IN_DISCORD_PATH) {
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      await runAgentChild(buildAgentProjectOpenInDiscordArgs(body.value), res)
      return
    }
    const readMatch = AGENT_SESSION_READ_PATTERN.exec(url.pathname)
    const readSegment = readMatch?.[1]
    if (req.method === 'GET' && readMatch && readSegment !== undefined) {
      // Read stays as broad as the CLI already is for local operators.
      await runAgentChild(buildAgentSessionReadArgs({ sessionId: pathSegment(readSegment, 'session id'), query: url.searchParams }), res)
      return
    }
    const waitMatch = AGENT_SESSION_WAIT_PATTERN.exec(url.pathname)
    const waitSegment = waitMatch?.[1]
    if (req.method === 'POST' && waitMatch && waitSegment !== undefined) {
      const target = pathSegment(waitSegment, 'session id')
      // A token only waits on its own session.
      if (target !== sessionId) {
        respondJson(res, 403, { error: 'agent token is bound to another session' })
        return
      }
      await runAgentChild(buildAgentSessionWaitArgs({ sessionId: target }), res)
      return
    }
    const abortMatch = AGENT_SESSION_ABORT_PATTERN.exec(url.pathname)
    const abortSegment = abortMatch?.[1]
    if (req.method === 'POST' && abortMatch && abortSegment !== undefined) {
      // Abort follows the CLI rules: any session the caller names.
      await runAgentChild(buildAgentSessionAbortArgs({ sessionId: pathSegment(abortSegment, 'session id') }), res)
      return
    }
    const discordUrlMatch = AGENT_SESSION_DISCORD_URL_PATTERN.exec(url.pathname)
    const discordUrlSegment = discordUrlMatch?.[1]
    if (req.method === 'GET' && discordUrlMatch && discordUrlSegment !== undefined) {
      await runAgentChild(buildAgentSessionDiscordUrlArgs({
        sessionId: pathSegment(discordUrlSegment, 'session id'),
        query: url.searchParams,
      }), res)
      return
    }
    const taskEditMatch = AGENT_TASK_EDIT_PATTERN.exec(url.pathname)
    const taskEditSegment = taskEditMatch?.[1]
    if (taskEditMatch && taskEditSegment !== undefined && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const taskId = parseAgentTaskId(taskEditSegment)
      if (req.method === 'DELETE') {
        // Out-of-scope tasks look like any other unknown task.
        if (!(await isTaskInAgentScope({ taskId, sessionId }))) {
          respondJson(res, 404, { error: 'task not found' })
          return
        }
        await runAgentChild(buildAgentTaskDeleteArgs({ taskId }), res)
        return
      }
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      const args = buildAgentTaskEditArgs({ taskId, body: body.value })
      // Out-of-scope tasks look like any other unknown task.
      if (!(await isTaskInAgentScope({ taskId, sessionId }))) {
        respondJson(res, 404, { error: 'task not found' })
        return
      }
      await runAgentChild(args, res)
      return
    }
    respondJson(res, 404, { error: 'not_found' })
  } catch (error) {
    if (error instanceof AgentRequestError) {
      respondJson(res, 400, { error: error.message })
      return
    }
    throw error
  }
}

/**
 * Read and parse one JSON request body, answering with the protocol error
 * responses on failure. Returns `{ ok: false }` when the response is sent.
 */
async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const body = await readBody(req, REMOTE_SEND_MAX_BODY_BYTES)
  if (body instanceof Error) {
    respondJson(res, 413, { error: body.message })
    return { ok: false }
  }
  const parsed = errore.try({
    try: () => JSON.parse(body.toString('utf8')) as unknown,
    catch: (e) => new AgentRequestError('Body must be valid JSON', { cause: e }),
  })
  if (parsed instanceof Error) {
    respondJson(res, 400, { error: parsed.message })
    return { ok: false }
  }
  return { ok: true, value: parsed }
}
