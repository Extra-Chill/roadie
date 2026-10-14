// /fork must reach sessions through the agent backend provider so Pi channels
// work.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChannelType, type ChatInputCommandInteraction, type TextChannel, type ThreadChannel } from 'discord.js'

vi.mock('../session-handler/thread-session-runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../session-handler/thread-session-runtime.js')>()
  return {
    ...original,
    getOrCreateRuntime: vi.fn(() => ({
      seedForkPromptCacheBaseline: vi.fn(),
      enqueueIncoming: vi.fn(async () => {}),
    })),
  }
})

const { handleForkCommand } = await import('./fork.js')
const { setAgentBackendProvider } = await import('../agent-backend/registry.js')
const { closeDb } = await import('../db.js')
const { setChannelDirectory, setThreadSession } = await import('../database.js')
import type { AgentBackend, AgentBackendProvider } from '../agent-backend/types.js'

const PARENT_CHANNEL_ID = 'parent-channel-1'
const THREAD_ID = 'source-thread-1'
const GUILD_ID = 'guild-1'

function createStubBackend({ fork }: { fork?: (input: unknown) => Promise<unknown> } = {}): AgentBackend {
  return {
    catalog: {
      providers: async () => ({ providers: [], connected: [], defaults: {} }),
      config: async () => ({}),
      agents: async () => [],
    },
    auth: {
      methods: async () => ({}),
      startOAuth: async () => new Error('not implemented'),
      finishOAuth: async () => undefined,
      setApiKey: async () => undefined,
    },
    sessions: {
      create: async () => new Error('not implemented'),
      get: async () => undefined,
      setPermissions: async () => undefined,
      messages: async () => [],
      prompt: async () => undefined,
      command: async () => undefined,
      abort: async () => undefined,
      list: async () => [],
      delete: async () => undefined,
      fork: fork ?? vi.fn(async () => ({ id: 'forked-session-1', title: 'Fork' })),
      status: async () => ({}),
      replyPermission: async () => undefined,
    },
  } as unknown as AgentBackend
}

type InitializeCall = { directory: string; options?: { channelId?: string } }

function createPiRoutingProviderStub({
  backend,
  result,
}: {
  backend: AgentBackend
  result?: Error
}): { provider: AgentBackendProvider; calls: InitializeCall[] } {
  const calls: InitializeCall[] = []
  const provider: AgentBackendProvider = {
    id: 'pi-stub',
    owns: () => true,
    getBackend: () => null,
    initializeForDirectory: async (directory, options) => {
      calls.push({ directory, options })
      if (result) return result
      return () => backend
    },
    subscribeEvents: () => null,
    onStarted: () => {},
  }
  return { provider, calls }
}

function createParentChannel(overrides: Partial<Record<string, unknown>> = {}): TextChannel {
  return {
    id: PARENT_CHANNEL_ID,
    type: ChannelType.GuildText,
    isThread: () => false,
    guildId: GUILD_ID,
    name: 'project',
    ...overrides,
  } as unknown as TextChannel
}

function createThread({ parent }: { parent: TextChannel }): ThreadChannel {
  return {
    id: THREAD_ID,
    parentId: parent.id,
    type: ChannelType.PublicThread,
    isThread: () => true,
    name: 'source thread',
    guild: {
      id: GUILD_ID,
      channels: {
        fetch: async (channelId: string) => (channelId === parent.id ? parent : null),
      },
    },
  } as unknown as ThreadChannel
}

function createForkThread(): ThreadChannel {
  return {
    id: 'fork-thread-1',
    name: 'Fork: source thread',
    delete: vi.fn(async () => {}),
    toString: () => '<#fork-thread-1>',
    members: { add: vi.fn(async () => {}) },
    send: vi.fn(async () => ({ id: 'starter-message' })),
  } as unknown as ThreadChannel
}

function createInteraction({ channel }: { channel: ThreadChannel }): ChatInputCommandInteraction {
  return {
    channel,
    user: { id: 'user-1', displayName: 'Tester' },
    options: { getString: () => undefined },
    deferred: false,
    deferReply: vi.fn(async () => ({})),
    editReply: vi.fn(async () => ({})),
  } as unknown as ChatInputCommandInteraction
}

async function withProvider<T>(provider: AgentBackendProvider, run: () => Promise<T>): Promise<T> {
  const restore = setAgentBackendProvider(provider)
  try {
    return await run()
  } finally {
    restore()
  }
}

const tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fork-routing-test-'))

afterAll(async () => {
  await closeDb()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleForkCommand backend routing', () => {
  test('in a Pi channel the fork initializes through the backend provider', async () => {
    const projectDirectory = fs.mkdtempSync(path.join(tempRoot, 'project-'))
    const parent = createParentChannel()
    const thread = createThread({ parent })
    const forkThread = createForkThread()
    parent.threads = { create: vi.fn(async () => forkThread) } as never

    await setChannelDirectory({
      channelId: PARENT_CHANNEL_ID,
      directory: projectDirectory,
      channelType: 'text',
      guildId: GUILD_ID,
    })
    await setThreadSession(THREAD_ID, 'source-session-1')

    const backend = createStubBackend()
    const { provider, calls } = createPiRoutingProviderStub({ backend })
    const forkSpy = vi.mocked(backend.sessions.fork)

    await withProvider(provider, async () => {
      const interaction = createInteraction({ channel: thread })
      await handleForkCommand({ interaction, appId: "test-app" })

      expect(calls).toEqual([{ directory: projectDirectory, options: { channelId: PARENT_CHANNEL_ID } }])
      expect(forkSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'source-session-1',
        directory: projectDirectory,
      }))
      expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Session forked'))
    })
  })

  test('a provider initialization failure fails the fork', async () => {
    const projectDirectory = fs.mkdtempSync(path.join(tempRoot, 'project-'))
    const parent = createParentChannel()
    const thread = createThread({ parent })

    await setChannelDirectory({
      channelId: PARENT_CHANNEL_ID,
      directory: projectDirectory,
      channelType: 'text',
      guildId: GUILD_ID,
    })
    await setThreadSession(THREAD_ID, 'source-session-1')

    const backend = createStubBackend()
    const { provider, calls } = createPiRoutingProviderStub({
      backend,
      result: new Error('pi backend unavailable'),
    })

    await withProvider(provider, async () => {
      const interaction = createInteraction({ channel: thread })
      await handleForkCommand({ interaction, appId: "test-app" })

      expect(calls).toEqual([{ directory: projectDirectory, options: { channelId: PARENT_CHANNEL_ID } }])
      expect(backend.sessions.fork).not.toHaveBeenCalled()
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fork session: pi backend unavailable'),
      )
    })
  })
})
