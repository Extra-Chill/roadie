// Tests Drizzle access through the in-process Hrana/libSQL HTTP server.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test, vi } from 'vitest'
import Database from 'libsql'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as orm from 'drizzle-orm'
import {
  createLibsqlHandler,
  createLibsqlNodeHandler,
  libsqlExecutor,
} from 'libsqlproxy'
import * as schema from './schema.js'
import { closeDb, getDb } from './db.js'
import { getDataDir, setDataDir } from './config.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { store } from './store.js'
import { chooseAvailableLockPort } from './test-utils.js'
import { getThreadIdBySessionId, upsertSessionSleep, getSessionSleep } from './database.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function migrateSchema(client: Client) {
  const schemaPath = path.join(__dirname, '../src/schema.sql')
  const sql = fs.readFileSync(schemaPath, 'utf-8')
  const statements = sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(
      (s) =>
        s.length > 0 &&
        !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s),
    )
    .map((s) =>
      s
        .replace(
          /^CREATE\s+UNIQUE\s+INDEX\b(?!\s+IF)/i,
          'CREATE UNIQUE INDEX IF NOT EXISTS',
        )
        .replace(/^CREATE\s+INDEX\b(?!\s+IF)/i, 'CREATE INDEX IF NOT EXISTS'),
    )
  for (const statement of statements) {
    await client.execute(statement)
  }
}

describe('hrana-server', () => {
  let testServer: http.Server | null = null
  let testDb: Database.Database | null = null
  let client: Client | null = null
  const dbPath = path.join(
    process.cwd(),
    `tmp/test-hrana-${crypto.randomUUID().slice(0, 8)}.db`,
  )

  afterAll(async () => {
    client?.close()
    if (testServer) {
      await new Promise<void>((resolve) => {
        testServer!.close(() => resolve())
      })
    }
    testDb?.close()
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Test cleanup best effort.
      }
    }
  })

  test('Drizzle CRUD through hrana server', async () => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    const database = new Database(dbPath)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA busy_timeout = 5000')
    testDb = database

    // Below the ephemeral range (32768+), clear of the lock-port test ranges.
    const port = 26_000 + Math.floor(Math.random() * 4_000)
    await new Promise<void>((resolve, reject) => {
      const hranaFetchHandler = createLibsqlHandler(libsqlExecutor(database))
      const hranaNodeHandler = createLibsqlNodeHandler(hranaFetchHandler)
      const srv = http.createServer(hranaNodeHandler)
      srv.on('error', reject)
      srv.listen(port, '127.0.0.1', () => {
        testServer = srv
        resolve()
      })
    })

    client = createClient({ url: `http://127.0.0.1:${port}` })
    const db = drizzle({ client, schema, relations: schema.relations })
    await migrateSchema(client)

    const [created] = await db.insert(schema.thread_sessions)
      .values({ thread_id: 'hrana-test-thread', session_id: 'hrana-test-session' })
      .returning()
    expect(created?.thread_id).toMatchInlineSnapshot(`"hrana-test-thread"`)
    expect(created?.session_id).toMatchInlineSnapshot(`"hrana-test-session"`)

    const found = await db.query.thread_sessions.findFirst({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(found?.session_id).toMatchInlineSnapshot(`"hrana-test-session"`)

    await db.update(schema.thread_sessions)
      .set({ session_id: 'updated-session' })
      .where(orm.eq(schema.thread_sessions.thread_id, 'hrana-test-thread'))
    const updated = await db.query.thread_sessions.findFirst({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(updated?.session_id).toMatchInlineSnapshot(`"updated-session"`)

    await db.delete(schema.thread_sessions).where(
      orm.eq(schema.thread_sessions.thread_id, 'hrana-test-thread'),
    )
    const deleted = await db.query.thread_sessions.findFirst({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(deleted).toBeUndefined()
  }, 30_000)
})

test('cached IPC database follows credential-file rotation and server restart without replaying writes', async () => {
  await closeDb()
  const originalDir = getDataDir()
  const originalToken = store.getState().gatewayToken
  const previous = Object.fromEntries(['ROADIE_DB_URL', 'ROADIE_DB_AUTH_TOKEN', 'ROADIE_DB_AUTH_TOKEN_FILE', 'ROADIE_LOCK_PORT'].map((key) => [key, process.env[key]]))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-ipc-auth-'))
  const tokenFile = path.join(root, 'auth-token')
  const dbFile = path.join(root, 'ipc.sqlite')
  const realFetch = globalThis.fetch
  try {
    setDataDir(root)
    delete process.env.ROADIE_DB_AUTH_TOKEN
    fs.writeFileSync(tokenFile, 'first-token\n', { mode: 0o600 })
    process.env.ROADIE_DB_AUTH_TOKEN_FILE = tokenFile
    process.env.ROADIE_LOCK_PORT = String(await chooseAvailableLockPort({ key: 'ipc-auth-rotation' }))
    store.setState({ gatewayToken: null })
    const started = await startHranaServer({ dbPath: dbFile })
    if (started instanceof Error) throw started
    process.env.ROADIE_DB_URL = started
    const cached = await getDb()
    await cached.insert(schema.thread_sessions).values({ thread_id: 'fork-thread', session_id: 'fork-session' })
    expect(await getThreadIdBySessionId('fork-session')).toBe('fork-thread')
    await stopHranaServer()
    fs.writeFileSync(tokenFile, 'second-token\n', { mode: 0o600 })
    store.setState({ gatewayToken: null })
    const restarted = await startHranaServer({ dbPath: dbFile })
    if (restarted instanceof Error) throw restarted
    process.env.ROADIE_DB_URL = restarted
    expect(await getDb()).toBe(cached)
    expect(await getThreadIdBySessionId('fork-session')).toBe('fork-thread')
    await upsertSessionSleep({ sessionId: 'fork-session', wakeAt: new Date('2030-01-01T00:00:00Z'), reason: 'restart proof' })
    expect((await getSessionSleep({ sessionId: 'fork-session' }))?.reason).toBe('restart proof')
    const stale = createClient({ url: restarted, authToken: 'first-token' })
    await expect(stale.execute('SELECT 1')).rejects.toThrow(/401/)
    stale.close()
    let lost = false
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await realFetch(...args)
      if (!lost && new URL(args[0] instanceof Request ? args[0].url : String(args[0])).pathname === '/v2/pipeline') {
        lost = true
        throw new TypeError('simulated lost response after execution')
      }
      return response
    })
    await expect(cached.insert(schema.thread_sessions).values({ thread_id: 'once-only', session_id: 'once-only' })).rejects.toThrow()
    vi.stubGlobal('fetch', realFetch)
    expect(await cached.select().from(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, 'once-only'))).toHaveLength(1)
  } finally {
    vi.unstubAllGlobals()
    await closeDb()
    await stopHranaServer()
    store.setState({ gatewayToken: originalToken })
    setDataDir(originalDir)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30000)

test('default IPC credential persists privately across a service restart', async () => {
  const originalDir = getDataDir()
  const originalToken = store.getState().gatewayToken
  const previous = Object.fromEntries(['ROADIE_DB_AUTH_TOKEN', 'ROADIE_DB_AUTH_TOKEN_FILE', 'ROADIE_LOCK_PORT'].map((key) => [key, process.env[key]]))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-ipc-default-auth-'))
  try {
    setDataDir(root)
    delete process.env.ROADIE_DB_AUTH_TOKEN
    delete process.env.ROADIE_DB_AUTH_TOKEN_FILE
    process.env.ROADIE_LOCK_PORT = String(await chooseAvailableLockPort({ key: 'ipc-default-auth' }))
    store.setState({ gatewayToken: null })
    const started = await startHranaServer({ dbPath: path.join(root, 'db.sqlite') })
    if (started instanceof Error) throw started
    const first = store.getState().gatewayToken
    const file = process.env.ROADIE_DB_AUTH_TOKEN_FILE
    if (!file) throw new Error('missing service credential file')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(process.env.ROADIE_DB_AUTH_TOKEN).toBeUndefined()
    await stopHranaServer()
    store.setState({ gatewayToken: null })
    const restarted = await startHranaServer({ dbPath: path.join(root, 'db.sqlite') })
    if (restarted instanceof Error) throw restarted
    expect(store.getState().gatewayToken).toBe(first)
    const client = createClient({ url: restarted, authToken: first ?? undefined })
    expect((await client.execute('SELECT 1 AS ok')).rows[0]?.ok).toBe(1)
    client.close()
  } finally {
    await stopHranaServer()
    store.setState({ gatewayToken: originalToken })
    setDataDir(originalDir)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30000)
