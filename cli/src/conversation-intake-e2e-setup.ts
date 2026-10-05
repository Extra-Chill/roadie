// The same scenario drives both real adapter runtimes and the real
// deterministic backend. Assertions observe chat and backend history.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import { beforeAll, afterAll, expect } from 'vitest'
import { ChannelType, type Client } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { SlackDigitalTwin, sendSlashCommand } from 'slack-digital-twin/src'
import { buildDeterministicOpencodeConfig } from 'opencode-deterministic-provider'
import { NativeSlackBot } from './slack-bot.js'
import { startDiscordBot } from './discord-bot.js'
import { createDiscordJsClient, warmOpencodeInstance } from './queue-advanced-e2e-setup.js'
import { setDataDir } from './config.js'
import { setChannelsConfigPath } from './channel-policy.js'
import {
  initDatabase,
  closeDatabase,
  setChannelDirectory,
  setBotToken,
  getThreadSession,
  upsertSessionSleep,
  getSessionSleep,
  getSessionModel,
  getSessionTurnAttribution,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { stopOpencodeServer, initializeOpencodeForDirectory } from './opencode.js'
import { disposeGlobalEventListener } from './session-handler/global-event-listener.js'
import { disposeRuntime, getRuntime } from './session-handler/thread-session-runtime.js'
import { addFilter } from './hooks.js'
import type { ContextRequest } from './context-provider.js'
import { getAgentBackendProvider } from './agent-backend/registry.js'
import { readConversationAdmission } from './conversation-intake.js'
import { slackThreadId } from './chat-platform/slack-api.js'
import { initTestGitRepo, chooseLockPort, cleanupTestSessions } from './test-utils.js'
import { store } from './store.js'
import type { ConversationIntakeRequest } from './conversation-intake.js'

type Message = { id: string; text: string; bot: boolean }
type Platform = 'discord' | 'slack'

export function setupConversationIntakeSuite(platform: Platform) {
  const actors =
    platform === 'discord'
      ? {
          alice: '200000000000001101',
          bob: '200000000000001102',
          charlie: '200000000000001103',
          outsider: '200000000000001104',
        }
      : { alice: 'UALICE', bob: 'UBOB', charlie: 'UCHARLIE', outsider: 'UOUTSIDER' }
  const channelId = platform === 'discord' ? '200000000000001105' : 'CINTAKE'
  let root: string
  let project: string
  let startedAt: number
  let discord: DigitalDiscord
  let slack: SlackDigitalTwin
  let bot: NativeSlackBot
  let client: Client
  let botId: string
  let spaceId: string
  let threadId = ''
  let threadTs = ''
  let removeContext: () => boolean
  const contexts: ContextRequest[] = []
  const intakeRequests: ConversationIntakeRequest[] = []
  let removeIntake: () => boolean
  let previousAllowAllUsers: boolean

  beforeAll(async () => {
    startedAt = Date.now()
    previousAllowAllUsers = store.getState().allowAllUsers
    store.setState({ allowAllUsers: true })
    root = fs.mkdtempSync(path.join(os.tmpdir(), `roadie-intake-${platform}-`))
    project = path.join(root, 'project')
    fs.mkdirSync(project)
    initTestGitRepo(project)
    setDataDir(path.join(root, 'data'))
    process.env.ROADIE_LOCK_PORT = String(
      chooseLockPort({ key: `conversation-intake-${platform}` }),
    )
    const config = path.join(root, 'channels.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        projects: { shared: { directory: project, context: 'shared-brain' } },
        channels: {
          [channelId]: {
            project: 'shared',
            respond: 'mention',
            who: [`user:${actors.alice}`, `user:${actors.bob}`, `user:${actors.charlie}`],
            intake: {
              start: 'mention',
              continue: 'participants',
              join: 'mention',
              other: 'context',
            },
          },
        },
      }),
    )
    setChannelsConfigPath(config)
    removeIntake = addFilter('conversation_intake', (decision, { request }) => {
      intakeRequests.push(request)
      return decision
    })
    removeContext = addFilter('context_sections', (sections, request) => {
      contexts.push(request)
      return [
        ...sections,
        {
          id: request.event === 'session_start' ? 'shared' : 'speaker',
          content:
            request.event === 'session_start' ? 'INTAKE_SHARED' : `SPEAKER_${request.actor?.id}`,
        },
      ]
    })
    fs.writeFileSync(
      path.join(project, 'opencode.json'),
      JSON.stringify(
        buildDeterministicOpencodeConfig({
          providerName: 'deterministic-provider',
          model: 'deterministic-v2',
          smallModel: 'deterministic-v3',
          providerNpm: url
            .pathToFileURL(path.resolve('..', 'opencode-deterministic-provider/src/index.ts'))
            .toString(),
          settings: {
            strict: false,
            matchers: [
              {
                id: 'intake-answer',
                priority: 150,
                when: {
                  latestUserTextIncludes: 'INTAKE_ANSWER',
                  rawPromptIncludes: 'INTAKE_SHARED',
                },
                then: {
                  parts: [
                    { type: 'stream-start', warnings: [] },
                    { type: 'text-start', id: 'reply' },
                    { type: 'text-delta', id: 'reply', delta: 'intake-answer' },
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
          },
        }),
      ),
    )
    const hrana = await startHranaServer({ dbPath: path.join(root, 'data/discord-sessions.db') })
    if (hrana instanceof Error) throw hrana
    process.env.ROADIE_DB_URL = hrana
    await initDatabase()
    if (platform === 'slack') {
      slack = new SlackDigitalTwin({
        workspaceId: 'TINTAKE',
        botUser: { id: 'UINTAKEBOT' },
        channels: [{ id: channelId, name: 'shared' }],
        users: Object.entries(actors).map(([name, id]) => ({ id, name })),
        dbUrl: `file:${path.join(root, 'slack.db')}`,
        webhookConfig: { signingSecret: 'intake-secret' },
      })
      await slack.start()
      botId = slack.botUserId
      spaceId = slack.workspaceId
      bot = new NativeSlackBot({
        token: slack.botToken,
        signingSecret: 'intake-secret',
        apiUrl: slack.apiUrl,
        workspaceId: spaceId,
      })
      const started = await bot.start()
      if (started instanceof Error) throw started
      slack.setWebhookUrl(`${bot.url}/slack/events`)
    } else {
      discord = new DigitalDiscord({
        guild: { name: 'Intake', ownerId: actors.alice },
        channels: [{ id: channelId, name: 'shared', type: ChannelType.GuildText }],
        users: Object.entries(actors).map(([username, id]) => ({ id, username })),
        dbUrl: `file:${path.join(root, 'discord.db')}`,
      })
      await discord.start()
      botId = discord.botUserId
      spaceId = discord.guildId
      await setBotToken(discord.botUserId, discord.botToken)
      await setChannelDirectory({
        channelId,
        directory: project,
        channelType: 'text',
        guildId: spaceId,
      })
      client = createDiscordJsClient({ restUrl: discord.restUrl })
      await startDiscordBot({
        token: discord.botToken,
        appId: discord.botUserId,
        discordClient: client,
      })
    }
    const backend = await initializeOpencodeForDirectory(project)
    if (backend instanceof Error) throw backend
    await warmOpencodeInstance({ getClient: backend, directory: project })
  }, 60_000)

  afterAll(async () => {
    if (platform === 'slack') await bot?.stop()
    else {
      if (threadId) disposeRuntime(threadId)
      await client?.destroy()
    }
    disposeGlobalEventListener()
    if (project) await cleanupTestSessions({ projectDirectory: project, testStartTime: startedAt })
    await stopOpencodeServer()
    await closeDatabase()
    await stopHranaServer()
    if (platform === 'slack') await slack?.stop()
    else await discord?.stop()
    removeContext?.()
    removeIntake?.()
    setChannelsConfigPath(null)
    store.setState({ allowAllUsers: previousAllowAllUsers })
    delete process.env.ROADIE_DB_URL
  }, 20_000)

  async function channelMessages(): Promise<Message[]> {
    return platform === 'slack'
      ? (await slack.channel(channelId).getMessages()).map((message) => ({
          id: message.ts!,
          text: message.text ?? '',
          bot: Boolean(message.bot_id),
        }))
      : (await discord.channel(channelId).getMessages()).map((message) => ({
          id: message.id,
          text: message.content,
          bot: message.author.id === botId,
        }))
  }
  async function threadMessages(): Promise<Message[]> {
    return platform === 'slack'
      ? (await slack.channel(channelId).getMessages())
          .filter((message) => message.thread_ts === threadTs)
          .map((message) => ({
            id: message.ts!,
            text: message.text ?? '',
            bot: Boolean(message.bot_id),
          }))
      : (await discord.thread(threadId).getMessages()).map((message) => ({
          id: message.id,
          text: message.content,
          bot: message.author.id === botId,
        }))
  }
  async function sendRoot(actor: string, text: string) {
    if (platform === 'slack')
      return (await slack.user(actor).sendMessage({ channel: channelId, text })).ts
    return (await discord.channel(channelId).user(actor).sendMessage({ content: text })).id
  }
  async function sendThread(actor: string, text: string) {
    if (platform === 'slack')
      return (await slack.user(actor).sendMessage({ channel: channelId, threadTs, text })).ts
    return (await discord.thread(threadId).user(actor).sendMessage({ content: text })).id
  }
  async function wait(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Intake scenario timed out on ${platform}`)
  }
  const answer = (message: Message) => message.bot && message.text.includes('intake-answer')
  async function waitReply(id: string) {
    await wait(async () =>
      (await threadMessages()).some((message) => message.id > id && answer(message)),
    )
  }
  async function history() {
    const sessionId = await getThreadSession(threadId)
    if (!sessionId) return []
    const backend = await getAgentBackendProvider().initializeForDirectory(project)
    if (backend instanceof Error) throw backend
    const messages = await backend().sessions.messages({ sessionId, directory: project })
    if (messages instanceof Error) throw messages
    return messages
  }

  return async function scenario() {
    await sendRoot(actors.alice, 'INTAKE_ANSWER unmentioned root')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect((await channelMessages()).filter((message) => message.bot)).toHaveLength(0)
    const starter = await sendRoot(actors.alice, `<@${botId}> INTAKE_ANSWER start`)
    if (platform === 'slack') {
      threadTs = starter
      threadId = slackThreadId({ workspaceId: spaceId, channelId, threadTs })
    } else {
      try {
        threadId = (
          await discord.channel(channelId).waitForThread({
            timeout: 10_000,
            predicate: (thread) => thread.name === 'INTAKE_ANSWER start',
          })
        ).id
      } catch (cause) {
        throw new Error(`Discord start routing: ${JSON.stringify(intakeRequests)}`, { cause })
      }
    }
    await waitReply(starter)
    const sessionId = await getThreadSession(threadId)
    await waitReply(await sendThread(actors.alice, 'INTAKE_ANSWER starter follow-up'))

    const before = (await threadMessages()).filter(answer).length
    if (!sessionId) throw new Error('Missing conversation session')
    await upsertSessionSleep({
      sessionId,
      wakeAt: new Date(Date.now() + 3_600_000),
      reason: 'context-only must preserve wake',
    })
    const beforeModel = await getSessionModel(sessionId)
    await sendThread(actors.charlie, 'CONTEXT_ONLY_NOTE')
    await wait(async () =>
      (await history()).some((entry) =>
        entry.parts.some((part) => part.kind === 'text' && part.text.includes('CONTEXT_ONLY_NOTE')),
      ),
    )
    expect((await threadMessages()).filter(answer)).toHaveLength(before)
    expect((await getSessionSleep({ sessionId }))?.status).toBe('planned')
    expect(await getSessionModel(sessionId)).toEqual(beforeModel)
    expect((await getSessionTurnAttribution(sessionId))?.actor?.id).toBe(actors.alice)
    expect(
      contexts.some((request) => request.event === 'turn' && request.actor?.id === actors.charlie),
    ).toBe(false)
    expect(getRuntime(threadId)?.state?.sessionUserId).toBe(actors.alice)
    // Even command-shaped context is data. It cannot change model/agent
    // preferences or invoke a backend command through the noReply route.
    await getRuntime(threadId)!.enqueueIncoming({
      prompt: '/must-not-run CONTEXT_COMMAND_NOTE',
      userId: actors.charlie,
      username: 'charlie',
      noReply: true,
      contextOnly: true,
      agent: 'missing-agent',
      model: 'missing/model',
    })
    await wait(async () =>
      (await history()).some((entry) =>
        entry.parts.some(
          (part) => part.kind === 'text' && part.text.includes('CONTEXT_COMMAND_NOTE'),
        ),
      ),
    )
    expect((await threadMessages()).filter(answer)).toHaveLength(before)
    await sendThread(actors.outsider, `<@${botId}> INTAKE_ANSWER outsider`) // Audience/eligibility gate.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(
      (await history()).some((entry) =>
        entry.parts.some(
          (part) => part.kind === 'text' && part.text.includes('INTAKE_ANSWER outsider'),
        ),
      ),
    ).toBe(false)

    await waitReply(await sendThread(actors.bob, `<@${botId}> INTAKE_ANSWER join`))
    await waitReply(await sendThread(actors.bob, 'INTAKE_ANSWER admitted follow-up'))
    await wait(async () => !getRuntime(threadId)?.isBusy())
    if (platform === 'slack') {
      await bot.stop()
      bot = new NativeSlackBot({
        token: slack.botToken,
        signingSecret: 'intake-secret',
        apiUrl: slack.apiUrl,
        workspaceId: spaceId,
      })
      const started = await bot.start()
      if (started instanceof Error) throw started
      slack.setWebhookUrl(`${bot.url}/slack/events`)
    } else {
      disposeRuntime(threadId)
      await client.destroy()
      await stopOpencodeServer()
      client = createDiscordJsClient({ restUrl: discord.restUrl })
      await startDiscordBot({
        token: discord.botToken,
        appId: discord.botUserId,
        discordClient: client,
      })
    }
    await waitReply(await sendThread(actors.bob, 'INTAKE_ANSWER after restart'))
    await waitReply(await sendThread(actors.alice, 'INTAKE_ANSWER speaker returns'))
    expect(await getThreadSession(threadId)).toBe(sessionId)
    expect(await readConversationAdmission({ platform, spaceId, threadId })).toEqual({
      starterActorId: actors.alice,
      participants: [actors.alice, actors.bob],
    })
    const joinedTurn = (await history()).find(
      (entry) =>
        entry.message.role === 'user' &&
        entry.parts.some(
          (part) => part.kind === 'text' && part.text.includes('INTAKE_ANSWER join'),
        ),
    )
    expect(
      joinedTurn?.parts.some(
        (part) => part.kind === 'text' && part.text.includes(`SPEAKER_${actors.bob}`),
      ),
    ).toBe(true)
    expect(
      (await history())
        .filter((entry) => entry.message.role === 'user')
        .every((entry) => !entry.message.system?.includes('SPEAKER_')),
    ).toBe(true)
    expect(
      (await threadMessages())
        .filter(answer)
        .map((message) => message.text.replace(/^>\s*/, '').trim()),
    ).toMatchInlineSnapshot(`
      [
        "intake-answer",
        "intake-answer",
        "intake-answer",
        "intake-answer",
        "intake-answer",
        "intake-answer",
      ]
    `)
    // Explicit controls pass through the same host gate before mutating state
    // or admitting an actor. Exercise denied and allowed commands over the
    // actual adapter transport, then verify durable membership.
    await wait(async () => !getRuntime(threadId)?.isBusy())
    const removeDeny = addFilter('conversation_intake', (decision, { request }) =>
      request.isCommand ? { outcome: 'ignore' as const, admit: false } : decision,
    )
    const command = async () => {
      if (platform === 'slack') {
        await sendSlashCommand({
          config: {
            signingSecret: 'intake-secret',
            workspaceId: spaceId,
            webhookUrl: `${bot.url}/slack/commands`,
          },
          command: '/roadie',
          text: `model ${threadTs}`,
          userId: actors.charlie,
          userName: 'charlie',
          channelId,
          channelName: 'shared',
        })
      } else {
        const { id } = await discord
          .thread(threadId)
          .user(actors.charlie)
          .runSlashCommand({ name: 'abort' })
        await discord.thread(threadId).waitForInteractionAck({ interactionId: id, timeout: 4000 })
      }
      await wait(async () =>
        intakeRequests.some((request) => request.isCommand && request.actor.id === actors.charlie),
      )
    }
    try {
      await command()
      expect(
        (await readConversationAdmission({ platform, spaceId, threadId }))?.participants,
      ).not.toContain(actors.charlie)
      if (platform === 'slack') expect(slack.getOpenedViews()).toHaveLength(0)
    } finally {
      removeDeny()
    }
    intakeRequests.length = 0
    await command()
    await wait(async () =>
      Boolean(
        (await readConversationAdmission({ platform, spaceId, threadId }))?.participants.includes(
          actors.charlie,
        ),
      ),
    )
    if (platform === 'slack') {
      const view = await slack.waitForOpenedView()
      const metadata = view.view?.private_metadata
      if (!metadata) throw new Error('Intake model picker is missing context')
      const removeCallbackDeny = addFilter('conversation_intake', (decision, { request }) =>
        request.isCommand ? { outcome: 'ignore' as const, admit: false } : decision,
      )
      const submit = () =>
        slack.user(actors.charlie).submitView({
          privateMetadata: metadata,
          values: {
            choice: {
              choice: { selected_option: { value: 'deterministic-provider/deterministic-v3' } },
            },
          },
        })
      try {
        await submit()
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(await getSessionModel(sessionId)).toEqual(beforeModel)
      } finally {
        removeCallbackDeny()
      }
    }
    // Physical thread creation remains a hard bound for native slash starts.
    const config = path.join(root, 'channels.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        channels: {
          [channelId]: {
            directory: project,
            respond: 'always',
            who: 'everyone',
            threads: 'existing-only',
            intake: { start: 'command' },
          },
        },
      }),
    )
    setChannelsConfigPath(config)
    if (platform === 'slack') {
      const count = (await channelMessages()).length
      await sendSlashCommand({
        config: {
          signingSecret: 'intake-secret',
          workspaceId: spaceId,
          webhookUrl: `${bot.url}/slack/commands`,
        },
        command: '/roadie',
        text: 'new INTAKE_ANSWER blocked creation',
        userId: actors.alice,
        userName: 'alice',
        channelId,
        channelName: 'shared',
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect((await channelMessages()).length).toBe(count)
    } else {
      const count = (await discord.channel(channelId).getThreads()).length
      const { id } = await discord
        .channel(channelId)
        .user(actors.alice)
        .runSlashCommand({
          name: 'new-session',
          options: [{ name: 'prompt', type: 3, value: 'INTAKE_ANSWER blocked creation' }],
        })
      await discord.channel(channelId).waitForInteractionAck({ interactionId: id, timeout: 4000 })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect((await discord.channel(channelId).getThreads()).length).toBe(count)
    }
  }
}
