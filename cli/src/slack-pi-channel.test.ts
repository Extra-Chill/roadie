// Per-channel Pi opt-in on Slack (#51): the channel a Slack message arrives in
// decides where its session is created, the same way a Discord thread resolves
// to its parent channel. Real bot and Slack adapter, recording backend stubs:
// withPiChannels is the code under test, keyed like ROADIE_PI_CHANNELS keys
// the default provider, so no agent backend binary is needed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SlackDigitalTwin, sendSlashCommand } from 'slack-digital-twin/src'
import { NativeSlackBot } from './slack-bot.js'
import { setDataDir } from './config.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { closeDatabase, getThreadSession, initDatabase } from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { disposeGlobalEventListener } from './session-handler/global-event-listener.js'
import { slackThreadId } from './chat-platform/slack-api.js'
import { chooseLockPort, initTestGitRepo } from './test-utils.js'
import { setAgentBackendProvider } from './agent-backend/registry.js'
import type { PiBackendProvider } from './agent-backend/pi/backend.js'
import { withPiChannels } from './agent-backend/pi/router.js'
import type {
  AgentBackend,
  AgentBackendEvent,
  AgentBackendProvider,
} from './agent-backend/types.js'

const workspaceId = 'TPIROUTE'
const piChannelId = 'CPIROUTE1'
const otherChannelId = 'CPIROUTE2'
const userId = 'UPIROUTE1'
const secret = 'pi-route-secret'

/** Every initialize call the Slack code made, with the channel that keyed the backend choice. */
const initializeCalls: Array<{ directory: string; channelId?: string }> = []

function stubSessions(id: string, created: string[]): AgentBackend['sessions'] {
  return {
    generateTitle: async () => new Error(`${id}: stub has no titles`),
    create: async (input) => {
      const session = {
        id: `${id}-session-${created.length + 1}`,
        title: `${id} session`,
        directory: input.directory,
      }
      created.push(session.id)
      return session
    },
    get: async () => undefined,
    setPermissions: async () => {},
    messages: async () => [],
    prompt: async () => new Error(`${id}: stub backend does not prompt`),
    command: async () => new Error(`${id}: stub has no commands`),
    abort: async () => {},
    list: async () => [],
    delete: async () => {},
    fork: async () => new Error(`${id}: stub has no forks`),
    setTitle: async () => {},
    summarize: async () => {},
    status: async () => ({}),
    replyPermission: async () => {},
    questions: async () => [],
    replyQuestion: async () => {},
  }
}

function stubBackend(id: string, created: string[]): AgentBackend {
  return {
    sessions: stubSessions(id, created),
    catalog: {
      providers: async () => ({
        providers: [
          {
            id,
            name: id,
            models: { [`${id}-model`]: { id: `${id}-model`, name: `${id} model`, variants: [] } },
          },
        ],
        connected: [id],
        defaults: { [id]: `${id}-model` },
      }),
      config: async () => ({ model: `${id}/${id}-model` }),
      agents: async () => [{ name: 'build', mode: 'primary' }],
    },
    auth: {
      methods: async () => ({}),
      startOAuth: async () => new Error('not used in this test'),
      finishOAuth: async () => new Error('not used in this test'),
      setApiKey: async () => new Error('not used in this test'),
    },
  }
}

/** Pends until the listener's signal aborts, mirroring a live backend stream. */
async function* endlessEvents(signal: AbortSignal): AsyncIterable<AgentBackendEvent> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function stubProvider(id: string, created: string[]): AgentBackendProvider {
  const backend = stubBackend(id, created)
  return {
    id,
    getBackend: () => backend,
    initializeForDirectory: async (directory, options) => {
      initializeCalls.push({ directory, channelId: options?.channelId })
      return () => backend
    },
    subscribeEvents: ({ signal }) => Promise.resolve(endlessEvents(signal)),
    onStarted: () => {},
  }
}

describe('Slack Pi channel routing', () => {
  const fallbackCreated: string[] = []
  const piCreated: string[] = []
  let root: string
  let project: string
  let slack: SlackDigitalTwin
  let bot: NativeSlackBot
  let restoreProvider: (() => void) | undefined

  beforeAll(async () => {
    root = fs.mkdtempSync(
      path.join(process.env['TMPDIR'] || os.tmpdir(), 'roadie-slack-pi-channel-'),
    )
    project = path.join(root, 'project')
    fs.mkdirSync(project)
    initTestGitRepo(project)
    process.env.ROADIE_LOCK_PORT = String(chooseLockPort({ key: 'slack-pi-channel-routing' }))
    setDataDir(path.join(root, 'data'))
    const config = path.join(root, 'channels.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        projects: { shared: { directory: project } },
        channels: {
          [piChannelId]: { project: 'shared', who: 'everyone', respond: 'always' },
          [otherChannelId]: { project: 'shared', who: 'everyone', respond: 'always' },
        },
      }),
    )
    setChannelsConfigPath(config)
    const hrana = await startHranaServer({ dbPath: path.join(root, 'data/discord-sessions.db') })
    if (hrana instanceof Error) throw hrana
    process.env.ROADIE_DB_URL = hrana
    await initDatabase()
    const routed = withPiChannels({
      fallback: stubProvider('stub-opencode', fallbackCreated),
      // The Pi half of the composite, as ROADIE_PI_CHANNELS would build it.
      pi: {
        ...stubProvider('pi', piCreated),
        owns: (sessionId: string) => piCreated.includes(sessionId),
      } as unknown as PiBackendProvider,
      channels: new Set([piChannelId]),
    })
    restoreProvider = setAgentBackendProvider({
      ...routed,
      initializeForDirectory: async (directory, options) => {
        initializeCalls.push({ directory, channelId: options?.channelId })
        return routed.initializeForDirectory(directory, options)
      },
    })
    slack = new SlackDigitalTwin({
      workspaceId,
      botUser: { id: 'UPIROUTEBOT' },
      users: [{ id: userId, name: 'Router' }],
      channels: [
        { id: piChannelId, name: 'pi' },
        { id: otherChannelId, name: 'other' },
      ],
      dbUrl: `file:${path.join(root, 'slack.db')}`,
      webhookConfig: { signingSecret: secret },
    })
    await slack.start()
    bot = new NativeSlackBot({
      token: slack.botToken,
      signingSecret: secret,
      apiUrl: slack.apiUrl,
      workspaceId,
      taskPollIntervalMs: 100,
    })
    const started = await bot.start()
    if (started instanceof Error) throw started
    slack.setWebhookUrl(`${bot.url}/slack/events`)
  }, 30_000)

  afterAll(async () => {
    await bot?.stop()
    restoreProvider?.()
    disposeGlobalEventListener()
    await closeDatabase()
    await stopHranaServer()
    await slack?.stop()
    setChannelsConfigPath(null)
    delete process.env.ROADIE_DB_URL
  }, 20_000)

  async function waitForThreadSession(
    channelId: string,
    threadTs: string,
  ): Promise<string | undefined> {
    const id = slackThreadId({ workspaceId, channelId, threadTs })
    for (let i = 0; i < 100; i++) {
      const sessionId = await getThreadSession(id)
      if (sessionId) return sessionId
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return undefined
  }

  test('a message in a ROADIE_PI_CHANNELS channel creates its session in Pi', async () => {
    const starter = await slack
      .user(userId)
      .sendMessage({ channel: piChannelId, text: 'PI_ROUTE pi channel' })
    const sessionId = await waitForThreadSession(piChannelId, starter.ts)
    expect(sessionId).toBeTruthy()
    expect(piCreated).toContain(sessionId)
    expect(fallbackCreated).not.toContain(sessionId)
    expect(initializeCalls).toContainEqual({ directory: project, channelId: piChannelId })
  }, 20_000)

  test('a message in an unlisted channel stays on the default backend', async () => {
    const starter = await slack
      .user(userId)
      .sendMessage({ channel: otherChannelId, text: 'PI_ROUTE other channel' })
    const sessionId = await waitForThreadSession(otherChannelId, starter.ts)
    expect(sessionId).toBeTruthy()
    expect(fallbackCreated).toContain(sessionId)
    expect(piCreated).not.toContain(sessionId)
    expect(initializeCalls).toContainEqual({ directory: project, channelId: otherChannelId })
  }, 20_000)

  test('roadie model in a Pi channel resolves the model from Pi, not the default backend', async () => {
    const starter = await slack
      .user(userId)
      .sendMessage({ channel: piChannelId, text: 'PI_ROUTE model picker' })
    expect(await waitForThreadSession(piChannelId, starter.ts)).toBeTruthy()
    await sendSlashCommand({
      config: { signingSecret: secret, workspaceId, webhookUrl: `${bot.url}/slack/commands` },
      command: '/roadie',
      text: `model ${starter.ts} pi/pi-model`,
      userId,
      userName: 'Router',
      channelId: piChannelId,
      channelName: 'pi',
    })
    await slack.channel(piChannelId).waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === starter.ts &&
        (message.text === 'Model: pi/pi-model' ||
          message.text ===
            'Unknown or disconnected model. Use /roadie model to choose an available model.'),
    })
    expect(
      (await slack.channel(piChannelId).getMessages()).find(
        (message) =>
          message.thread_ts === starter.ts &&
          (message.text?.startsWith('Model:') ||
            message.text?.startsWith('Unknown or disconnected model')),
      )?.text,
    ).toBe('Model: pi/pi-model')
  }, 20_000)
})
