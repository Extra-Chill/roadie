// /new-session must reach the agent through the backend provider so Pi
// channels work, and file autocomplete must work without any backend client.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChannelType, type AutocompleteInteraction, type ChatInputCommandInteraction, type TextChannel, type ThreadChannel } from 'discord.js'

vi.mock('../session-handler/runtime-registry.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../session-handler/runtime-registry.js')>()
  return {
    ...original,
    getOrCreateRuntime: vi.fn(() => ({
      seedForkPromptCacheBaseline: vi.fn(),
      enqueueIncoming: vi.fn(async () => {}),
    })),
  }
})

const { handleSessionAutocomplete, handleSessionCommand } = await import('./session.js')
const { setAgentBackendProvider } = await import('../agent-backend/registry.js')
const { closeDb } = await import('../db.js')
const { setChannelDirectory } = await import('../database.js')
import type { AgentBackend, AgentBackendProvider } from '../agent-backend/types.js'

const PARENT_CHANNEL_ID = 'new-session-parent'
const THREAD_ID = 'new-session-thread'
const GUILD_ID = 'guild-1'

function createPiRoutingProviderStub(): { provider: AgentBackendProvider; calls: Array<{ directory: string; options?: { channelId?: string } }> } {
  const calls: Array<{ directory: string; options?: { channelId?: string } }> = []
  const backend = {
    catalog: {
      providers: async () => ({ providers: [], connected: [], defaults: {} }),
      config: async () => ({}),
      agents: async () => [],
    },
    sessions: {
      create: async () => ({ id: 'new-session-1' }),
      get: async () => undefined,
      setPermissions: async () => undefined,
      messages: async () => [],
      prompt: async () => undefined,
      command: async () => undefined,
      abort: async () => undefined,
      list: async () => [],
      delete: async () => undefined,
      fork: async () => new Error('not implemented'),
      status: async () => ({}),
      replyPermission: async () => undefined,
    },
  } as unknown as AgentBackend
  const provider: AgentBackendProvider = {
    id: 'pi-stub',
    owns: () => true,
    getBackend: () => null,
    initializeForDirectory: async (directory, options) => {
      calls.push({ directory, options })
      return () => backend
    },
    subscribeEvents: () => null,
    onStarted: () => {},
  }
  return { provider, calls }
}

async function withProvider<T>(provider: AgentBackendProvider, run: () => Promise<T>): Promise<T> {
  const restore = setAgentBackendProvider(provider)
  try {
    return await run()
  } finally {
    restore()
  }
}

const tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'session-routing-test-'))

afterAll(async () => {
  await closeDb()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleSessionCommand backend routing', () => {
  test('/new-session in a Pi channel initializes through the backend provider', async () => {
    const projectDirectory = fs.mkdtempSync(path.join(tempRoot, 'project-'))
    const createdThread = {
      id: 'created-thread-1',
      toString: (): string => '<#created-thread-1>',
      members: { add: vi.fn(async () => {}) },
      send: vi.fn(async () => ({ id: 'm1' })),
    }
    const starterMessage = {
      id: 'starter-message',
      startThread: vi.fn(async () => createdThread),
    }
    const parent: TextChannel = {
      id: PARENT_CHANNEL_ID,
      type: ChannelType.GuildText,
      isThread: () => false,
      guildId: GUILD_ID,
      name: 'project',
      send: vi.fn(async () => starterMessage),
    } as unknown as TextChannel
    const thread: ThreadChannel = {
      id: THREAD_ID,
      parentId: PARENT_CHANNEL_ID,
      type: ChannelType.PublicThread,
      isThread: () => true,
      name: 'source thread',
      guild: {
        id: GUILD_ID,
        channels: { fetch: async (channelId: string) => (channelId === PARENT_CHANNEL_ID ? parent : null) },
      },
    } as unknown as ThreadChannel

    await setChannelDirectory({
      channelId: PARENT_CHANNEL_ID,
      directory: projectDirectory,
      channelType: 'text',
      guildId: GUILD_ID,
    })

    const { provider, calls } = createPiRoutingProviderStub()

    await withProvider(provider, async () => {
      const command = {
        channel: thread,
        user: { id: 'user-1', displayName: 'Tester' },
        client: { user: { username: 'Roadie' } },
        guildId: GUILD_ID,
        id: 'command-1',
        options: {
          getString: (name: string, required?: boolean) =>
            name === 'prompt' && required ? 'hello there' : undefined,
        },
        deferReply: vi.fn(async () => ({})),
        editReply: vi.fn(async () => ({})),
      } as unknown as ChatInputCommandInteraction

      await handleSessionCommand({ command, appId: "test-app" })

      expect(calls).toEqual([{ directory: projectDirectory, options: { channelId: PARENT_CHANNEL_ID } }])
      expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining('Created new session'))
    })
  })
})

describe('handleSessionAutocomplete files', () => {
  test('returns matching project files without initializing any backend', async () => {
    const projectDirectory = fs.mkdtempSync(path.join(tempRoot, 'files-'))
    fs.mkdirSync(path.join(projectDirectory, 'src', 'app'), { recursive: true })
    fs.mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
    fs.mkdirSync(path.join(projectDirectory, 'node_modules', 'dep'), { recursive: true })
    fs.writeFileSync(path.join(projectDirectory, '.gitignore'), 'dist/\n')
    fs.writeFileSync(path.join(projectDirectory, 'README.md'), '')
    fs.writeFileSync(path.join(projectDirectory, 'src', 'index.ts'), '')
    fs.writeFileSync(path.join(projectDirectory, 'src', 'app', 'main.ts'), '')
    fs.writeFileSync(path.join(projectDirectory, 'dist', 'bundle.js'), '')
    fs.writeFileSync(path.join(projectDirectory, 'node_modules', 'dep', 'index.js'), '')

    await setChannelDirectory({
      channelId: 'files-channel',
      directory: projectDirectory,
      channelType: 'text',
      guildId: GUILD_ID,
    })

    const { provider, calls } = createPiRoutingProviderStub()

    await withProvider(provider, async () => {
      const respond = vi.fn(async (_choices?: Array<{ name: string; value: string }>) => {})
      const interaction = {
        channelId: 'files-channel',
        channel: null,
        client: { channels: { fetch: async () => null } },
        options: { getFocused: () => ({ name: 'files', value: 'main' }) },
        respond,
      } as unknown as AutocompleteInteraction

      await handleSessionAutocomplete({ interaction, appId: "test-app" })

      expect(calls).toEqual([])
      expect(respond).toHaveBeenCalledTimes(1)
      const choices = vi.mocked(respond).mock.calls[0]![0] as Array<{ name: string; value: string }>
      expect(choices).toEqual([{ name: 'main.ts', value: 'src/app/main.ts' }])
    })
  })

  test('an empty query still lists tracked project files, ignoring ignored directories', async () => {
    const projectDirectory = fs.mkdtempSync(path.join(tempRoot, 'files-'))
    fs.writeFileSync(path.join(projectDirectory, '.gitignore'), 'dist/\n')
    fs.mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(projectDirectory, 'notes.txt'), '')
    fs.writeFileSync(path.join(projectDirectory, 'dist', 'bundle.js'), '')

    await setChannelDirectory({
      channelId: 'files-channel-empty',
      directory: projectDirectory,
      channelType: 'text',
      guildId: GUILD_ID,
    })

    const { provider, calls } = createPiRoutingProviderStub()

    await withProvider(provider, async () => {
      const respond = vi.fn(async (_choices?: Array<{ name: string; value: string }>) => {})
      const interaction = {
        channelId: 'files-channel-empty',
        channel: null,
        client: { channels: { fetch: async () => null } },
        options: { getFocused: () => ({ name: 'files', value: '' }) },
        respond,
      } as unknown as AutocompleteInteraction

      await handleSessionAutocomplete({ interaction, appId: "test-app" })

      expect(calls).toEqual([])
      const choices = vi.mocked(respond).mock.calls[0]![0] as Array<{ name: string; value: string }>
      expect(choices.map((choice) => choice.value)).toEqual(['.gitignore', 'notes.txt'])
    })
  })
})
