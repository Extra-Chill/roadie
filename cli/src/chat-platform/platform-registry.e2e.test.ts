// Chat platform registry e2e (#297): a plugin-registered platform and Discord
// run in one process through the registry, against the real Pi backend driven
// by the scripted model server. Sessions, intake, and the database are shared;
// each platform keeps its own namespaced thread ids.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ChannelType, type Client } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from '../config.js'
import { setChannelsConfigPath } from '../channel-policy.js'
import {
  closeDatabase,
  getSessionTurnAttribution,
  getThreadSession,
  setBotToken,
  setChannelDirectory,
} from '../database.js'
import { stopHranaServer } from '../hrana-server.js'
import { chooseLockPort, initTestGitRepo } from '../test-utils.js'
import { disposeGlobalEventListener } from '../session-handler/global-event-listener.js'
import { disposeRuntime } from '../session-handler/runtime-registry.js'
import { findPi } from '../agent-backend/pi/find-pi.js'
import { startPiTestBackend, type PiTestBackend } from '../pi-test-backend.js'
import { addFilter } from '../hooks.js'
import { loadPlugins } from '../plugins.js'
import { store } from '../store.js'
import { createDiscordJsClient } from '../queue-advanced-e2e-setup.js'
import { startDiscordBot } from '../discord-bot.js'
import { createTestChatPlatform } from './test-chat-platform.js'
import { registerChatPlatform, resetChatPlatforms } from './registry.js'
import { runChatPlatforms } from './run-platforms.js'
import type { FakeMatcher } from '../agent-backend/pi/fake-model-server.js'

const answerMatcher = (id: string, marker: string, answer: string): FakeMatcher => ({
  id,
  priority: 100,
  when: { latestUserTextIncludes: marker, rawPromptIncludes: 'PLATFORM_SHARED_CONTEXT' },
  then: {
    parts: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: answer },
      { type: 'text-end', id },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ],
  },
})

describe.skipIf(!findPi())('chat platform registry', () => {
  const hostChannelId = 'HOSTCH1'
  const discordChannelId = '300000000000000401'
  const aliceId = '300000000000000402'
  const platform = createTestChatPlatform({ id: 'host-chat', spaceId: 'HOSTSPACE' })
  let root: string
  let project: string
  let pi: PiTestBackend | undefined
  let discord: DigitalDiscord
  let client: Client
  let discordThreadId = ''
  let stopPlatforms: (() => Promise<void>) | undefined
  let hranaUrl = ''
  let removeContext: (() => boolean) | undefined
  let previousAllowAllUsers: boolean

  beforeAll(async () => {
    previousAllowAllUsers = store.getState().allowAllUsers
    store.setState({ allowAllUsers: true })
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-platform-registry-'))
    project = path.join(root, 'project')
    fs.mkdirSync(project)
    initTestGitRepo(project)
    process.env.ROADIE_LOCK_PORT = String(chooseLockPort({ key: `platform-registry-e2e:${root}` }))
    setDataDir(path.join(root, 'data'))
    const config = path.join(root, 'channels.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        projects: { shared: { directory: project } },
        channels: {
          [hostChannelId]: { project: 'shared', who: 'everyone', respond: 'always' },
          [discordChannelId]: { project: 'shared', who: 'everyone', respond: 'always' },
        },
      }),
    )
    setChannelsConfigPath(config)
    removeContext = addFilter('context_sections', (sections) => [
      ...sections,
      { id: 'shared-brain', content: 'PLATFORM_SHARED_CONTEXT' },
    ])
    pi = await startPiTestBackend({
      root,
      dataDir: path.join(root, 'data'),
      matchers: [
        answerMatcher('host-answer', 'HOST_PLATFORM', 'host platform answer'),
        answerMatcher('discord-answer', 'DISCORD_DUAL', 'discord dual answer'),
      ],
    })

    // The host platform arrives through the plugin API, exactly as a
    // host-supplied platform would: register(roadie) → registerChatPlatform.
    const pluginPath = path.join(root, 'host-chat-plugin.mjs')
    fs.writeFileSync(
      pluginPath,
      'export function register(roadie) { roadie.registerChatPlatform(globalThis.__roadieHostChatDefinition) }\n',
    )
    ;(globalThis as Record<string, unknown>).__roadieHostChatDefinition = platform.definition
    const loaded = await loadPlugins([pluginPath])
    if (loaded instanceof Error) throw loaded

    // Discord goes through the same registry, backed by the digital twin
    // (the full `roadie` onboarding flow is not part of this suite).
    const registered = registerChatPlatform({
      id: 'discord',
      start: async () => {
        discord = new DigitalDiscord({
          guild: { name: 'Registry', ownerId: aliceId },
          channels: [{ id: discordChannelId, name: 'shared', type: ChannelType.GuildText }],
          users: [{ id: aliceId, username: 'alice' }],
          dbUrl: `file:${path.join(root, 'discord.db')}`,
        })
        await discord.start()
        await setBotToken(discord.botUserId, discord.botToken)
        await setChannelDirectory({
          channelId: discordChannelId,
          directory: project,
          channelType: 'text',
          guildId: discord.guildId,
        })
        client = createDiscordJsClient({ restUrl: discord.restUrl })
        await startDiscordBot({
          token: discord.botToken,
          appId: discord.botUserId,
          discordClient: client,
        })
        return {
          stop: async () => {
            if (discordThreadId) disposeRuntime(discordThreadId)
            await client?.destroy()
            await discord?.stop()
          },
        }
      },
    })
    if (registered instanceof Error) throw registered

    const started = await runChatPlatforms({
      platformIds: ['discord', 'host-chat'],
      options: {},
    })
    if (started instanceof Error) throw started
    hranaUrl = started.url
    process.env.ROADIE_DB_URL = started.url
    stopPlatforms = started.stop
  }, 60_000)

  afterAll(async () => {
    await stopPlatforms?.()
    disposeGlobalEventListener()
    await pi?.dispose()
    await closeDatabase()
    await stopHranaServer()
    resetChatPlatforms()
    removeContext?.()
    setChannelsConfigPath(null)
    store.setState({ allowAllUsers: previousAllowAllUsers })
    delete process.env.ROADIE_DB_URL
    delete (globalThis as Record<string, unknown>).__roadieHostChatDefinition
  }, 20_000)

  test('a plugin platform receives a message, runs a session and gets parts back', async () => {
    const delivered = await platform.deliverMessage({
      channelId: hostChannelId,
      threadKey: 'root-1',
      text: 'HOST_PLATFORM hello',
      userId: 'UHOST1',
      username: 'Host person',
    })
    if (delivered instanceof Error) throw delivered
    expect(delivered.threadId).toBe('host-chat:HOSTSPACE:HOSTCH1:root-1')
    await delivered.thread.waitForMessage({
      predicate: (message) => message.kind === 'part' && message.text.includes('host platform answer'),
    })
    const sessionId = await getThreadSession(delivered.threadId)
    expect(sessionId).toBeTruthy()
    // Identity is shared and platform-tagged: the actor carries the plugin
    // platform's id, not a vendor name baked into the core.
    const attribution = await getSessionTurnAttribution(sessionId!)
    expect(attribution?.actor?.platform).toBe('host-chat')
    expect(attribution?.actor?.id).toBe('UHOST1')

    // A follow-up in the same conversation continues the same session.
    const followUp = await platform.deliverMessage({
      channelId: hostChannelId,
      threadKey: 'root-1',
      text: 'HOST_PLATFORM again',
      userId: 'UHOST1',
    })
    if (followUp instanceof Error) throw followUp
    await followUp.thread.waitForMessage({
      predicate: (message) =>
        message.kind === 'part' &&
        message.text.includes('host platform answer') &&
        followUp.thread.messages.filter((entry) => entry.text.includes('host platform answer'))
          .length >= 2,
    })
    expect(await getThreadSession(delivered.threadId)).toBe(sessionId)
  }, 30_000)

  test('discord runs in the same process through the registry', async () => {
    await discord.channel(discordChannelId).user(aliceId).sendMessage({ content: 'DISCORD_DUAL hello' })
    const thread = await discord.channel(discordChannelId).waitForThread({
      timeout: 15_000,
      predicate: (candidate) => Boolean(candidate.name?.includes('DISCORD_DUAL')),
    })
    discordThreadId = thread.id
    await discord.thread(thread.id).waitForMessage({
      timeout: 15_000,
      predicate: (message) => message.content.includes('discord dual answer'),
    })
    const discordSession = await getThreadSession(thread.id)
    expect(discordSession).toBeTruthy()
    // Both platforms share one database but never one thread namespace.
    expect(await getThreadSession('host-chat:HOSTSPACE:HOSTCH1:root-1')).not.toBe(discordSession)
  }, 30_000)

  test('/health reports every ready platform', async () => {
    const response = await fetch(new URL('/health', hranaUrl))
    const health = (await response.json()) as { chatPlatforms: string[]; chatReady: boolean }
    expect(health.chatReady).toBe(true)
    expect([...health.chatPlatforms].sort()).toEqual(['discord', 'host-chat'])
  }, 10_000)
})
