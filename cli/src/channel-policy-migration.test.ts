import { afterEach, expect, test } from 'vitest'
import { closeDb, getDb } from './db.js'

afterEach(async () => {
  await closeDb()
})

test('the retired per-channel mention toggle table is dropped on startup', async () => {
  const db = await getDb()
  await db.run('CREATE TABLE IF NOT EXISTS channel_mention_mode (channel_id TEXT PRIMARY KEY, enabled INTEGER)')
  await db.run("INSERT INTO channel_mention_mode VALUES ('mention-channel', 1)")
  await closeDb()
  const reopened = await getDb()
  expect(await reopened.all("SELECT name FROM sqlite_master WHERE name = 'channel_mention_mode'")).toEqual([])
})
