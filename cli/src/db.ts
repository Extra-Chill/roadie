// Drizzle client initialization with libSQL.
// Uses ROADIE_DB_URL env var when set (plugin process → Hrana HTTP),
// otherwise falls back to direct file: access (bot process, CLI subcommands).
// Schema bootstrap runs in both modes because tests and plugin children may be
// the first process to touch a fresh SQLite file through Hrana.

import fs from 'node:fs'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { fileURLToPath } from 'node:url'

import { getDataDir, readRoadieSecret } from './config.js'
import { createLogger, formatErrorWithStack, LogPrefix } from './logger.js'
import * as schema from './schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function createDrizzleClient(client: Client) {
  return drizzle({ client, schema, relations: schema.relations })
}

export type RoadieDb = ReturnType<typeof createDrizzleClient>

const dbLogger = createLogger(LogPrefix.DB)

let clientInstance: Client | null = null
let dbInstance: RoadieDb | null = null
let initPromise: Promise<RoadieDb> | null = null

// Under vitest, clear any inherited ROADIE_DB_URL from the parent bot process
// so tests default to file-based access using the auto-isolated temp data dir.
// Tests that need Hrana can set ROADIE_DB_URL explicitly after import.
if (process.env.ROADIE_VITEST) {
  delete process.env['ROADIE_DB_URL']
}

export function getDb(): Promise<RoadieDb> {
  if (dbInstance) {
    return Promise.resolve(dbInstance)
  }
  if (initPromise) {
    return initPromise
  }
  initPromise = initializeDb().finally(() => { initPromise = null })
  return initPromise
}


function getDbUrl(): string {
  if (process.env.ROADIE_DB_URL) {
    return process.env.ROADIE_DB_URL
  }
  const dataDir = getDataDir()
  const dbPath = path.join(dataDir, 'discord-sessions.db')
  return `file:${dbPath}`
}

function getDbAuthToken(): string | undefined {
  return readRoadieSecret('ROADIE_DB_AUTH_TOKEN')
}

async function initializeDb(): Promise<RoadieDb> {
  const dbUrl = getDbUrl()
  const isFileMode = dbUrl.startsWith('file:')

  if (isFileMode) {
    const dataDir = getDataDir()
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch (e) {
      dbLogger.error(
        `Failed to create data directory ${dataDir}:`,
        (e as Error).message,
      )
    }
  }

  dbLogger.log(`Opening database via: ${dbUrl}`)

  const dbAuthToken = getDbAuthToken()
  const client = createClient({
    url: dbUrl,
    ...(dbAuthToken && { authToken: dbAuthToken }),
    ...(!isFileMode && { fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = typeof input === 'string' || input instanceof URL
        ? new Request(String(input), init)
        : new Request(input, init)
      const token = getDbAuthToken()
      if (token) request.headers.set('authorization', `Bearer ${token}`)
      else request.headers.delete('authorization')
      return fetch(request)
    } }),
  })
  const db = createDrizzleClient(client)

  try {
    if (isFileMode) {
      await client.execute('PRAGMA journal_mode = WAL')
      await client.execute('PRAGMA busy_timeout = 5000')
    }

    dbLogger.log('Running schema migrations...')
    await migrateSchema(client)
    dbLogger.log('Schema migration complete')
  } catch (error) {
    dbLogger.error('Drizzle init failed:', formatErrorWithStack(error))
    throw error
  }

  clientInstance = client
  dbInstance = db
  return db
}

async function migrateSchema(client: Client): Promise<void> {
  // Tables retired from schema.sql: worktree bindings (now thread_workspaces).
  for (const table of ['thread_worktrees', 'channel_worktrees']) {
    await client.execute(`DROP TABLE IF EXISTS ${table}`)
  }

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

  // Existing part_messages tables never get a rewritten FK. Drop orphans.
  // NOT EXISTS, not NOT IN: a NULL thread_sessions.thread_id would make
  // NOT IN unknown for every row and skip the whole cleanup.
  await client.execute(`
    DELETE FROM part_messages
    WHERE NOT EXISTS (
      SELECT 1
      FROM thread_sessions
      WHERE thread_sessions.thread_id = part_messages.thread_id
    )
  `)
}

export async function closeDb(): Promise<void> {
  if (clientInstance) {
    clientInstance.close()
    clientInstance = null
    dbInstance = null
    initPromise = null
    dbLogger.log('Drizzle connection closed')
  }
}
