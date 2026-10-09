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
  AGENT_PROJECT_ADD_PATH,
  AGENT_PROJECT_CREATE_PATH,
  AGENT_PROJECT_OPEN_IN_DISCORD_PATH,
  AGENT_PROJECT_REMOVE_PATH,
  AGENT_SEND_PATH,
  AGENT_SESSIONS_PATH,
  AGENT_SESSION_ARCHIVE_PATH,
  AGENT_SESSION_EDITORS_PATH,
  AGENT_SESSION_SEARCH_PATH,
  AGENT_SESSION_TITLE_PATH,
  AGENT_TASKS_PATH,
  AGENT_THREADS_PATH,
  AGENT_USERS_PATH,
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

  test('project add maps the resolved directory, guild and app id', async () => {
    await runClient({
      method: 'POST',
      path: AGENT_PROJECT_ADD_PATH,
      body: { directory: '/repos/site', guild: '555', appId: '999' },
    })
    expect(runs.at(-1)).toEqual(['project', 'add', '/repos/site', '--guild=555', '--app-id=999'])
  })

  test('project create maps the name and options', async () => {
    await runClient({
      method: 'POST',
      path: AGENT_PROJECT_CREATE_PATH,
      body: { name: 'my-new-app', guild: '555', projectsDir: '/srv/projects' },
    })
    expect(runs.at(-1)).toEqual(['project', 'create', 'my-new-app', '--guild=555', '--projects-dir=/srv/projects'])
  })

  test('project remove and open-in-discord map their bodies', async () => {
    await runClient({ method: 'POST', path: AGENT_PROJECT_REMOVE_PATH, body: { channelId: '42' } })
    expect(runs.at(-1)).toEqual(['project', 'remove', '42'])
    await runClient({ method: 'POST', path: AGENT_PROJECT_OPEN_IN_DISCORD_PATH, body: { directory: '/repos/site' } })
    expect(runs.at(-1)).toEqual(['project', 'open-in-discord', '/repos/site'])
  })

  test('project mutations reject unknown fields and missing values', async () => {
    const before = runs.length
    const cases: Array<[string, unknown]> = [
      [AGENT_PROJECT_ADD_PATH, { directory: '/repos/site', prune: true }],
      [AGENT_PROJECT_ADD_PATH, { directory: 7 }],
      [AGENT_PROJECT_CREATE_PATH, {}],
      [AGENT_PROJECT_CREATE_PATH, { name: 'x', noSuchField: 'y' }],
      [AGENT_PROJECT_REMOVE_PATH, {}],
      [AGENT_PROJECT_REMOVE_PATH, { channelId: 42 }],
      [AGENT_PROJECT_OPEN_IN_DISCORD_PATH, {}],
      [AGENT_PROJECT_OPEN_IN_DISCORD_PATH, { directory: 'a\0b' }],
    ]
    for (const [path, body] of cases) {
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(runs.length).toBe(before)
  })

  test('thread list requires the channel and maps the flags', async () => {
    expect((await get(AGENT_THREADS_PATH, `Bearer ${token()}`)).status).toBe(400)
    await runClient({ method: 'GET', path: AGENT_THREADS_PATH, query: { channel: '42', json: '1', limit: '10' } })
    expect(runs.at(-1)).toEqual(['thread', 'list', '--channel=42', '--json', '--limit=10'])
  })

  test('user list requires the guild and maps the query', async () => {
    expect((await get(AGENT_USERS_PATH, `Bearer ${token()}`)).status).toBe(400)
    await runClient({ method: 'GET', path: AGENT_USERS_PATH, query: { guild: '555', query: 'tommy' } })
    expect(runs.at(-1)).toEqual(['user', 'list', '--guild=555', '--query=tommy'])
    await runClient({ method: 'GET', path: AGENT_USERS_PATH, query: { guild: '555' } })
    expect(runs.at(-1)).toEqual(['user', 'list', '--guild=555'])
  })

  test('unknown paths are 404', async () => {
    expect((await get('/roadie/agent/database', `Bearer ${token()}`)).status).toBe(404)
    expect((await get('/roadie/agent/tasks/1', `Bearer ${token()}`)).status).toBe(404)
    expect((await get('/roadie/agent/projects/add', `Bearer ${token()}`)).status).toBe(404)
  })
})

describe('session list, editors, archive, abort, title and discord-url endpoints', () => {
  test('session list maps the allowlisted flags', async () => {
    await runClient({
      method: 'GET',
      path: AGENT_SESSIONS_PATH,
      query: { project: '/repos/site', all: '1', active: '1', exclude: 'ses_other', json: '1' },
    })
    expect(runs.at(-1)).toEqual([
      'session', 'list', '--project=/repos/site', '--all', '--active', '--exclude=ses_other', '--json',
    ])
  })

  test('session editors maps the file and flags and wins over the read route', async () => {
    await runClient({
      method: 'GET',
      path: AGENT_SESSION_EDITORS_PATH,
      query: { file: '/repos/site/src/cli.ts', json: '1', limit: '5' },
    })
    expect(runs.at(-1)).toEqual(['session', 'editors', '/repos/site/src/cli.ts', '--json', '--limit=5'])
    expect((await get(`${AGENT_SESSION_EDITORS_PATH}?file=/repos/site/x.ts`, `Bearer ${token()}`)).status).toBe(200)
  })

  test('session editors requires the file', async () => {
    expect((await get(AGENT_SESSION_EDITORS_PATH, `Bearer ${token()}`)).status).toBe(400)
    expect((await get(`${AGENT_SESSION_EDITORS_PATH}?limit=5`, `Bearer ${token()}`)).status).toBe(400)
  })

  test('session archive maps threadId or sessionId like the CLI', async () => {
    await runClient({ method: 'POST', path: AGENT_SESSION_ARCHIVE_PATH, body: { threadId: '123' } })
    expect(runs.at(-1)).toEqual(['session', 'archive', '123'])
    await runClient({ method: 'POST', path: AGENT_SESSION_ARCHIVE_PATH, body: { sessionId: 'ses_x' } })
    expect(runs.at(-1)).toEqual(['session', 'archive', '--session=ses_x'])
    // An empty body reaches the CLI, which prints its own usage error.
    await runClient({ method: 'POST', path: AGENT_SESSION_ARCHIVE_PATH, body: {} })
    expect(runs.at(-1)).toEqual(['session', 'archive'])
  })

  test('session archive rejects invalid bodies', async () => {
    const before = runs.length
    for (const body of [
      { threadId: '123', sessionId: 'ses_x' },
      { threadId: 7 },
      { noSuchField: 'x' },
      'not-an-object',
      { threadId: 'a\0b' },
    ]) {
      const response = await fetch(`${url}${AGENT_SESSION_ARCHIVE_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(runs.length).toBe(before)
  })

  test('session abort maps to session abort arguments', async () => {
    await runClient({ method: 'POST', path: `${AGENT_SESSIONS_PATH}/ses_target/abort` })
    expect(runs.at(-1)).toEqual(['session', 'abort', 'ses_target'])
  })

  test('session title is bound to the token session', async () => {
    await runClient({ method: 'POST', path: AGENT_SESSION_TITLE_PATH, body: { title: 'New title' } })
    expect(runs.at(-1)).toEqual(['session', 'title', 'New title', `--session=${AGENT_SESSION}`])
  })

  test('session title rejects invalid bodies', async () => {
    const before = runs.length
    for (const [body, expectedStatus] of [
      [{ title: '   ' }, 400],
      [{ title: 7 }, 400],
      [{ title: 'x', sessionId: 'ses_other' }, 400],
      [{}, 400],
    ] as const) {
      const response = await fetch(`${url}${AGENT_SESSION_TITLE_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(expectedStatus)
    }
    expect(runs.length).toBe(before)
  })

  test('session discord-url maps to session discord-url arguments', async () => {
    await runClient({ method: 'GET', path: `${AGENT_SESSIONS_PATH}/ses_target/discord-url` })
    expect(runs.at(-1)).toEqual(['session', 'discord-url', 'ses_target'])
    await runClient({ method: 'GET', path: `${AGENT_SESSIONS_PATH}/ses_target/discord-url`, query: { json: '1' } })
    expect(runs.at(-1)).toEqual(['session', 'discord-url', 'ses_target', '--json'])
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

  test('deleting an in-scope task runs task delete', async () => {
    const result = await runClient({ method: 'DELETE', path: `${AGENT_TASKS_PATH}/${scopedTaskId}` })
    expect(result.exit).toBe(0)
    expect(runs.at(-1)).toEqual(['task', 'delete', String(scopedTaskId)])
  })

  test('deleting another session task is refused like an unknown task', async () => {
    const before = runs.length
    const response = await fetch(`${url}${AGENT_TASKS_PATH}/${foreignTaskId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token()}` } })
    expect(response.status).toBe(404)
    expect(runs.length).toBe(before)
  })

  test('malformed delete ids are refused before any run', async () => {
    const before = runs.length
    for (const id of ['abc', '0', '1.5', '-2']) {
      const response = await fetch(`${url}${AGENT_TASKS_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token()}` } })
      expect(response.status).toBe(400)
    }
    expect(runs.length).toBe(before)
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
