// Tests for Drizzle client initialization and schema migration.
// Auto-isolated via VITEST guards in config.ts (temp data dir) and db.ts (clears ROADIE_DB_URL).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { closeDb, getDb } from './db.js'
import * as orm from 'drizzle-orm'
import * as schema from './schema.js'
import {
  appendSessionEventsSinceLastTimestamp,
  cleanupDeletedThread,
  completeIpcRequest,
  createIpcRequest,
  createScheduledTask,
  getThreadWorkingDirectory,
  setThreadWorkingDirectory,
  deleteChannelDirectoryById,
  deleteThreadQueueItem,
  getChannelDirectory,
  getDueSessionSleeps,
  getIpcRequestById,
  getScheduledTask,
  getSessionCredentialOwner,
  getSessionEventSnapshot,
  getSessionTurnAttribution,
  getSessionAgent,
  getSessionModel,
  getSessionSleep,
  getThreadSession,
  insertThreadQueueItem,
  listAllThreadQueueItems,
  listThreadQueueItems,
  recordCredentialOwner,
  recordCredentialPayerNotice,
  setChannelDirectory,
  setChannelVerbosity,
  setSessionAgent,
  setSessionModel,
  setSessionTurnAttribution,
  setThreadSession,
  updateThreadQueueItemPayload,
  upsertSessionSleep,
} from './database.js'
import { createClient } from '@libsql/client'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { chooseLockPort } from './test-utils.js'
import { copySessionPreferences } from './commands/model.js'
import type { initializeOpencodeForDirectory } from './opencode.js'
import {
  canRewriteSubrouterModel,
  formatSubrouterStartupMigration,
  hasSubrouterHandoff,
  migrateSubrouterCredentialsAtStartup,
} from './credentials/migrate-subrouter.js'
import {
  addPoolAccount,
  readPoolAccounts,
  setPoolRotation,
  SHARED_POOL_ID,
} from './credentials/store.js'
import { resetCatalogCacheForTests } from './credentials/provider-catalog.js'

// Created per run: a fresh checkout has no tmp/, and other test files only
// create one as a side effect, so relying on it made these tests order-dependent.
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-db-test-'))

afterAll(async () => {
  await closeDb()
  fs.rmSync(testDbDir, { recursive: true, force: true })
})

describe('getDb', () => {
  test('schema.sql creates every drizzle table', () => {
    const schemaTs = fs.readFileSync(
      path.join(import.meta.dirname, 'schema.ts'),
      'utf8',
    )
    const schemaSql = fs.readFileSync(
      path.join(import.meta.dirname, 'schema.sql'),
      'utf8',
    )
    const tablesFromTs = [
      ...schemaTs.matchAll(/sqliteTable\('([^']+)'/g),
    ].map((match) => match[1])
    const tablesFromSql = [
      ...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`/g),
    ].map((match) => match[1])
    expect(new Set(tablesFromSql)).toEqual(new Set(tablesFromTs))
    expect(tablesFromSql).toContain('session_sleeps')
    expect(tablesFromSql).toContain('thread_queue_items')
  })

  test('persists local queue items in FIFO order', async () => {
    const db = await getDb()
    const threadId = `test-queue-thread-${crypto.randomUUID()}`
    const firstId = `queue-${crypto.randomUUID()}`
    const secondId = `queue-${crypto.randomUUID()}`

    await insertThreadQueueItem({
      queueId: firstId,
      threadId,
      payloadJson: JSON.stringify({ prompt: 'first', userId: '1', username: 'tommy' }),
    })
    await insertThreadQueueItem({
      queueId: secondId,
      threadId,
      payloadJson: JSON.stringify({ prompt: 'second', userId: '1', username: 'tommy' }),
    })

    const rows = await listThreadQueueItems(threadId)
    expect(rows.map((row) => JSON.parse(row.payload_json).prompt)).toEqual([
      'first',
      'second',
    ])

    await updateThreadQueueItemPayload({
      queueId: firstId,
      payloadJson: JSON.stringify({ prompt: 'first-edited', userId: '1', username: 'tommy' }),
    })
    await deleteThreadQueueItem(secondId)

    const after = await listAllThreadQueueItems()
    const remaining = after.filter((row) => row.thread_id === threadId)
    expect(remaining).toHaveLength(1)
    expect(JSON.parse(remaining[0]!.payload_json).prompt).toBe('first-edited')

    await db.delete(schema.thread_queue_items).where(orm.eq(schema.thread_queue_items.thread_id, threadId))
  })

  test('cancels channel tasks before deleting a channel mapping', async () => {
    const channelId = `channel-${crypto.randomUUID()}`
    await setChannelDirectory({
      channelId,
      directory: `/tmp/${channelId}`,
      channelType: 'text',
    })
    await setChannelVerbosity(channelId, 'text_only')
    const taskId = await createScheduledTask({
      scheduleKind: 'at',
      nextRunAt: new Date('2099-01-01T00:00:00.000Z'),
      payloadJson: JSON.stringify({ kind: 'channel', channelId, prompt: 'later' }),
      promptPreview: 'later',
      channelId,
    })

    expect(await deleteChannelDirectoryById(channelId)).toBe(true)

    const db = await getDb()
    expect({
      mapping: await getChannelDirectory(channelId),
      task: await getScheduledTask(taskId),
      verbosity: await db.query.channel_verbosity.findFirst({
        where: { channel_id: channelId },
      }),
    }).toMatchObject({
      mapping: undefined,
      task: {
        status: 'cancelled',
        last_error: 'Discord channel was deleted',
      },
      verbosity: undefined,
    })
  })

  test('cleans pending work when a Discord thread is deleted', async () => {
    const threadId = `thread-${crypto.randomUUID()}`
    const sessionId = `session-${crypto.randomUUID()}`
    const queueId = `queue-${crypto.randomUUID()}`
    await setThreadSession(threadId, sessionId)
    await insertThreadQueueItem({
      queueId,
      threadId,
      payloadJson: JSON.stringify({ prompt: 'queued' }),
    })
    await upsertSessionSleep({
      sessionId,
      wakeAt: new Date('2099-01-01T00:00:00.000Z'),
      reason: 'later',
    })
    const ipcRequest = await createIpcRequest({
      type: 'file_upload',
      sessionId,
      threadId,
      payload: '{}',
    })
    const taskId = await createScheduledTask({
      scheduleKind: 'at',
      nextRunAt: new Date('2099-01-01T00:00:00.000Z'),
      payloadJson: JSON.stringify({ kind: 'thread', threadId, prompt: 'later' }),
      promptPreview: 'later',
      threadId,
      sessionId,
    })

    await cleanupDeletedThread(threadId)
    await completeIpcRequest({ id: ipcRequest.id, response: 'late response' })

    expect({
      ipc: await getIpcRequestById({ id: ipcRequest.id }),
      queue: await listThreadQueueItems(threadId),
      session: await getThreadSession(threadId),
      sleep: await getSessionSleep({ sessionId }),
      task: await getScheduledTask(taskId),
    }).toMatchObject({
      ipc: { status: 'cancelled' },
      queue: [],
      session: sessionId,
      sleep: { status: 'cancelled' },
      task: {
        status: 'cancelled',
        last_error: 'Discord thread was deleted',
      },
    })
  })

  test('deleting an old resumed thread preserves the current session sleep', async () => {
    const db = await getDb()
    const sessionId = `resumed-session-${crypto.randomUUID()}`
    const oldThreadId = `old-thread-${crypto.randomUUID()}`
    const currentThreadId = `current-thread-${crypto.randomUUID()}`
    await setThreadSession(oldThreadId, sessionId)
    await setThreadSession(currentThreadId, sessionId)
    await db.update(schema.thread_sessions)
      .set({ updated_at: new Date('2020-01-01T00:00:00.000Z') })
      .where(orm.eq(schema.thread_sessions.thread_id, oldThreadId))
    await db.update(schema.thread_sessions)
      .set({ updated_at: new Date('2021-01-01T00:00:00.000Z') })
      .where(orm.eq(schema.thread_sessions.thread_id, currentThreadId))
    await upsertSessionSleep({
      sessionId,
      wakeAt: new Date('2099-01-01T00:00:00.000Z'),
      reason: 'still current',
    })

    await cleanupDeletedThread(oldThreadId)

    expect(await getSessionSleep({ sessionId })).toMatchObject({
      status: 'planned',
    })
  })

  test('migrates pending fork titles and preserves the claimed task across reopening', async () => {
    await closeDb()
    const previousDbUrl = process.env['ROADIE_DB_URL']
    const dbPath = path.join(testDbDir, `test-db-fork-title-${crypto.randomUUID()}.db`)
    const client = createClient({ url: `file:${dbPath}` })
    await client.execute('CREATE TABLE pending_fork_titles (session_id TEXT PRIMARY KEY NOT NULL, inherited_title TEXT NOT NULL)')
    await client.execute("INSERT INTO pending_fork_titles VALUES ('legacy-fork', 'Inherited title')")
    client.close()
    process.env['ROADIE_DB_URL'] = `file:${dbPath}`
    try {
      const db = await getDb()
      expect(await db.query.pending_fork_titles.findFirst({ where: { session_id: 'legacy-fork' } })).toMatchObject({
        inherited_title: 'Inherited title', task_prompt: null,
      })
      await db.update(schema.pending_fork_titles).set({ task_prompt: 'Original task' }).where(orm.eq(schema.pending_fork_titles.session_id, 'legacy-fork'))
      await closeDb()
      expect(await (await getDb()).query.pending_fork_titles.findFirst({ where: { session_id: 'legacy-fork' } })).toMatchObject({
        inherited_title: 'Inherited title', task_prompt: 'Original task',
      })
    } finally {
      await closeDb()
      if (previousDbUrl === undefined) delete process.env['ROADIE_DB_URL']
      else process.env['ROADIE_DB_URL'] = previousDbUrl
    }
  })

  test('rebuilds thread_queue_items that still use queue_id as the primary key', async () => {
    await closeDb()

    const previousDbUrl = process.env['ROADIE_DB_URL']
    const dbPath = path.join(testDbDir, `test-db-legacy-queue-${crypto.randomUUID().slice(0, 8)}.db`)

    try {
      const client = createClient({ url: `file:${dbPath}` })
      await client.execute(`
        CREATE TABLE thread_queue_items (
          queue_id text PRIMARY KEY,
          thread_id text NOT NULL,
          payload_json text NOT NULL,
          created_at datetime DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await client.execute(`
        CREATE INDEX thread_queue_items_thread_id_created_at_queue_id_idx
        ON thread_queue_items (thread_id, created_at, queue_id)
      `)
      await client.execute(`
        INSERT INTO thread_queue_items (queue_id, thread_id, payload_json, created_at)
        VALUES
          ('queue-second', 'thr-legacy-queue', '{"prompt":"second"}', '2026-09-17 10:00:02'),
          ('queue-first', 'thr-legacy-queue', '{"prompt":"first"}', '2026-09-17 10:00:01')
      `)
      client.close()

      process.env['ROADIE_DB_URL'] = `file:${dbPath}`
      await getDb()

      const rows = await listThreadQueueItems('thr-legacy-queue')
      expect(rows.map((row) => JSON.parse(row.payload_json).prompt)).toEqual([
        'first',
        'second',
      ])
      expect(rows.map((row) => row.id)).toEqual([1, 2])

      await insertThreadQueueItem({
        queueId: 'queue-third',
        threadId: 'thr-legacy-queue',
        payloadJson: JSON.stringify({ prompt: 'third' }),
      })
      const after = await listThreadQueueItems('thr-legacy-queue')
      expect(after.map((row) => JSON.parse(row.payload_json).prompt)).toEqual([
        'first',
        'second',
        'third',
      ])
    } finally {
      await closeDb()
      if (previousDbUrl === undefined) {
        delete process.env['ROADIE_DB_URL']
      } else {
        process.env['ROADIE_DB_URL'] = previousDbUrl
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('removes part_messages rows whose thread_sessions parent is gone', async () => {
    await closeDb()

    const previousDbUrl = process.env['ROADIE_DB_URL']
    const dbPath = path.join(testDbDir, `test-db-orphan-parts-${crypto.randomUUID().slice(0, 8)}.db`)

    try {
      const client = createClient({ url: `file:${dbPath}` })
      await client.execute(`
        CREATE TABLE thread_sessions (
          thread_id text PRIMARY KEY,
          session_id text NOT NULL
        )
      `)
      await client.execute(`
        CREATE TABLE part_messages (
          part_id text PRIMARY KEY,
          message_id text NOT NULL,
          thread_id text NOT NULL,
          created_at datetime DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_part_messages_thread_id_thread_sessions_thread_id_fk
            FOREIGN KEY (thread_id) REFERENCES thread_sessions(thread_id) ON UPDATE CASCADE
        )
      `)
      await client.execute(`
        INSERT INTO thread_sessions (thread_id, session_id)
        VALUES ('thr-keep', 'ses-keep'), ('thr-gone', 'ses-gone')
      `)
      await client.execute(`
        INSERT INTO part_messages (part_id, message_id, thread_id)
        VALUES
          ('part-keep', 'msg-keep', 'thr-keep'),
          ('part-orphan', 'msg-orphan', 'thr-gone')
      `)
      // sqlite3 CLI leaves foreign_keys OFF, which is how real installs
      // accumulate these orphans. libsql defaults to ON.
      await client.execute('PRAGMA foreign_keys = OFF')
      await client.execute(`DELETE FROM thread_sessions WHERE thread_id = 'thr-gone'`)
      await client.execute(`
        INSERT INTO thread_sessions (thread_id, session_id)
        VALUES (NULL, 'ses-null')
      `)
      await client.execute('PRAGMA foreign_keys = ON')
      const before = await client.execute(`
        SELECT COUNT(*) AS n FROM part_messages
        WHERE NOT EXISTS (
          SELECT 1 FROM thread_sessions
          WHERE thread_sessions.thread_id = part_messages.thread_id
        )
      `)
      expect(Number(before.rows[0]?.n)).toBe(1)
      client.close()

      process.env['ROADIE_DB_URL'] = `file:${dbPath}`
      const db = await getDb()
      const remaining = await db.query.part_messages.findMany({
        columns: { part_id: true },
        orderBy: { part_id: 'asc' },
      })
      expect(remaining).toMatchInlineSnapshot(`
        [
          {
            "part_id": "part-keep",
          },
        ]
      `)
    } finally {
      await closeDb()
      if (previousDbUrl === undefined) {
        delete process.env['ROADIE_DB_URL']
      } else {
        process.env['ROADIE_DB_URL'] = previousDbUrl
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('deleting a thread_sessions row also deletes its part_messages', async () => {
    const db = await getDb()
    const threadId = `test-part-cascade-${crypto.randomUUID()}`
    await db.insert(schema.thread_sessions).values({
      thread_id: threadId,
      session_id: 'ses-part-cascade',
    })
    await db.insert(schema.part_messages).values({
      part_id: `${threadId}-part`,
      message_id: 'msg-part-cascade',
      thread_id: threadId,
    })
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, threadId))
    const leftover = await db.query.part_messages.findFirst({
      where: { thread_id: threadId },
    })
    expect(leftover).toBeUndefined()
  })

  test('adds session_sleeps delivery columns on databases created before that schema', async () => {
    await closeDb()

    const previousDbUrl = process.env['ROADIE_DB_URL']
    const dbPath = path.join(testDbDir, `test-db-legacy-sleeps-${crypto.randomUUID().slice(0, 8)}.db`)

    try {
      const client = createClient({ url: `file:${dbPath}` })
      await client.execute(`
        CREATE TABLE thread_sessions (
          thread_id text PRIMARY KEY,
          session_id text NOT NULL
        )
      `)
      await client.execute(`
        CREATE TABLE session_sleeps (
          session_id text PRIMARY KEY,
          thread_id text NOT NULL,
          wake_at datetime NOT NULL,
          reason text,
          status text DEFAULT 'planned' NOT NULL,
          created_at datetime DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await client.execute(`
        INSERT INTO thread_sessions (thread_id, session_id)
        VALUES ('thr-legacy', 'ses-legacy')
      `)
      await client.execute(`
        INSERT INTO session_sleeps (session_id, thread_id, wake_at, status)
        VALUES ('ses-legacy', 'thr-legacy', '2020-01-01T00:00:00.000Z', 'planned')
      `)
      client.close()

      process.env['ROADIE_DB_URL'] = `file:${dbPath}`
      await getDb()

      const due = await getDueSessionSleeps({
        now: new Date('2026-08-21T00:00:00Z'),
        retryAfterMs: 30_000,
        limit: 10,
      })
      const legacy = due.find((row) => row.session_id === 'ses-legacy')
      expect(legacy?.delivery_id).toBeTruthy()
      expect(legacy?.attempts).toBe(0)

      // The first table required thread_id. After the column was dropped from
      // the schema, inserts that omit it must still work on existing databases.
      await upsertSessionSleep({
        sessionId: 'ses-legacy-new',
        wakeAt: new Date('2026-08-26T00:00:00Z'),
        reason: 'check the reply',
      })
      const created = await getSessionSleep({ sessionId: 'ses-legacy-new' })
      expect(created?.status).toBe('planned')
      expect(created?.reason).toBe('check the reply')
      expect(created?.delivery_id).toBeTruthy()
    } finally {
      await closeDb()
      if (previousDbUrl === undefined) {
        delete process.env['ROADIE_DB_URL']
      } else {
        process.env['ROADIE_DB_URL'] = previousDbUrl
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('adds session_actors credential_pool on databases created before phase 2a', async () => {
    await closeDb()

    const previousDbUrl = process.env['ROADIE_DB_URL']
    const dbPath = path.join(testDbDir, `test-db-legacy-actors-${crypto.randomUUID().slice(0, 8)}.db`)

    try {
      const client = createClient({ url: `file:${dbPath}` })
      // session_actors as shipped before credential pools phase 2a: no
      // credential_pool column, and person_id may be missing too.
      await client.execute(`
        CREATE TABLE session_actors (
          session_id text PRIMARY KEY,
          thread_id text,
          channel_id text,
          actor_platform text,
          actor_id text,
          actor_name text,
          actor_via text,
          updated_at datetime
        )
      `)
      await client.execute(`
        INSERT INTO session_actors (session_id, thread_id, actor_platform, actor_id, actor_via)
        VALUES ('ses-legacy-actors', 'thr-legacy-actors', 'discord', '42', 'chat')
      `)
      client.close()

      process.env['ROADIE_DB_URL'] = `file:${dbPath}`
      await getDb()

      // The legacy row survives, and attribution writes with the new column work.
      await setSessionTurnAttribution({
        sessionId: 'ses-legacy-actors',
        threadId: 'thr-legacy-actors',
        actor: { platform: 'discord', id: '42', via: 'chat' },
        personId: 'wp:1',
        credentialPool: 'alice',
      })
      expect(await getSessionTurnAttribution('ses-legacy-actors')).toMatchObject({
        sessionId: 'ses-legacy-actors',
        personId: 'wp:1',
        credentialPool: 'alice',
      })

      // A turn without an actor clears the pool with the actor.
      await setSessionTurnAttribution({ sessionId: 'ses-legacy-actors', threadId: 'thr-legacy-actors' })
      expect(await getSessionTurnAttribution('ses-legacy-actors')).not.toHaveProperty('credentialPool')
    } finally {
      await closeDb()
      if (previousDbUrl === undefined) {
        delete process.env['ROADIE_DB_URL']
      } else {
        process.env['ROADIE_DB_URL'] = previousDbUrl
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('credential owner: the first speaker owns and later speakers do not move it', async () => {
    const sessionId = `ses-owner-${crypto.randomUUID()}`
    await recordCredentialOwner({ sessionId, poolId: 'alice', personKey: 'discord:1' })
    expect(await getSessionCredentialOwner(sessionId)).toEqual({
      poolId: 'alice',
      personKey: 'discord:1',
    })

    // A second speaker (or the same person on another turn) never moves it.
    await recordCredentialOwner({ sessionId, poolId: 'bob', personKey: 'discord:2' })
    await recordCredentialOwner({ sessionId, poolId: 'alice', personKey: 'discord:1' })
    expect(await getSessionCredentialOwner(sessionId)).toEqual({
      poolId: 'alice',
      personKey: 'discord:1',
    })

    // A fork (new session id) gets its own owner.
    const forkId = `ses-fork-${crypto.randomUUID()}`
    await recordCredentialOwner({ sessionId: forkId, poolId: 'bob', personKey: 'discord:2' })
    expect(await getSessionCredentialOwner(forkId)).toEqual({ poolId: 'bob', personKey: 'discord:2' })
    expect(await getSessionCredentialOwner(sessionId)).toEqual({
      poolId: 'alice',
      personKey: 'discord:1',
    })

    // Sessions with no actor never get a row: callers default them to shared.
    expect(await getSessionCredentialOwner(`ses-unowned-${crypto.randomUUID()}`)).toBeUndefined()
  })

  test('credential payer notice: claimed exactly once per session', async () => {
    const sessionId = `ses-payer-${crypto.randomUUID()}`
    const db = await getDb()

    // The first claim inserts and reports true; the caller posts the notice.
    expect(await recordCredentialPayerNotice({
      sessionId,
      previousPoolId: 'alice',
      poolId: 'bob',
    })).toBe(true)

    // Later turns on the same session (any payer pair) are no-ops, so the
    // notice posts exactly once — across restarts too, the row is durable.
    expect(await recordCredentialPayerNotice({ sessionId, previousPoolId: 'bob', poolId: 'alice' })).toBe(false)
    expect(await recordCredentialPayerNotice({ sessionId, poolId: 'bob' })).toBe(false)

    const rows = await db.select()
      .from(schema.credential_payer_notices)
      .where(orm.eq(schema.credential_payer_notices.session_id, sessionId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      session_id: sessionId,
      previous_pool_id: 'alice',
      pool_id: 'bob',
    })

    // Another session claims independently.
    const forkId = `ses-payer-${crypto.randomUUID()}`
    expect(await recordCredentialPayerNotice({ sessionId: forkId, poolId: 'carol' })).toBe(true)
  })

  test('rebuilds session_sleeps that still have posted_at from the intermediate schema', async () => {
    await closeDb()

    const previousDbUrl = process.env['ROADIE_DB_URL']
    const dbPath = path.join(testDbDir, `test-db-posted-sleeps-${crypto.randomUUID().slice(0, 8)}.db`)

    try {
      const client = createClient({ url: `file:${dbPath}` })
      await client.execute(`
        CREATE TABLE thread_sessions (
          thread_id text PRIMARY KEY,
          session_id text NOT NULL
        )
      `)
      await client.execute(`
        CREATE TABLE session_sleeps (
          session_id text PRIMARY KEY,
          thread_id text NOT NULL,
          wake_at datetime NOT NULL,
          reason text,
          status text DEFAULT 'planned' NOT NULL,
          delivery_id text NOT NULL,
          attempts integer DEFAULT 0 NOT NULL,
          last_attempt_at datetime,
          posted_at datetime,
          created_at datetime DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await client.execute(`
        INSERT INTO thread_sessions (thread_id, session_id)
        VALUES ('thr-posted', 'ses-posted')
      `)
      await client.execute(`
        INSERT INTO session_sleeps (
          session_id, thread_id, wake_at, status, delivery_id, posted_at
        )
        VALUES (
          'ses-posted',
          'thr-posted',
          '2020-01-01T00:00:00.000Z',
          'posted',
          'del-posted',
          '2020-01-01T00:00:01.000Z'
        )
      `)
      client.close()

      process.env['ROADIE_DB_URL'] = `file:${dbPath}`
      await getDb()

      const due = await getDueSessionSleeps({
        now: new Date('2026-08-21T00:00:00Z'),
        retryAfterMs: 30_000,
        limit: 10,
      })
      const posted = due.find((row) => row.session_id === 'ses-posted')
      expect(posted?.status).toBe('planned')
      expect(posted?.delivery_id).toBe('del-posted')

      await upsertSessionSleep({
        sessionId: 'ses-posted',
        wakeAt: new Date('2026-08-26T00:00:00Z'),
        reason: 'retry after schema change',
      })
      const updated = await getSessionSleep({ sessionId: 'ses-posted' })
      expect(updated?.status).toBe('planned')
      expect(updated?.reason).toBe('retry after schema change')
      expect(updated?.delivery_id).not.toBe('del-posted')
    } finally {
      await closeDb()
      if (previousDbUrl === undefined) {
        delete process.env['ROADIE_DB_URL']
      } else {
        process.env['ROADIE_DB_URL'] = previousDbUrl
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('creates sqlite file and migrates schema automatically', async () => {
    const db = await getDb()

    const [session] = await db.insert(schema.thread_sessions)
      .values({ thread_id: 'test-thread-123', session_id: 'test-session-456' })
      .returning()
    expect(session).toBeDefined()
    if (!session) throw new Error('Expected inserted session row')
    expect(session.thread_id).toBe('test-thread-123')
    expect(session.created_at).toBeInstanceOf(Date)

    const found = await db.query.thread_sessions.findFirst({
      where: { thread_id: session.thread_id },
    })
    expect(found?.session_id).toBe('test-session-456')

    // Cleanup test data
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, 'test-thread-123'))
  })

  test('migrates fresh sqlite files through hrana', async () => {
    await closeDb()

    const previousDbUrl = process.env['ROADIE_DB_URL']
    const previousLockPort = process.env['ROADIE_LOCK_PORT']
    const dbPath = path.join(testDbDir, `test-db-hrana-${crypto.randomUUID().slice(0, 8)}.db`)

    try {
      process.env['ROADIE_LOCK_PORT'] = String(chooseLockPort({ key: 'db-hrana-migration-test' }))
      const hranaResult = await startHranaServer({ dbPath })
      if (hranaResult instanceof Error) throw hranaResult
      process.env['ROADIE_DB_URL'] = hranaResult

      const db = await getDb()
      const [created] = await db.insert(schema.bot_tokens)
        .values({ app_id: 'hrana-bot', token: 'test-token' })
        .returning({ appId: schema.bot_tokens.app_id })

      expect(created).toMatchInlineSnapshot(`
        {
          "appId": "hrana-bot",
        }
      `)
    } finally {
      await closeDb()
      await stopHranaServer()
      if (previousDbUrl === undefined) {
        delete process.env['ROADIE_DB_URL']
      } else {
        process.env['ROADIE_DB_URL'] = previousDbUrl
      }
      if (previousLockPort === undefined) {
        delete process.env['ROADIE_LOCK_PORT']
      } else {
        process.env['ROADIE_LOCK_PORT'] = previousLockPort
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('shares one initialization between concurrent callers', async () => {
    await closeDb()

    const [first, second] = await Promise.all([getDb(), getDb()])

    expect(first).toBe(second)
  })

  test('retries database initialization after a failed attempt', async () => {
    await closeDb()

    const previousDbUrl = process.env['ROADIE_DB_URL']
    const previousLockPort = process.env['ROADIE_LOCK_PORT']
    const dbPath = path.join(testDbDir, `test-db-init-retry-${crypto.randomUUID().slice(0, 8)}.db`)

    try {
      process.env['ROADIE_LOCK_PORT'] = String(chooseLockPort({ key: 'db-init-retry-test' }))
      const firstStart = await startHranaServer({ dbPath })
      if (firstStart instanceof Error) throw firstStart
      process.env['ROADIE_DB_URL'] = firstStart

      // Bring the server down so the first initialization fails, then call getDb.
      await stopHranaServer()
      await expect(getDb()).rejects.toThrow()

      // The server comes back on the same port; the next call must retry.
      const secondStart = await startHranaServer({ dbPath })
      if (secondStart instanceof Error) throw secondStart
      process.env['ROADIE_DB_URL'] = secondStart

      await expect(getDb()).resolves.toBeDefined()
    } finally {
      await closeDb()
      await stopHranaServer()
      if (previousDbUrl === undefined) {
        delete process.env['ROADIE_DB_URL']
      } else {
        process.env['ROADIE_DB_URL'] = previousDbUrl
      }
      if (previousLockPort === undefined) {
        delete process.env['ROADIE_LOCK_PORT']
      } else {
        process.env['ROADIE_LOCK_PORT'] = previousLockPort
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('setThreadWorkingDirectory binds a thread and creates its session row', async () => {
    const db = await getDb()
    const threadId = `test-workdir-${Date.now()}`

    await setThreadWorkingDirectory({
      threadId,
      projectDirectory: '/tmp/regression-project',
      workingDirectory: '/tmp/regression-project/packages/app',
      label: 'app',
    })

    const session = await db.query.thread_sessions.findFirst({
      where: { thread_id: threadId },
    })
    expect(session?.session_id).toBe('')
    expect(await getThreadWorkingDirectory(threadId)).toEqual({
      projectDirectory: '/tmp/regression-project',
      workingDirectory: '/tmp/regression-project/packages/app',
      label: 'app',
      kind: 'directory',
    })

    // Rebinding replaces the directory in place.
    await setThreadWorkingDirectory({
      threadId,
      projectDirectory: '/tmp/regression-project',
      workingDirectory: '/tmp/checkouts/feature',
      label: 'feature',
      kind: 'git-worktree',
    })
    expect((await getThreadWorkingDirectory(threadId))?.workingDirectory).toBe('/tmp/checkouts/feature')

    await db.delete(schema.thread_workspaces).where(orm.eq(schema.thread_workspaces.thread_id, threadId))
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, threadId))
  })

  test('legacy pending rows are ignored and legacy worktree kinds normalize', async () => {
    const db = await getDb()
    const pendingThread = `test-workdir-pending-${Date.now()}`
    const legacyThread = `test-workdir-legacy-${Date.now()}`
    await db.insert(schema.thread_sessions).values([
      { thread_id: pendingThread, session_id: '' },
      { thread_id: legacyThread, session_id: '' },
    ])
    await db.insert(schema.thread_workspaces).values([
      { thread_id: pendingThread, workspace_type: 'roadie-worktree', workspace_name: 'x', project_directory: '/p', status: 'pending' },
      { thread_id: legacyThread, workspace_type: 'kimaki-worktree', workspace_name: 'b', project_directory: '/p', workspace_directory: '/w', status: 'ready' },
    ])

    expect(await getThreadWorkingDirectory(pendingThread)).toBeUndefined()
    expect((await getThreadWorkingDirectory(legacyThread))?.kind).toBe('git-worktree')

    for (const id of [pendingThread, legacyThread]) {
      await db.delete(schema.thread_workspaces).where(orm.eq(schema.thread_workspaces.thread_id, id))
      await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, id))
    }
  })

  // Regression: btw forks lost the agent and ran `build` instead of the source
  // agent, which changed tools and busted the whole prompt cache.
  test('copySessionPreferences snapshots source session agent and model to forked session', async () => {
    const db = await getDb()
    const sourceSessionId = `test-source-session-${crypto.randomUUID()}`
    const targetSessionId = `test-target-session-${crypto.randomUUID()}`
    const getClient = (() => {
      throw new Error('provider lookup should not run for explicit session models')
    }) satisfies Exclude<Awaited<ReturnType<typeof initializeOpencodeForDirectory>>, Error>

    await setSessionModel({
      sessionId: sourceSessionId,
      modelId: 'anthropic/claude-opus-4-6',
      variant: 'thinking',
    })
    await setSessionAgent(sourceSessionId, 'opus')

    await copySessionPreferences({
      sourceSessionId,
      targetSessionId,
      getClient,
    })

    expect({
      agent: await getSessionAgent(targetSessionId),
      model: await getSessionModel(targetSessionId),
    }).toMatchInlineSnapshot(`
      {
        "agent": "opus",
        "model": {
          "modelId": "anthropic/claude-opus-4-6",
          "variant": "thinking",
        },
      }
    `)

    await db.delete(schema.session_models).where(orm.inArray(schema.session_models.session_id, [sourceSessionId, targetSessionId]))
    await db.delete(schema.session_agents).where(orm.inArray(schema.session_agents.session_id, [sourceSessionId, targetSessionId]))
  })

  test('session event persistence uses (timestamp, event_index) ordering for deterministic same-ms replay', async () => {
    const db = await getDb()
    const threadId = 'test-session-events-thread'
    const sessionId = 'test-session-events-session'

    await db.delete(schema.session_events).where(orm.eq(schema.session_events.session_id, sessionId))
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, threadId))

    await db.insert(schema.thread_sessions).values({ thread_id: threadId, session_id: sessionId })

    const baseTimestamp = 1_700_000_000_000

    const inserted1 = await appendSessionEventsSinceLastTimestamp({
      sessionId,
      events: [
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 2,
          event_json: JSON.stringify({ id: 'e2' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 0,
          event_json: JSON.stringify({ id: 'e0' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 1,
          event_json: JSON.stringify({ id: 'e1' }),
        },
      ],
    })

    const inserted2 = await appendSessionEventsSinceLastTimestamp({
      sessionId,
      events: [
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 0,
          event_json: JSON.stringify({ id: 'e0' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 1,
          event_json: JSON.stringify({ id: 'e1' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 2,
          event_json: JSON.stringify({ id: 'e2' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 3,
          event_json: JSON.stringify({ id: 'e3' }),
        },
      ],
    })

    const rows = await getSessionEventSnapshot({ sessionId })
    const orderedIds = rows.map((row) => {
      const parsed = JSON.parse(row.event_json) as { id: string }
      return parsed.id
    })

    expect({ inserted1, inserted2, orderedIds }).toMatchInlineSnapshot(`
      {
        "inserted1": 3,
        "inserted2": 1,
        "orderedIds": [
          "e0",
          "e1",
          "e2",
          "e3",
        ],
      }
    `)

    await db.delete(schema.session_events).where(orm.eq(schema.session_events.session_id, sessionId))
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, threadId))
  })
})

// One-time startup migration from subrouter (credential pools phase 4a):
// accounts into the shared pool and `subrouter/<preset>` stored model choices
// rewritten to the imported `roadie/<preset>` rotations. Legacy databases are
// built file-first (like real installs), then opened through getDb().
describe('subrouter startup migration', () => {
  let migrationDataDir: string
  let subrouterHome: string
  let originalXdgCacheHome: string | undefined

  // Fixture catalog through $XDG_CACHE_HOME so the account import resolves
  // providers without network and without ever touching the real home.
  const TEST_CATALOG = {
    anthropic: { id: 'anthropic', npm: '@ai-sdk/anthropic' },
    openai: { id: 'openai', npm: '@ai-sdk/openai' },
  }

  beforeEach(() => {
    migrationDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-subrouter-migration-'))
    subrouterHome = fs.mkdtempSync(path.join(os.tmpdir(), 'subrouter-home-migration-'))
    originalXdgCacheHome = process.env.XDG_CACHE_HOME
    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-migration-cache-'))
    fs.mkdirSync(path.join(cacheHome, 'opencode'), { recursive: true })
    fs.writeFileSync(path.join(cacheHome, 'opencode', 'models.json'), JSON.stringify(TEST_CATALOG))
    process.env.XDG_CACHE_HOME = cacheHome
    resetCatalogCacheForTests()
  })

  afterEach(() => {
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome
    }
    resetCatalogCacheForTests()
    fs.rmSync(migrationDataDir, { recursive: true, force: true })
    fs.rmSync(subrouterHome, { recursive: true, force: true })
  })

  // Legacy tables the migration rewrites, in their pre-phase-4a shape (the
  // timestamp columns predate subrouter choices, so they are present).
  async function createLegacyModelChoicesDb(dbPath: string): Promise<void> {
    const client = createClient({ url: `file:${dbPath}` })
    await client.execute('CREATE TABLE bot_tokens (app_id text PRIMARY KEY, token text NOT NULL)')
    await client.execute(`
      CREATE TABLE global_models (
        app_id text PRIMARY KEY,
        model_id text NOT NULL,
        variant text,
        created_at datetime,
        updated_at datetime
      )
    `)
    await client.execute(`
      CREATE TABLE channel_directories (
        channel_id text PRIMARY KEY,
        directory text NOT NULL,
        channel_type text NOT NULL
      )
    `)
    await client.execute(`
      CREATE TABLE channel_models (
        channel_id text PRIMARY KEY,
        model_id text NOT NULL,
        variant text,
        created_at datetime,
        updated_at datetime
      )
    `)
    await client.execute(`
      CREATE TABLE session_models (
        session_id text PRIMARY KEY,
        model_id text NOT NULL,
        variant text,
        created_at datetime
      )
    `)
    await client.execute("INSERT INTO bot_tokens (app_id, token) VALUES ('bot-legacy', 'tok')")
    await client.execute(`
      INSERT INTO global_models (app_id, model_id, variant)
      VALUES ('bot-legacy', 'subrouter/max', 'high')
    `)
    await client.execute(`
      INSERT INTO channel_directories (channel_id, directory, channel_type)
      VALUES ('ch-legacy', '/tmp/legacy-project', 'text')
    `)
    await client.execute(`
      INSERT INTO channel_models (channel_id, model_id, variant)
      VALUES ('ch-legacy', 'subrouter/max', NULL)
    `)
    await client.execute(`
      INSERT INTO session_models (session_id, model_id, variant)
      VALUES
        ('ses-mappable', 'subrouter/max', 'thinking'),
        ('ses-unmappable', 'subrouter/copilot-only', NULL),
        ('ses-other', 'anthropic/claude-sonnet-4', NULL)
    `)
    client.close()
  }

  function writeSubrouterHomeFixture(): void {
    fs.writeFileSync(
      path.join(subrouterHome, 'auth.json'),
      JSON.stringify({
        providers: {
          anthropic: {
            activeIndex: 0,
            accounts: [
              { type: 'oauth', refresh: 'rt-mig-1', access: 'at-mig-1', expires: 1893456000001, email: 'alice@example.com', addedAt: 1, lastUsed: 1 },
            ],
          },
        },
      }),
    )
    fs.writeFileSync(
      path.join(subrouterHome, 'config.json'),
      JSON.stringify({
        presets: {
          max: ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4'],
          'copilot-only': ['github-copilot/gpt-5'],
        },
      }),
    )
  }

  async function openLegacyDb(name: string): Promise<{ dbPath: string; restore: () => Promise<void> }> {
    await closeDb()
    const dbPath = path.join(testDbDir, `test-db-subrouter-migration-${name}.db`)
    await createLegacyModelChoicesDb(dbPath)
    const previousDbUrl = process.env['ROADIE_DB_URL']
    process.env['ROADIE_DB_URL'] = `file:${dbPath}`
    return {
      dbPath,
      restore: async () => {
        await closeDb()
        if (previousDbUrl === undefined) delete process.env['ROADIE_DB_URL']
        else process.env['ROADIE_DB_URL'] = previousDbUrl
      },
    }
  }

  test('rewrites stored subrouter choices and never re-imports when the pool already has accounts', async () => {
    const { dbPath, restore } = await openLegacyDb('existing-accounts')
    try {
      // The pool was already imported (or managed by hand): one account and
      // the rotations the stored choices refer to.
      await addPoolAccount({ dataDir: migrationDataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'sk-existing' })
      await setPoolRotation({
        dataDir: migrationDataDir,
        poolId: SHARED_POOL_ID,
        name: 'max',
        entries: ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4'],
      })

      const migration = await migrateSubrouterCredentialsAtStartup({
        dataDir: migrationDataDir,
        subrouterHome,
      })
      expect(migration).not.toBeInstanceOf(Error)
      if (migration instanceof Error) return
      // Pool has accounts: the subrouter home is never even read.
      expect(migration.handedOff).toBe(false)
      expect(migration.import).toBeNull()
      expect(migration.rewrites).toMatchObject({
        globalModels: 1,
        channelModels: 1,
        sessionModels: 1,
        unmapped: 1,
        unmappedPresets: ['copilot-only'],
      })

      const db = await getDb()
      const globalModel = await db.query.global_models.findFirst({ where: { app_id: 'bot-legacy' } })
      expect(globalModel).toMatchObject({ model_id: 'roadie/max', variant: null })
      const channelModel = await db.query.channel_models.findFirst({ where: { channel_id: 'ch-legacy' } })
      expect(channelModel).toMatchObject({ model_id: 'roadie/max', variant: null })
      const sessions = await db.query.session_models.findMany({
        orderBy: { session_id: 'asc' },
      })
      expect(sessions).toMatchObject([
        { session_id: 'ses-mappable', model_id: 'roadie/max', variant: null },
        { session_id: 'ses-other', model_id: 'anthropic/claude-sonnet-4' },
        { session_id: 'ses-unmappable', model_id: 'subrouter/copilot-only' },
      ])

      // Pool untouched: still exactly the one pre-existing account.
      const accounts = readPoolAccounts({ dataDir: migrationDataDir, poolId: SHARED_POOL_ID })
      if (accounts instanceof Error) throw accounts
      expect(accounts).toHaveLength(1)
      expect(formatSubrouterStartupMigration(migration)).toEqual([
        'Migrated 3 stored model choices from subrouter/ to roadie/ (global 1, channel 1, session 1)',
        'Kept 1 subrouter model choice with no matching rotation: copilot-only',
      ])
    } finally {
      await restore()
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('imports accounts into an empty pool, then maps the stored choices', async () => {
    const { dbPath, restore } = await openLegacyDb('empty-pool')
    writeSubrouterHomeFixture()
    try {
      const migration = await migrateSubrouterCredentialsAtStartup({
        dataDir: migrationDataDir,
        subrouterHome,
      })
      expect(migration).not.toBeInstanceOf(Error)
      if (migration instanceof Error) return
      expect(migration.import).toMatchObject({
        poolId: SHARED_POOL_ID,
        accounts: { imported: 1, skipped: 0, failed: 0 },
        rotations: { set: 1, skipped: 1 },
      })
      expect(migration.rewrites).toMatchObject({
        globalModels: 1,
        channelModels: 1,
        sessionModels: 1,
        unmapped: 1,
        unmappedPresets: ['copilot-only'],
      })

      const accounts = readPoolAccounts({ dataDir: migrationDataDir, poolId: SHARED_POOL_ID })
      if (accounts instanceof Error) throw accounts
      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toMatchObject({ provider: 'anthropic', type: 'oauth', label: 'alice@example.com' })

      // Idempotent: a second startup imports nothing and rewrites nothing.
      const second = await migrateSubrouterCredentialsAtStartup({
        dataDir: migrationDataDir,
        subrouterHome,
      })
      // A clean import hands the accounts off: subrouter must stop refreshing them.
      expect(migration.handedOff).toBe(true)
      expect(hasSubrouterHandoff({ dataDir: migrationDataDir })).toBe(true)
      expect(second).not.toBeInstanceOf(Error)
      if (second instanceof Error) return
      expect(second.import).toBeNull()
      expect(second.rewrites).toMatchObject({
        globalModels: 0,
        channelModels: 0,
        sessionModels: 0,
        unmapped: 1,
      })
      const accountsAfter = readPoolAccounts({ dataDir: migrationDataDir, poolId: SHARED_POOL_ID })
      if (accountsAfter instanceof Error) throw accountsAfter
      expect(accountsAfter).toHaveLength(1)
    } finally {
      await restore()
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('an empty pool with no subrouter home skips the import and still rewrites from existing rotations', async () => {
    const { dbPath, restore } = await openLegacyDb('no-home')
    try {
      await setPoolRotation({
        dataDir: migrationDataDir,
        poolId: SHARED_POOL_ID,
        name: 'max',
        entries: ['anthropic/claude-opus-4-6'],
      })
      const migration = await migrateSubrouterCredentialsAtStartup({
        dataDir: migrationDataDir,
        subrouterHome: path.join(subrouterHome, 'does-not-exist'),
      })
      expect(migration).not.toBeInstanceOf(Error)
      if (migration instanceof Error) return
      expect(migration.import).toBeNull()
      expect(migration.importError).toBeNull()
      expect(migration.home).toBeNull()
      expect(migration.rewrites).toMatchObject({
        globalModels: 1,
        channelModels: 1,
        sessionModels: 1,
        unmapped: 1,
      })
      const accounts = readPoolAccounts({ dataDir: migrationDataDir, poolId: SHARED_POOL_ID })
      if (accounts instanceof Error) throw accounts
      expect(accounts).toHaveLength(0)
    } finally {
      await restore()
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('an unmappable preset keeps its rows on subrouter with the variant untouched', async () => {
    const { dbPath, restore } = await openLegacyDb('unmappable')
    try {
      await setPoolRotation({
        dataDir: migrationDataDir,
        poolId: SHARED_POOL_ID,
        name: 'max',
        entries: ['anthropic/claude-opus-4-6'],
      })
      const migration = await migrateSubrouterCredentialsAtStartup({
        dataDir: migrationDataDir,
        subrouterHome: path.join(subrouterHome, 'does-not-exist'),
      })
      expect(migration).not.toBeInstanceOf(Error)
      if (migration instanceof Error) return
      // ses-unmappable's variant (NULL here) is untouched; the mappable one's
      // variant is cleared.
      const db = await getDb()
      const unmappable = await db.query.session_models.findFirst({
        where: { session_id: 'ses-unmappable' },
      })
      expect(unmappable).toMatchObject({ model_id: 'subrouter/copilot-only', variant: null })
      const mappable = await db.query.session_models.findFirst({
        where: { session_id: 'ses-mappable' },
      })
      expect(mappable).toMatchObject({ model_id: 'roadie/max', variant: null })
      expect(formatSubrouterStartupMigration(migration)).toEqual([
        'Migrated 3 stored model choices from subrouter/ to roadie/ (global 1, channel 1, session 1)',
        'Kept 1 subrouter model choice with no matching rotation: copilot-only',
      ])
    } finally {
      await restore()
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('canRewriteSubrouterModel matches exact rotation names with entries only', () => {
    const rotations = { max: ['anthropic/claude-opus-4-6'], empty: [] }
    expect(canRewriteSubrouterModel({ modelId: 'subrouter/max', rotations })).toBe(true)
    expect(canRewriteSubrouterModel({ modelId: 'subrouter/empty', rotations })).toBe(false)
    expect(canRewriteSubrouterModel({ modelId: 'subrouter/missing', rotations })).toBe(false)
    expect(canRewriteSubrouterModel({ modelId: 'roadie/max', rotations })).toBe(false)
    expect(canRewriteSubrouterModel({ modelId: 'anthropic/claude-opus-4-6', rotations })).toBe(false)
  })
})
