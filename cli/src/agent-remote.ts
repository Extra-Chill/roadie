// Scoped agent endpoints for tool shells.
//
// An agent tool shell runs inside the OpenCode server's environment but must
// not hold the bot's database credentials (the shell.env hook blanks them and
// exports ROADIE_AGENT_TOKEN instead, see agent-token.ts). The `roadie`
// subcommands agents are told to run — send, session search/read/wait, task
// list/edit, project list — detect that mode here and call typed JSON
// endpoints on the bot's local HTTP server instead of opening the database.
//
// The bot never exposes SQL over these endpoints. Each endpoint maps a fixed
// request shape to the allowlisted arguments of one `roadie` subcommand and
// runs it as a child of the bot process (the same runner as /roadie/send),
// streaming its output back as NDJSON. The child does the database reads and
// writes and the Discord REST calls with the bot's own credentials, so the
// client relays byte-identical output and exit codes. Tasks are scoped to the
// token's session or thread; search, read and project listings stay as broad
// as the CLI already is for any local operator.
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
export const AGENT_SESSIONS_PATH = '/roadie/agent/sessions'
export const AGENT_TASKS_PATH = '/roadie/agent/tasks'
export const AGENT_PROJECTS_PATH = '/roadie/agent/projects'

export class AgentRequestError extends Error {}

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
  method: 'GET' | 'POST' | 'PATCH'
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

export function buildAgentTaskListArgs(query: URLSearchParams, sessionId: string): string[] {
  const args = ['task', 'list']
  if (queryFlag(query, 'all')) args.push('--all')
  // The token decides the scope; the client cannot widen it.
  args.push(`--session=${sessionId}`)
  return args
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentRequestError('Body must be a JSON object')
  }
  const fields = body as AgentTaskEditBody
  for (const key of Object.keys(fields)) {
    if (!AGENT_TASK_EDIT_FIELDS.some(([field]) => field === key)) {
      throw new AgentRequestError(`Unknown field: ${key}`)
    }
  }
  const args = ['task', 'edit', String(taskId)]
  for (const [key, flag] of AGENT_TASK_EDIT_FIELDS) {
    const value: unknown = fields[key]
    if (value === undefined) continue
    if (typeof value !== 'string') throw new AgentRequestError(`${key} must be a string`)
    if (value.includes('\0')) throw new AgentRequestError(`${key} must not contain NUL characters`)
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
  try {
    if (req.method === 'POST' && url.pathname === AGENT_SEND_PATH) {
      await runAgentSend(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === AGENT_SESSION_SEARCH_PATH) {
      await runAgentChild(buildAgentSessionSearchArgs(url.searchParams), res)
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
    const taskEditMatch = AGENT_TASK_EDIT_PATTERN.exec(url.pathname)
    const taskEditSegment = taskEditMatch?.[1]
    if (req.method === 'PATCH' && taskEditMatch && taskEditSegment !== undefined) {
      const taskId = parseAgentTaskId(taskEditSegment)
      const body = await readBody(req, REMOTE_SEND_MAX_BODY_BYTES)
      if (body instanceof Error) {
        respondJson(res, 413, { error: body.message })
        return
      }
      const parsed = errore.try({
        try: () => JSON.parse(body.toString('utf8')) as unknown,
        catch: (e) => new AgentRequestError('Body must be valid JSON', { cause: e }),
      })
      if (parsed instanceof Error) {
        respondJson(res, 400, { error: parsed.message })
        return
      }
      const args = buildAgentTaskEditArgs({ taskId, body: parsed })
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
