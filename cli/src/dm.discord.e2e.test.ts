// Inbound DMs on the real Discord adapter, digital twin and scripted Pi.
// Opt-in and audience checks precede the rolling inline conversation.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ChannelType, type Client } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { startDiscordBot } from './discord-bot.js'
import { createDiscordJsClient } from './queue-advanced-e2e-setup.js'
import { setDataDir } from './config.js'
import { setChannelsConfigPath } from './channel-policy.js'
import {
  initDatabase,
  closeDatabase,
  setBotToken,
  getThreadSession,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { disposeGlobalEventListener } from './session-handler/global-event-listener.js'
import { disposeRuntime } from './session-handler/runtime-registry.js'
import { getAgentBackendProvider } from './agent-backend/registry.js'
import { initTestGitRepo, chooseLockPort } from './test-utils.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { startPiTestBackend, type PiTestBackend } from './pi-test-backend.js'
import { store } from './store.js'

const alice = '200000000000003101'
const bob = '200000000000003102'
const channelId = '200000000000003106'

let root: string
let project: string
let pi: PiTestBackend | undefined
let discord: DigitalDiscord
let client: Client
let previousAllowAllUsers: boolean
let config: string
function policy(enabled: boolean) {
  fs.writeFileSync(config, JSON.stringify({ channels: { "*": { respond: "never" } },
    ...(enabled ? { dm: { directory: project, who: [`user:${alice}`], respond: "always" } } : {}),
  }))
  setChannelsConfigPath(config)
}

describe.skipIf(!findPi())('inbound DMs on Discord', () => {
  beforeAll(async () => {
    previousAllowAllUsers = store.getState().allowAllUsers
    store.setState({ allowAllUsers: true })
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-dm-'))
    project = path.join(root, 'project')
    fs.mkdirSync(project)
    initTestGitRepo(project)
    setDataDir(path.join(root, 'data'))
    process.env.ROADIE_LOCK_PORT = String(chooseLockPort({ key: 'dm-discord' }))
    config = path.join(root, 'channels.json')
    policy(false)
    pi = await startPiTestBackend({
      root,
      dataDir: path.join(root, 'data'),
      matchers: [
        {
          id: 'inline-answer',
          priority: 150,
          when: { latestUserTextIncludes: 'INLINE_ANSWER' },
          then: {
            parts: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'reply' },
              { type: 'text-delta', id: 'reply', delta: 'inline-answer' },
              { type: 'text-end', id: 'reply' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          },
        },
      ],
    })
    const hrana = await startHranaServer({ dbPath: path.join(root, 'data/discord-sessions.db') })
    if (hrana instanceof Error) throw hrana
    process.env.ROADIE_DB_URL = hrana
    await initDatabase()
    discord = new DigitalDiscord({
      guild: { name: 'Inline', ownerId: alice },
      channels: [],
      users: [
        { id: alice, username: 'alice' },
        { id: bob, username: 'bob' },
      ],
      dbUrl: `file:${path.join(root, 'discord.db')}`,
    })
    await discord.start()
    await setBotToken(discord.botUserId, discord.botToken)
    await discord.prisma.channel.create({ data: { id: channelId, type: ChannelType.DM } })
    client = createDiscordJsClient({ restUrl: discord.restUrl })
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: client,
    })
  }, 60_000)

  afterAll(async () => {
    disposeRuntime(channelId)
    await client?.destroy()
    disposeGlobalEventListener()
    await pi?.dispose()
    await closeDatabase()
    await stopHranaServer()
    await discord?.stop()
    setChannelsConfigPath(null)
    store.setState({ allowAllUsers: previousAllowAllUsers })
    delete process.env.ROADIE_DB_URL
  }, 20_000)

  async function wait(check: () => Promise<boolean>) {
    for (let i = 0; i < 150; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('DM scenario timed out')
  }

  async function answerTo(messageId: string) {
    const messages = await discord.channel(channelId).getMessages()
    return messages.find(
      (message) =>
        message.author.id === discord.botUserId &&
        message.content.includes('inline-answer') &&
        message.message_reference?.message_id === messageId,
    )
  }

  test('DM opt-in, audience and continuity on the real adapter', async () => {
    const send = (actor: string, content: string) =>
      discord.channel(channelId).user(actor).sendMessage({ content })

    await send(alice, 'INLINE_ANSWER without DM policy')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(
      (await discord.channel(channelId).getMessages()).filter(
        (m) => m.author.id === discord.botUserId,
      ),
    ).toHaveLength(0)

    policy(true)
    await send(bob, 'INLINE_ANSWER denied')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await getThreadSession(channelId)).toBeFalsy()
    const first = await send(alice, 'INLINE_ANSWER first')
    await wait(async () => Boolean(await answerTo(first.id)))
    const sessionId = await getThreadSession(channelId)
    expect(sessionId).toBeTruthy()

    const second = await send(alice, 'INLINE_ANSWER second')
    await wait(async () => Boolean(await answerTo(second.id)))

    // Inline: no thread was ever created, and both turns share the session.
    expect(await discord.channel(channelId).getThreads()).toHaveLength(0)
    expect(await getThreadSession(channelId)).toBe(sessionId)

    const backend = await getAgentBackendProvider().initializeForDirectory(project)
    if (backend instanceof Error) throw backend
    const history = await backend().sessions.messages({ sessionId: sessionId!, directory: project })
    if (history instanceof Error) throw history
    const userTexts = history
      .filter((entry) => entry.message.role === 'user')
      .flatMap((entry) => entry.parts)
      .filter((part) => part.kind === 'text' && !part.synthetic)
      .map((part) => (part.kind === 'text' ? part.text : ''))
      .join('\n')
    expect(userTexts).toContain('INLINE_ANSWER first')
    expect(userTexts).toContain('INLINE_ANSWER second')
    expect(userTexts).not.toContain('without DM policy')
    expect(userTexts).not.toContain('denied')
    await send(alice, '/new')
    await wait(async () => !(await getThreadSession(channelId)))
    const third = await send(alice, 'INLINE_ANSWER after reset')
    await wait(async () => Boolean(await answerTo(third.id)))
    expect(await getThreadSession(channelId)).not.toBe(sessionId)
    await send(alice, '/abort')
    await wait(async () => (await discord.channel(channelId).getMessages()).some(m =>
      m.author.id === discord.botUserId && m.content === 'Request aborted.'))
  }, 60_000)
})
