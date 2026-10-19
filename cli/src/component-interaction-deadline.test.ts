// Component interactions must meet Discord's three-second initial response
// deadline even when the identity lookup is slow (#306). The listener defers
// buttons before resolvePerson(); for modal openers resolvePerson() answers
// from the last known person instead of awaiting the lookup.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags, type ThreadChannel } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import { closeDb } from './db.js'
import { initDatabase, setChannelDirectory, setThreadSession } from './database.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { addFilter, resetHooks } from './hooks.js'
import { clearIdentityCache, resolvePerson, type Capability, type Person } from './identity.js'
import { registerInteractionHandler } from './interaction-handler.js'
import { pendingActionButtonContexts, showActionButtons } from './commands/action-buttons.js'
import { cancelPendingFileUpload, pendingFileUploadContexts, showFileUploadButton } from './commands/file-upload.js'
import { disposeRuntime } from './session-handler/runtime-registry.js'
import { ThreadSessionRuntime } from './session-handler/thread-session-runtime.js'

const userId = '100000000000000555'
const guildId = '100000000000000111'
const channelId = '100000000000000333'
const threadId = '100000000000000334'
const sessionId = 'ses-deadline'
// Longer than Discord's three-second initial response deadline.
const SLOW_LOOKUP_MS = 3_500

let directory: string
let discord: DigitalDiscord
let client: Client
let enqueueIncoming: MockInstance<ThreadSessionRuntime['enqueueIncoming']>

const allowed: Person = { allowed: true, capabilities: new Set<Capability>(['sessions']), permissions: [] }
const denied: Person = { allowed: false, capabilities: new Set<Capability>(), permissions: [] }

/** A `person` filter slower than the deadline; counts started and finished lookups. */
function slowPersonFilter(person: Person) {
  const lookups = { started: 0, done: 0 }
  addFilter('person', async () => {
    lookups.started++
    await new Promise((resolve) => setTimeout(resolve, SLOW_LOOKUP_MS))
    lookups.done++
    return person
  })
  return lookups
}

beforeEach(async () => {
  // Record what reaches the session without running an agent.
  enqueueIncoming = vi.spyOn(ThreadSessionRuntime.prototype, 'enqueueIncoming')
    .mockResolvedValue({ queued: false })
  const root = path.resolve('tmp/component-interaction-deadline')
  fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'run-'))
  setDataDir(directory)
  setChannelsConfigPath(null)
  await closeDb()
  await initDatabase()
  await setChannelDirectory({ channelId, directory, channelType: 'text' })
  await setThreadSession(threadId, sessionId)
  discord = new DigitalDiscord({
    dbUrl: `file:${path.join(directory, 'discord.db')}`,
    users: [{ id: userId, username: 'clicker' }],
    guilds: [{ id: guildId, name: 'Served', ownerId: userId, channels: [
      { id: channelId, name: 'project', type: ChannelType.GuildText },
      { id: threadId, name: 'session', type: ChannelType.PublicThread, parentId: channelId },
    ] }],
  })
  await discord.start()
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { api: discord.restUrl, version: '10' },
  })
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()))
  await client.login(discord.botToken)
  await ready
  registerInteractionHandler({ discordClient: client, appId: discord.botUserId })
})

afterEach(async () => {
  vi.restoreAllMocks()
  disposeRuntime(threadId)
  await cancelPendingFileUpload(threadId)
  for (const context of pendingActionButtonContexts.values()) clearTimeout(context.timer)
  pendingActionButtonContexts.clear()
  resetHooks()
  // Also forgets an in-flight lookup, so no test inherits another's person.
  clearIdentityCache({ platform: 'discord', id: userId })
  setChannelsConfigPath(undefined)
  await client?.destroy()
  await discord?.stop()
  await closeDb()
  fs.rmSync(directory, { recursive: true, force: true })
})

async function fetchThread(): Promise<ThreadChannel> {
  const thread = await client.channels.fetch(threadId)
  if (!thread?.isThread()) throw new Error('expected a thread')
  return thread
}

async function clickActionButton(label: string): Promise<string> {
  await showActionButtons({ thread: await fetchThread(), sessionId, directory, buttons: [{ label }] })
  const [contextHash, context] = [...pendingActionButtonContexts.entries()][0]!
  const { id } = await discord.thread(threadId).user(userId).clickButton({
    messageId: context.messageId!,
    customId: `action_button:${contextHash}:0`,
  })
  return id
}

describe('component interactions with a slow identity lookup', () => {
  test('an action button is acknowledged before the lookup finishes and its click is enqueued', async () => {
    const lookups = slowPersonFilter(allowed)
    const interactionId = await clickActionButton('Ship it')

    const ack = await discord.thread(threadId).waitForInteractionAck({ interactionId, timeout: 3_000 })
    expect(lookups.done).toBe(0)
    expect(ack.type).toBe(6) // DeferredMessageUpdate

    await vi.waitFor(() => {
      expect(enqueueIncoming).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'User clicked: Ship it' }))
    }, { timeout: 10_000 })
  }, 20_000)

  test('a denied person gets the permission message privately and nothing is enqueued', async () => {
    const lookups = slowPersonFilter(denied)
    const interactionId = await clickActionButton('Ship it')

    await discord.thread(threadId).waitForInteractionAck({ interactionId, timeout: 3_000 })
    expect(lookups.done).toBe(0)

    let notice: { content: string; flags?: number } | undefined
    await vi.waitFor(async () => {
      const messages = await discord.thread(threadId).getMessages()
      notice = messages.find((message) => message.content.includes("You don't have permission to use this."))
      expect(notice).toBeDefined()
    }, { timeout: 10_000 })
    expect((notice!.flags ?? 0) & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral)
    expect(enqueueIncoming).not.toHaveBeenCalled()
    // The click was not consumed: the buttons stay pending.
    expect(pendingActionButtonContexts.size).toBe(1)
  }, 20_000)

  test('a modal button opens its modal from the last known person without awaiting the lookup', async () => {
    const actor = { platform: 'discord', id: userId }
    const removeFast = addFilter('person', () => allowed)
    await resolvePerson({ actor })
    removeFast()
    const lookups = slowPersonFilter(allowed)
    // The cached entry has expired; only the last successful lookup is left.
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 301_000)

    void showFileUploadButton({ thread: await fetchThread(), sessionId, directory, prompt: 'Upload logs', maxFiles: 1 })
    await vi.waitFor(() => {
      expect([...pendingFileUploadContexts.values()][0]?.messageId).toBeDefined()
    })
    const [contextHash, context] = [...pendingFileUploadContexts.entries()][0]!
    const { id: interactionId } = await discord.thread(threadId).user(userId).clickButton({
      messageId: context.messageId!,
      customId: `file_upload_btn:${contextHash}`,
    })

    const ack = await discord.thread(threadId).waitForInteractionAck({ interactionId, timeout: 3_000 })
    expect(ack.type).toBe(9) // Modal
    expect(lookups.done).toBe(0)
    // The stale person is refreshed in the background.
    expect(lookups.started).toBe(1)
  }, 20_000)
})
