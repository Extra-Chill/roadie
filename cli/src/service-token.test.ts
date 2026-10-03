// Host-provided service token: secret resolution, and a process that holds
// only the token (not the data dir) reaching the bot's database over Hrana.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createClient } from '@libsql/client'
import { readRoadieSecret, setDataDir } from './config.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { sendViaRunningBot, setRemoteSendRunner } from './remote-send.js'
import { store } from './store.js'
import { chooseLockPort } from './test-utils.js'

const saved = { ...process.env }
function restoreEnv(keys: string[]) {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

describe('readRoadieSecret', () => {
  afterEach(() => restoreEnv(['ROADIE_TEST_SECRET', 'ROADIE_TEST_SECRET_FILE']))

  test('reads the variable, then the _FILE variant; direct value wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-secret-'))
    const file = path.join(dir, 'secret')
    fs.writeFileSync(file, 'from-file\n')
    expect(readRoadieSecret('ROADIE_TEST_SECRET')).toBeUndefined()
    process.env.ROADIE_TEST_SECRET_FILE = file
    expect(readRoadieSecret('ROADIE_TEST_SECRET')).toBe('from-file')
    process.env.ROADIE_TEST_SECRET = 'direct'
    expect(readRoadieSecret('ROADIE_TEST_SECRET')).toBe('direct')
  })

  test('an unreadable or empty _FILE is an error, not silently ignored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-secret-'))
    process.env.ROADIE_TEST_SECRET_FILE = path.join(dir, 'missing')
    expect(() => readRoadieSecret('ROADIE_TEST_SECRET')).toThrow(/not readable/)
    const empty = path.join(dir, 'empty')
    fs.writeFileSync(empty, '  \n')
    process.env.ROADIE_TEST_SECRET_FILE = empty
    expect(() => readRoadieSecret('ROADIE_TEST_SECRET')).toThrow(/empty/)
  })
})

describe('send token on the local endpoint', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-service-token-'))
  const token = `svc:${crypto.randomBytes(16).toString('hex')}`
  let url = ''
  const runs: Array<{ args: string[]; files: Record<string, string> }> = []
  let restoreRunner: (() => void) | undefined

  beforeAll(async () => {
    process.env.ROADIE_SERVICE_TOKEN = token
    process.env.ROADIE_LOCK_PORT = String(chooseLockPort({ key: 'service-token-test' }))
    setDataDir(dataDir)
    const started = await startHranaServer({ dbPath: path.join(dataDir, 'discord-sessions.db') })
    if (started instanceof Error) throw started
    url = started
    // Record instead of spawning a real `roadie send`; read attached files
    // while they exist (the endpoint deletes them afterwards).
    restoreRunner = setRemoteSendRunner(async (args, emit) => {
      const files: Record<string, string> = {}
      for (const arg of args) {
        if (arg.startsWith('--file=')) files[path.basename(arg)] = fs.readFileSync(arg.slice('--file='.length), 'utf8')
      }
      runs.push({ args, files })
      emit({ stream: 'stdout', data: 'thread: 123\n' })
      emit({ stream: 'stderr', data: 'note\n' })
      return 0
    })
  })
  afterAll(async () => {
    restoreRunner?.()
    restoreEnv(['ROADIE_SERVICE_TOKEN', 'ROADIE_LOCK_PORT'])
    await stopHranaServer()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('the send token does not open the database', async () => {
    const client = createClient({ url, authToken: token })
    await expect(client.execute('SELECT 1')).rejects.toThrow()
    client.close()
  })

  test('the internal database token still works for Roadie processes', async () => {
    const internal = store.getState().gatewayToken
    expect(internal).toBeTruthy()
    expect(internal).not.toBe(token)
    const client = createClient({ url, authToken: internal! })
    expect((await client.execute('SELECT 1 AS one')).rows[0]?.one).toBe(1)
    client.close()
  })

  test('a send goes through with the token and streams output and exit code', async () => {
    const out: string[] = []
    const err: string[] = []
    const sink = (into: string[]) => ({ write: (chunk: string) => into.push(chunk) }) as unknown as NodeJS.WritableStream
    const attachment = path.join(dataDir, 'notes.txt')
    fs.writeFileSync(attachment, 'attached text')
    const exit = await sendViaRunningBot({
      port: Number(process.env.ROADIE_LOCK_PORT),
      token,
      options: { thread: '42', prompt: '--notify-only is just text', permission: ['bash:deny'], notifyOnly: true },
      filePaths: [attachment],
      stdout: sink(out),
      stderr: sink(err),
    })
    expect(exit).toBe(0)
    expect(out.join('')).toBe('thread: 123\n')
    expect(err.join('')).toBe('note\n')
    const run = runs.at(-1)!
    expect(run.args).toEqual([
      'send',
      '--thread=42',
      '--prompt=--notify-only is just text',
      '--permission=bash:deny',
      '--notify-only',
      expect.stringMatching(/^--file=.*0-notes\.txt$/),
    ])
    expect(run.files['0-notes.txt']).toBe('attached text')
  })

  test('wrong token, disallowed option and bad shape are refused before running', async () => {
    const before = runs.length
    const post = (auth: string, body: unknown) => fetch(`${url}/roadie/send`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect((await post('Bearer nope', { options: { prompt: 'x' } })).status).toBe(401)
    expect((await post(`Bearer ${token}`, { options: { preRun: 'rm -rf ~' } })).status).toBe(400)
    expect((await post(`Bearer ${token}`, { options: { prompt: 7 } })).status).toBe(400)
    expect(runs.length).toBe(before)
  })
})
