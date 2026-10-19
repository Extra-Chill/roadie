// Message intake with a slow identity lookup (#308): once the cached person
// expires, a thread message from a person last resolved as allowed is accepted
// at once while the `person` filter refreshes them in the background.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import { ChannelType, type Client } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import { closeDb } from './db.js'
import { initDatabase, setChannelDirectory, setThreadSession } from './database.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { addFilter, resetHooks } from './hooks.js'
import { clearIdentityCache, resolvePerson, type Capability, type Person } from './identity.js'
import { startDiscordBot } from './discord-bot.js'
import { createDiscordJsClient } from './queue-advanced-e2e-setup.js'
import { disposeRuntime } from './session-handler/runtime-registry.js'
import { ThreadSessionRuntime } from './session-handler/thread-session-runtime.js'

const userId = '100000000000000655'
const guildId = '100000000000000611'
const channelId = '100000000000000633'
const threadId = '100000000000000634'

let directory: string
let discord: DigitalDiscord
let client: Client
let enqueueIncoming: MockInstance<ThreadSessionRuntime['enqueueIncoming']>

const allowed: Person = { allowed: true, personId: 'wp:1', capabilities: new Set<Capability>(['sessions']), permissions: [] }

beforeEach(async () => {
  // Record what reaches the session without running an agent.
  enqueueIncoming = vi.spyOn(ThreadSessionRuntime.prototype, 'enqueueIncoming')
    .mockResolvedValue({ queued: false })
  const root = path.resolve('tmp/identity-stale-intake')
  fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'run-'))
  setDataDir(directory)
  setChannelsConfigPath(null)
  await closeDb()
  await initDatabase()
  await setChannelDirectory({ channelId, directory, channelType: 'text', guildId })
  await setThreadSession(threadId, 'ses-stale-intake')
  discord = new DigitalDiscord({
    dbUrl: `file:${path.join(directory, 'discord.db')}`,
    users: [{ id: userId, username: 'speaker' }],
    guilds: [{ id: guildId, name: 'Served', ownerId: userId, channels: [
      { id: channelId, name: 'project', type: ChannelType.GuildText },
      { id: threadId, name: 'session', type: ChannelType.PublicThread, parentId: channelId },
    ] }],
  })
  await discord.start()
  client = createDiscordJsClient({ restUrl: discord.restUrl })
  await startDiscordBot({ token: discord.botToken, appId: discord.botUserId, discordClient: client })
})

afterEach(async () => {
  vi.restoreAllMocks()
  disposeRuntime(threadId)
  resetHooks()
  clearIdentityCache({ platform: 'discord', id: userId })
  setChannelsConfigPath(undefined)
  await client?.destroy()
  await discord?.stop()
  await closeDb()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('a thread message after cache expiry is accepted while the person lookup is still running', async () => {
  const removeFast = addFilter('person', () => allowed)
  await resolvePerson({ actor: { platform: 'discord', id: userId }, context: { guildId } })
  removeFast()

  // The refresh blocks until the test releases it.
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const lookups = { started: 0, done: 0 }
  addFilter('person', async () => {
    lookups.started++
    await gate
    lookups.done++
    return allowed
  })
  // The cached entry has expired; only the last successful lookup is left.
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 301_000)

  await discord.thread(threadId).user(userId).sendMessage({ content: 'still there?' })

  await vi.waitFor(() => {
    expect(enqueueIncoming).toHaveBeenCalledWith(expect.objectContaining({ userId, sourceThreadId: threadId }))
  }, { timeout: 5_000 })
  expect(lookups).toEqual({ started: 1, done: 0 })

  release()
  await vi.waitFor(() => expect(lookups.done).toBe(1))
}, 20_000)
