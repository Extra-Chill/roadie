import { afterEach, expect, test } from 'vitest'
import { closeDb, getDb } from './db.js'

afterEach(async () => {
  await closeDb()
})

test('retired worktree tables are dropped on startup', async () => {
  const db = await getDb()
  for (const table of ['thread_worktrees', 'channel_worktrees']) {
    await db.run(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY)`)
  }
  await closeDb()
  const reopened = await getDb()
  expect(await reopened.all("SELECT name FROM sqlite_master WHERE name IN ('thread_worktrees', 'channel_worktrees')")).toEqual([])
})
