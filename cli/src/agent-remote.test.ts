// Agent endpoints on the bot's local HTTP server: token auth, typed
// request → allowlisted subcommand argv mapping, task scoping, NDJSON relay.
//
// The runner is stubbed (like service-token.test.ts) so tests observe the
// exact arguments the bot would execute and the bytes the client relays.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { closeDb } from './db.js'
import { setDataDir } from './config.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { createScheduledTask } from './database.js'
import { setRemoteSendRunner } from './remote-send.js'
import { chooseLockPort } from './test-utils.js'
import { ensureAgentTokenSecret, mintAgentToken, AGENT_TOKEN_ENV, AGENT_TOKEN_SECRET_ENV } from './agent-token.js'
import {
  AGENT_PROJECTS_PATH,
  AGENT_SEND_PATH,
  AGENT_SESSIONS_PATH,
  AGENT_SESSION_SEARCH_PATH,
  AGENT_TASKS_PATH,
  runAgentCommand,
  type AgentCommandRequest,
} from './agent-remote.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-agent-remote-'))
const AGENT_SESSION = 'ses_agent_test'
const savedEnv = Object.fromEntries(
  [AGENT_TOKEN_ENV, AGENT_TOKEN_SECRET_ENV, 'ROADIE_OPENCODE_PROCESS', 'ROADIE_LOCK_PORT', 'ROADIE_DB_URL', 'ROADIE_DB_AUTH_TOKEN', 'ROADIE_DB_AUTH_TOKEN_FILE', 'ROADIE_SERVICE_TOKEN'].map((key) => [key, process.env[key]]),
)

let url = ''
let secret = ''
const token = () => mintAgentToken({ secret, sessionId: AGENT_SESSION })
const runs: string[][] = []
let nextExit = 0
let restoreRunner: (() => void) | undefined

const sink = (into: string[]) => ({ write: (chunk: string) => into.push(chunk) }) as unknown as NodeJS.WritableStream

async function runClient(request: AgentCommandRequest, agent = { token: token(), port: Number(process.env.ROADIE_LOCK_PORT) }) {
  const out: string[] = []
  const err: string[] = []
  const exit = await runAgentCommand({ agent, request, stdout: sink(out), stderr: sink(err) })
  return { exit, out: out.join(''), err: err.join('') }
}

const post = (endpoint: string, auth: string, body: unknown) =>
  fetch(`${url}${endpoint}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const get = (endpoint: string, auth: string) => fetch(`${url}${endpoint}`, { headers: { authorization: auth } })

beforeAll(async () => {
  delete process.env.ROADIE_DB_URL
  delete process.env.ROADIE_DB_AUTH_TOKEN
  delete process.env.ROADIE_DB_AUTH_TOKEN_FILE
  // A configured send token makes /roadie/send reach its auth check, so the
  // test can prove the agent token is not accepted there.
  process.env.ROADIE_SERVICE_TOKEN = 'svc-agent-remote-test'
  process.env.ROADIE_LOCK_PORT = String(chooseLockPort({ key: 'agent-remote-test' }))
  setDataDir(dataDir)
  const started = await startHranaServer({ dbPath: path.join(dataDir, 'discord-sessions.db') })
  if (started instanceof Error) throw started
  url = started
  secret = ensureAgentTokenSecret()
  restoreRunner = setRemoteSendRunner(async (args, emit) => {
    runs.push(args)
    emit({ stream: 'stdout', data: 'stub stdout line\n' })
    emit({ stream: 'stderr', data: 'stub stderr line\n' })
    return nextExit
  })
})

afterAll(async () => {
  restoreRunner?.()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await closeDb()
  await stopHranaServer()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('agent token auth', () => {
  test('an agent token is rejected on /v2 and /v2/pipeline', async () => {
    expect((await post('/v2', `Bearer ${token()}`, { requests: [] })).status).toBe(401)
    expect((await post('/v2/pipeline', `Bearer ${token()}`, { requests: [] })).status).toBe(401)
  })

  test('agent endpoints reject missing, service, foreign-secret and tampered tokens', async () => {
    const foreign = mintAgentToken({ secret: 'other-secret', sessionId: AGENT_SESSION })
    const tampered = `${AGENT_SESSION}.ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`
    for (const auth of [null, 'Bearer not-a-token', `Bearer ${foreign}`, `Bearer ${tampered}`]) {
      const response = await get(AGENT_PROJECTS_PATH, auth ?? '')
      expect(response.status).toBe(401)
    }
    // The cross-user send endpoint keeps its own service-token auth.
    expect((await post('/roadie/send', `Bearer ${token()}`, { options: { prompt: 'x' } })).status).toBe(401)
  })

  test('a valid token for another session cannot wait on this session', async () => {
    const otherSessionToken = mintAgentToken({ secret, sessionId: 'ses_other' })
    const response = await post(`${AGENT_SESSIONS_PATH}/${AGENT_SESSION}/wait`, `Bearer ${otherSessionToken}`, {})
    expect(response.status).toBe(403)
  })
})

describe('endpoints map to allowlisted subcommand arguments', () => {
  test('task list is scoped to the token session; the client cannot widen it', async () => {
    nextExit = 0
    const result = await runClient({ method: 'GET', path: AGENT_TASKS_PATH, query: { all: '1' } })
    expect(result.exit).toBe(0)
    expect(result.out).toBe('stub stdout line\n')
    expect(result.err).toBe('stub stderr line\n')
    expect(runs.at(-1)).toEqual(['task', 'list', '--all', `--session=${AGENT_SESSION}`])
    expect(runs.at(-1)).not.toContain('--prune')
  })

  test('session search passes the query and allowlisted flags', async () => {
    await runClient({ method: 'GET', path: AGENT_SESSION_SEARCH_PATH, query: { q: 'auth timeout', days: '0', json: '1' } })
    expect(runs.at(-1)).toEqual(['session', 'search', 'auth timeout', '--days=0', '--json'])
  })

  test('search requires a query and rejects invalid integers', async () => {
    expect((await get(AGENT_SESSION_SEARCH_PATH, `Bearer ${token()}`)).status).toBe(400)
    expect((await get(`${AGENT_SESSION_SEARCH_PATH}?q=x&limit=zero`, `Bearer ${token()}`)).status).toBe(400)
    expect((await get(`${AGENT_SESSION_SEARCH_PATH}?q=x&limit=-3`, `Bearer ${token()}`)).status).toBe(400)
  })

  test('session read maps to session read arguments', async () => {
    await runClient({
      method: 'GET',
      path: `${AGENT_SESSIONS_PATH}/ses_read_target`,
      query: { verbose: '1', thinking: '1', toolInputMaxChars: '40' },
    })
    expect(runs.at(-1)).toEqual(['session', 'read', 'ses_read_target', '--verbose', '--thinking', '--tool-input-max-chars=40'])
  })

  test('session wait maps to session wait for the token session', async () => {
    await runClient({ method: 'POST', path: `${AGENT_SESSIONS_PATH}/${AGENT_SESSION}/wait` })
    expect(runs.at(-1)).toEqual(['session', 'wait', AGENT_SESSION])
  })

  test('project list allows json, all and guild but never prune', async () => {
    await runClient({ method: 'GET', path: AGENT_PROJECTS_PATH, query: { json: '1', all: '1', guild: '123' } })
    expect(runs.at(-1)).toEqual(['project', 'list', '--json', '--all', '--guild=123'])
    expect(runs.at(-1)).not.toContain('--prune')
  })

  test('send reuses the /roadie/send option allowlist', async () => {
    const before = runs.length
    const rejected = await runClient({
      method: 'POST',
      path: AGENT_SEND_PATH,
      body: { options: { prompt: 'hi', preRun: 'rm -rf /' } },
    })
    expect(rejected.exit).toBe(1)
    expect(rejected.err).toContain('Option not allowed over the send endpoint: preRun')
    expect(runs.length).toBe(before)

    const accepted = await runClient({
      method: 'POST',
      path: AGENT_SEND_PATH,
      body: { options: { prompt: 'hi there', thread: '42', permission: ['bash:deny'] } },
    })
    expect(accepted.exit).toBe(0)
    expect(runs.at(-1)).toEqual(['send', '--prompt=hi there', '--thread=42', '--permission=bash:deny'])
  })

  test('unknown paths are 404', async () => {
    expect((await get('/roadie/agent/database', `Bearer ${token()}`)).status).toBe(404)
    expect((await get('/roadie/agent/sessions', `Bearer ${token()}`)).status).toBe(404)
  })
})

describe('tasks are scoped to the token session or thread', () => {
  let scopedTaskId = 0
  let foreignTaskId = 0

  beforeAll(async () => {
    const payload = JSON.stringify({ kind: 'channel', prompt: 'agent scoped task' })
    scopedTaskId = await createScheduledTask({
      scheduleKind: 'at',
      runAt: new Date('2030-01-01T00:00:00Z'),
      nextRunAt: new Date('2030-01-01T00:00:00Z'),
      payloadJson: payload,
      promptPreview: 'agent scoped task',
      sessionId: AGENT_SESSION,
    })
    foreignTaskId = await createScheduledTask({
      scheduleKind: 'at',
      runAt: new Date('2030-01-01T00:00:00Z'),
      nextRunAt: new Date('2030-01-01T00:00:00Z'),
      payloadJson: payload,
      promptPreview: 'operator task',
      sessionId: 'ses_operator',
    })
  })

  test('editing an in-scope task runs task edit with the mapped flags', async () => {
    const result = await runClient({
      method: 'PATCH',
      path: `${AGENT_TASKS_PATH}/${scopedTaskId}`,
      body: { prompt: 'New prompt', allowConcurrency: 'true' },
    })
    expect(result.exit).toBe(0)
    expect(runs.at(-1)).toEqual(['task', 'edit', String(scopedTaskId), '--prompt=New prompt', '--allow-concurrency=true'])
  })

  test('editing another session task is refused like an unknown task', async () => {
    const before = runs.length
    const response = await fetch(`${url}${AGENT_TASKS_PATH}/${foreignTaskId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hijack' }),
    })
    expect(response.status).toBe(404)
    expect(runs.length).toBe(before)
  })

  test('malformed edit bodies are refused before any run', async () => {
    const before = runs.length
    for (const body of [
      { prompt: 7 },
      { allowConcurrency: 'maybe' },
      { noSuchField: 'x' },
      'not-an-object',
      { prompt: 'a\0b' },
    ]) {
      const response = await fetch(`${url}${AGENT_TASKS_PATH}/${scopedTaskId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(runs.length).toBe(before)
  })

  test('a thread-scoped task is editable by the session bound to that thread', async () => {
    // createScheduledTask stores thread_id; a task with only the thread set
    // (no session_id) is in scope for the session bound to that thread.
    const threadId = `thread-${scopedTaskId}`
    const { getDb } = await import('./db.js')
    const { thread_sessions } = await import('./schema.js')
    const db = await getDb()
    await db.insert(thread_sessions).values({ thread_id: threadId, session_id: AGENT_SESSION })
    const threadTaskId = await createScheduledTask({
      scheduleKind: 'at',
      runAt: new Date('2030-01-01T00:00:00Z'),
      nextRunAt: new Date('2030-01-01T00:00:00Z'),
      payloadJson: JSON.stringify({ kind: 'thread', prompt: 'thread scoped' }),
      promptPreview: 'thread scoped',
      threadId,
    })
    const result = await runClient({
      method: 'PATCH',
      path: `${AGENT_TASKS_PATH}/${threadTaskId}`,
      body: { agent: 'planner' },
    })
    expect(result.exit).toBe(0)
    expect(runs.at(-1)).toEqual(['task', 'edit', String(threadTaskId), '--agent=planner'])
  })
})

describe('client behavior', () => {
  test('relays exit codes from the bot run', async () => {
    nextExit = 3
    const result = await runClient({ method: 'GET', path: AGENT_PROJECTS_PATH })
    expect(result.exit).toBe(3)
    nextExit = 0
  })

  test('an unreachable bot reports the failure on stderr with exit 1', async () => {
    const result = await runClient(
      { method: 'GET', path: AGENT_PROJECTS_PATH },
      { token: token(), port: 1 },
    )
    expect(result.exit).toBe(1)
    expect(result.err).toContain('Could not reach the running Roadie bot on port 1')
  })

  test('resolveAgentCredentials is unaffected by the running test bot (operator mode)', async () => {
    const { resolveAgentCredentials } = await import('./agent-remote.js')
    // No ROADIE_OPENCODE_PROCESS in the vitest process: operator mode.
    expect(resolveAgentCredentials()).toBeInstanceOf(Error)
  })
})
