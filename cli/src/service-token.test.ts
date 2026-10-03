// Host-provided service token: secret resolution, and a process that holds
// only the token (not the data dir) reaching the bot's database over Hrana.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { createClient } from '@libsql/client'
import { readRoadieSecret, setDataDir } from './config.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { chooseLockPort } from './test-utils.js'

const saved = { ...process.env }
afterEach(() => {
  for (const key of ['ROADIE_TEST_SECRET', 'ROADIE_TEST_SECRET_FILE', 'ROADIE_SERVICE_TOKEN', 'ROADIE_LOCK_PORT']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('readRoadieSecret', () => {
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

describe('service token over Hrana', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-service-token-'))
  afterAll(async () => {
    await stopHranaServer()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('the configured token authenticates clients; anything else is rejected', async () => {
    const token = `svc:${crypto.randomBytes(16).toString('hex')}`
    const port = chooseLockPort({ key: 'service-token-test' })
    process.env.ROADIE_SERVICE_TOKEN = token
    process.env.ROADIE_LOCK_PORT = String(port)
    setDataDir(dataDir)
    const url = await startHranaServer({ dbPath: path.join(dataDir, 'discord-sessions.db') })
    if (url instanceof Error) throw url
    expect(url).toBe(`http://127.0.0.1:${port}`)

    const good = createClient({ url, authToken: token })
    await good.execute('CREATE TABLE IF NOT EXISTS probe (v TEXT)')
    await good.execute({ sql: 'INSERT INTO probe (v) VALUES (?)', args: ['hello'] })
    const rows = await good.execute('SELECT v FROM probe')
    expect(rows.rows[0]?.v).toBe('hello')
    good.close()

    const bad = createClient({ url, authToken: 'svc:wrong' })
    await expect(bad.execute('SELECT 1')).rejects.toThrow()
    bad.close()
  })
})
