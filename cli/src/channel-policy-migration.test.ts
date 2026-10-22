import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { closeDb, getDb } from './db.js'
import { getDataDir } from './config.js'
import { resolveChannelPolicy, setChannelsConfigPath } from './channel-policy.js'

const migrated = path.join(getDataDir(), 'channel-policies.json')
afterEach(async () => {
  await closeDb()
  setChannelsConfigPath(null)
  fs.rmSync(migrated, { force: true })
})

async function legacyRows() {
  const db = await getDb()
  await db.run("CREATE TABLE channel_mention_mode (channel_id TEXT PRIMARY KEY, enabled INTEGER)")
  await db.run("INSERT INTO channel_mention_mode VALUES ('mention-channel', 1), ('always-channel', 0)")
  await closeDb()
}

test('legacy toggle rows migrate once into canonical policies without a host file', async () => {
  setChannelsConfigPath(null)
  await legacyRows()
  // undefined selects the environment/fallback path, unlike explicit null.
  const previous = process.env.ROADIE_CHANNELS_CONFIG
  delete process.env.ROADIE_CHANNELS_CONFIG
  setChannelsConfigPath(undefined)
  try {
    const db = await getDb()
    expect(resolveChannelPolicy('mention-channel')).toMatchObject({ respond: 'mention', threads: 'per-message' })
    expect(resolveChannelPolicy('always-channel')).toMatchObject({ respond: 'always', threads: 'per-message' })
    expect((await db.all("SELECT name FROM sqlite_master WHERE name = 'channel_mention_mode'"))).toEqual([])
    const contents = fs.readFileSync(migrated, 'utf8')
    await closeDb()
    await getDb()
    expect(fs.readFileSync(migrated, 'utf8')).toBe(contents)
  } finally {
    if (previous === undefined) delete process.env.ROADIE_CHANNELS_CONFIG
    else process.env.ROADIE_CHANNELS_CONFIG = previous
  }
})

test('host policy takes precedence and legacy rows are dropped without changing it', async () => {
  setChannelsConfigPath(null)
  await legacyRows()
  const file = path.join(getDataDir(), 'host-channels.json')
  const contents = JSON.stringify({ channels: { 'mention-channel': { respond: 'always', threads: 'none' } } })
  fs.writeFileSync(file, contents)
  setChannelsConfigPath(file)
  const db = await getDb()
  expect(fs.existsSync(migrated)).toBe(false)
  expect(fs.readFileSync(file, 'utf8')).toBe(contents)
  expect(resolveChannelPolicy('mention-channel')?.respond).toBe('always')
  expect((await db.all("SELECT name FROM sqlite_master WHERE name = 'channel_mention_mode'"))).toEqual([])
})
