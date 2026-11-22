import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import type { Client, VoiceState } from 'discord.js'
const mocks = vi.hoisted(() => ({
  allowed: vi.fn(async () => true),
  join: vi.fn(),
  secret: vi.fn(() => 'key'),
}))
vi.mock('./voice-thread-host.js', () => ({
  voiceSpeakerAllowed: mocks.allowed,
  createVoiceThreadHost: () => ({
    list: async () => [{ id: 'thread', label: 'roadie', status: 'idle' }],
    read: async () => '',
  }),
}))
vi.mock('./channel-policy.js', () => ({ resolveChannelPolicy: () => ({ voice: true }) }))
vi.mock('./config.js', () => ({ readRoadieSecret: mocks.secret }))
vi.mock('@discordjs/voice', () => ({
  joinVoiceChannel: mocks.join,
  entersState: async () => {},
  createAudioPlayer: () => Object.assign(new EventEmitter(), { stop: vi.fn() }),
  VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected' },
  AudioPlayerStatus: { Idle: 'idle' },
  EndBehaviorType: { AfterSilence: 1 },
  StreamType: { Raw: 'raw' },
  createAudioResource: vi.fn(),
}))
import { doAction } from './hooks.js'
import { installVoiceDispatcher } from './voice-handler.js'
import { ChannelType, Events } from 'discord.js'

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  vi.clearAllMocks()
})
function setup() {
  const connection = Object.assign(new EventEmitter(), {
    subscribe: vi.fn(),
    destroy: vi.fn(),
    receiver: { speaking: new EventEmitter() },
  })
  mocks.join.mockReturnValue(connection)
  const client = new EventEmitter() as unknown as Client
  const member = { voice: { channelId: 'voice' }, send: vi.fn(async () => {}) }
  const state = {
    id: 'human',
    channelId: 'voice',
    channel: { id: 'voice', type: ChannelType.GuildVoice },
    guild: { id: 'guild' },
    member,
  } as unknown as VoiceState
  const live = { audio: vi.fn(), announce: vi.fn(), close: vi.fn() }
  const provider = { connect: vi.fn(async () => live) }
  stop = installVoiceDispatcher(client, async () => {}, provider)
  return { client, state, member, provider, live, connection }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
test('authorized join opens Live and leaving frees connection and provider exactly once', async () => {
  const { client, state, member, provider, live, connection } = setup()
  client.emit(Events.VoiceStateUpdate, state, state)
  await settle()
  expect(provider.connect).toHaveBeenCalledOnce()
  await doAction('session_idle', { sessionId: 'session', threadId: 'thread' })
  expect(live.announce).toHaveBeenCalledWith(expect.stringContaining('roadie finished'))
  member.voice.channelId = ''
  client.emit(Events.VoiceStateUpdate, state, {
    ...state,
    channelId: null,
    channel: null,
  } as unknown as VoiceState)
  await settle()
  expect(live.close).toHaveBeenCalledOnce()
  expect(connection.destroy).toHaveBeenCalledOnce()
  stop?.()
  expect(connection.destroy).toHaveBeenCalledOnce()
})
test('missing key refuses before allocating voice resources and explains why', async () => {
  mocks.secret.mockReturnValueOnce('')
  const { client, state, member, provider } = setup()
  client.emit(Events.VoiceStateUpdate, state, state)
  await settle()
  expect(mocks.join).not.toHaveBeenCalled()
  expect(provider.connect).not.toHaveBeenCalled()
  expect(member.send).toHaveBeenCalledWith(expect.stringContaining('ROADIE_GEMINI_API_KEY'))
})
test('unauthorized speaker cannot allocate a connection', async () => {
  mocks.allowed.mockResolvedValueOnce(false)
  const { client, state } = setup()
  client.emit(Events.VoiceStateUpdate, state, state)
  await settle()
  expect(mocks.join).not.toHaveBeenCalled()
})
