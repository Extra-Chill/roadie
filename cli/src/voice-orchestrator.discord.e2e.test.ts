// Voice bridge e2e: a deterministic VoiceProvider stands in for Gemini Live
// (it calls tell_orchestrator and records announcements); everything else is
// real: the Discord twin, the bot's intake, channel policy and a Pi runtime
// against the scripted model server.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChannelType, type Client } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { findPi } from './agent-backend/pi/find-pi.js'
import { getActiveDiscordIntake, startDiscordBot } from './discord-bot.js'
import { createDiscordJsClient } from './queue-advanced-e2e-setup.js'
import { setDataDir } from './config.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { closeDatabase, initDatabase, setBotToken, setChannelDirectory } from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { disposeGlobalEventListener } from './session-handler/global-event-listener.js'
import { disposeRuntime } from './session-handler/runtime-registry.js'
import { addFilter } from './hooks.js'
import type { ConversationIntakeRequest } from './conversation-intake.js'
import { chooseLockPort, initTestGitRepo } from './test-utils.js'
import { startPiTestBackend, type PiTestBackend } from './pi-test-backend.js'
import type { FakeMatcher } from './agent-backend/pi/fake-model-server.js'
import { store } from './store.js'
import { speakIntoThread, startVoiceBridge, type VoiceBridge } from './voice-bridge.js'
import type { VoiceProvider } from './voice-provider.js'

const ALICE = '200000000000001601'
const BOB = '200000000000001602'
const ORCHESTRATOR_CHANNEL = '200000000000001603'
const PROJECT_CHANNEL = '200000000000001604'
const VOICE_CHANNEL = '200000000000001605'

function reply(id: string, text: string): FakeMatcher['then'] {
  return {
    parts: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: text },
      { type: 'text-end', id },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ],
  }
}

async function wait(check: () => Promise<boolean> | boolean, label: string) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

let root: string
let pi: PiTestBackend | undefined
let discord: DigitalDiscord
let client: Client
let previousAllowAllUsers: boolean
let removeIntake: (() => boolean) | undefined
const intakeRequests: ConversationIntakeRequest[] = []
const threads: string[] = []

beforeAll(async () => {
  if (!findPi()) return
  previousAllowAllUsers = store.getState().allowAllUsers
  store.setState({ allowAllUsers: true })
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-voice-'))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  initTestGitRepo(project)
  setDataDir(path.join(root, 'data'))
  process.env.ROADIE_LOCK_PORT = String(chooseLockPort({ key: 'voice-orchestrator' }))
  const who = [`user:${ALICE}`]
  const config = path.join(root, 'channels.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      channels: {
        [VOICE_CHANNEL]: { voice: { channel: ORCHESTRATOR_CHANNEL }, who },
        [ORCHESTRATOR_CHANNEL]: { respond: 'mention', who },
        [PROJECT_CHANNEL]: { respond: 'mention', who },
      },
    }),
  )
  setChannelsConfigPath(config)
  removeIntake = addFilter('conversation_intake', (decision, { request }) => {
    intakeRequests.push(request)
    return decision
  })
  pi = await startPiTestBackend({
    root,
    dataDir: path.join(root, 'data'),
    matchers: [
      {
        id: 'voice-orchestrator',
        priority: 150,
        // Answers only when the voice-mode guidance is in the session prompt.
        when: { latestUserTextIncludes: 'VOICE_PLAN', rawPromptIncludes: 'Voice orchestrator mode' },
        then: reply('orchestrator', 'On it, I sent the fix to the project thread.'),
      },
      {
        id: 'voice-work',
        priority: 150,
        when: { latestUserTextIncludes: 'VOICE_WORK' },
        then: reply('work', 'Work finished cleanly. All tests pass.'),
      },
    ],
  })
  const hrana = await startHranaServer({ dbPath: path.join(root, 'data/discord-sessions.db') })
  if (hrana instanceof Error) throw hrana
  process.env.ROADIE_DB_URL = hrana
  await initDatabase()
  discord = new DigitalDiscord({
    guild: { name: 'Voice', ownerId: ALICE },
    channels: [
      { id: ORCHESTRATOR_CHANNEL, name: 'orchestrator', type: ChannelType.GuildText },
      { id: PROJECT_CHANNEL, name: 'project', type: ChannelType.GuildText },
    ],
    users: [
      { id: ALICE, username: 'alice' },
      { id: BOB, username: 'bob' },
    ],
    dbUrl: `file:${path.join(root, 'discord.db')}`,
  })
  await discord.start()
  await setBotToken(discord.botUserId, discord.botToken)
  for (const channelId of [ORCHESTRATOR_CHANNEL, PROJECT_CHANNEL])
    await setChannelDirectory({ channelId, directory: project, channelType: 'text', guildId: discord.guildId })
  client = createDiscordJsClient({ restUrl: discord.restUrl })
  await startDiscordBot({ token: discord.botToken, appId: discord.botUserId, discordClient: client })
}, 60_000)

afterAll(async () => {
  if (!findPi()) return
  for (const threadId of threads) disposeRuntime(threadId)
  await client?.destroy()
  disposeGlobalEventListener()
  await pi?.dispose()
  await closeDatabase()
  await stopHranaServer()
  await discord?.stop()
  removeIntake?.()
  setChannelsConfigPath(null)
  store.setState({ allowAllUsers: previousAllowAllUsers })
  delete process.env.ROADIE_DB_URL
}, 20_000)

test.skipIf(!findPi())(
  'voice drives one orchestrator thread through normal intake and announces replies',
  async () => {
    const guild = client.guilds.cache.get(discord.guildId)!
    const alice = await guild.members.fetch(ALICE)
    const bob = await guild.members.fetch(BOB)
    const intake = getActiveDiscordIntake()!
    expect(intake).toBeTruthy()

    const announcements: string[] = []
    let tell: ((text: string) => Promise<string>) | undefined
    const provider: VoiceProvider = {
      async connect(options) {
        tell = options.tellOrchestrator
        return { audio() {}, announce: (text) => announcements.push(text), close() {} }
      },
    }
    const audio = { output() {}, interrupted() {}, completed() {}, failed() {} }
    const open = (member: typeof alice) =>
      startVoiceBridge({ client, member, voiceChannelId: VOICE_CHANNEL, intake, provider, key: 'test', audio })

    // An unauthorized speaker cannot open a voice session.
    expect(await open(bob)).toBeUndefined()
    expect(await discord.channel(ORCHESTRATOR_CHANNEL).getThreads()).toHaveLength(0)

    const bridge: VoiceBridge = (await open(alice))!
    try {
      const thread = bridge.thread
      threads.push(thread.id)
      expect(thread.parentId).toBe(ORCHESTRATOR_CHANNEL)
      expect(thread.name.startsWith('🎙️ Voice — ')).toBe(true)
      const orchestratorMessages = () => discord.thread(thread.id).getMessages()

      // The speaker's words land in the thread and start a normal turn as them.
      expect(await tell!('VOICE_PLAN fix the login bug')).toContain('Delivered')
      await wait(() => announcements.some((text) => text.startsWith('Orchestrator: On it')), 'orchestrator reply')
      const messages = await orchestratorMessages()
      expect(messages.some((message) => message.content === '🎙️ **alice:** VOICE_PLAN fix the login bug')).toBe(true)
      expect(
        intakeRequests.some((request) => request.actor.id === ALICE && request.threadId === thread.id),
      ).toBe(true)

      // Bob's words go through the same intake and are refused by channel policy.
      await speakIntoThread({ thread, member: bob, text: 'VOICE_PLAN bob words', intake })
      expect(intakeRequests.some((request) => request.actor.id === BOB)).toBe(false)

      // Another thread finishing a turn is spoken, never posted to the orchestrator.
      const before = (await orchestratorMessages()).length
      await discord
        .channel(PROJECT_CHANNEL)
        .user(ALICE)
        .sendMessage({ content: `<@${discord.botUserId}> VOICE_WORK build it` })
      const work = await discord.channel(PROJECT_CHANNEL).waitForThread({
        timeout: 10_000,
        predicate: (candidate) => candidate.name?.includes('VOICE_WORK') ?? false,
      })
      threads.push(work.id)
      await wait(() => announcements.some((text) => text.includes('Work finished cleanly.')), 'thread announcement')
      const announced = announcements.find((text) => text.includes('Work finished cleanly.'))!
      expect(announced).toContain('project')
      expect(announced).not.toContain('All tests pass')
      expect((await orchestratorMessages()).length).toBe(before)
      expect(pi!.modelServer.bodies.join('\n')).not.toContain('bob words')
    } finally {
      bridge.close()
    }
  },
  60_000,
)
