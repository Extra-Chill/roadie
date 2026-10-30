import { beforeEach, describe, expect, test, vi } from 'vitest'
import { Collection, type Message, type ThreadChannel } from 'discord.js'

vi.mock('./database.js', () => ({ getThreadSession: vi.fn() }))
vi.mock('./logger.js', () => ({ LogPrefix: { SESSION: 'SESSION' }, createLogger: () => ({ log: vi.fn(), warn: vi.fn() }) }))
vi.mock('./message-formatting.js', () => ({
  resolveContentMentions: (m: Message) => m.content,
  resolveMentions: (m: Message) => m.content.replace('<@42>', '@resolved'),
  serializeMessageExtras: () => '', getFileAttachments: async () => [],
  getTextAttachments: async (m: Message) => (m as any).textAttachment || '',
}))
vi.mock('./channel-policy.js', () => ({ channelAllowsSpeaker: vi.fn() }))
vi.mock('./identity.js', () => ({ resolvePerson: vi.fn(), getCachedPerson: () => ({ personId: 'person' }) }))
vi.mock('./discord-utils.js', () => ({
  resolveGuildMessageMember: async (m: Message) => m.member,
  hasNoRoadieRole: (m: any) => m.blocked,
  hasRoadieBotPermission: (m: any) => !m.denied,
}))

import { channelAllowsSpeaker } from './channel-policy.js'
import { preprocessNewSessionMessage } from './message-preprocessing.js'
import { extractLeadingCommand } from './leading-command-detection.js'

function msg(id: string, content: string, extra: object = {}): Message {
  return {
    id, content, author: { id: 'user', username: 'user', displayName: 'User', bot: false },
    guild: { id: 'guild', ownerId: 'owner' }, channelId: 'thread',
    member: { displayName: 'Display', roles: { cache: new Collection() } },
    attachments: new Map(), ...extra,
  } as unknown as Message
}

function setup(history: Message[]) {
  const fetch = vi.fn().mockResolvedValue(new Map(history.map(m => [m.id, m])))
  const thread = { id: '100', fetchStarterMessage: async () => msg('100', 'starter'), messages: { fetch } } as unknown as ThreadChannel
  return { thread, fetch, message: msg('200', '@Roadie') }
}

beforeEach(() => {
  vi.mocked(channelAllowsSpeaker).mockReset().mockReturnValue(true)
})

describe('new session thread history', () => {
  test('includes untagged messages oldest first, resolves mentions and text attachments', async () => {
    const input = setup([msg('120', 'second <@42>', { textAttachment: 'attachment' }), msg('110', 'real request'), msg('100', 'starter')])
    const result = await preprocessNewSessionMessage(input)
    expect(input.fetch).toHaveBeenCalledWith({ before: '200', limit: 20 })
    expect(result.prompt).toBe('Context from thread:\nstarter\n\nEarlier messages in thread:\n[Display]: real request\n[Display]: second @resolved\n\nattachment\n\nUser request:\n@Roadie')
  })

  test('excludes bot, system, audience-excluded and permission-denied authors', async () => {
    vi.mocked(channelAllowsSpeaker).mockImplementation((_channel, subject) => subject.userId !== 'excluded')
    const input = setup([
      msg('110', 'bot', { author: { bot: true } }),
      msg('111', 'system', { system: true }),
      msg('112', 'excluded', { author: { id: 'excluded' } }),
      msg('113', 'blocked', { member: { blocked: true, roles: { cache: new Collection() } } }),
      msg('114', 'denied', { member: { denied: true, roles: { cache: new Collection() } } }),
      msg('115', 'allowed'),
    ])
    expect((await preprocessNewSessionMessage(input)).prompt).toBe('Context from thread:\nstarter\n\nEarlier messages in thread:\n[Display]: allowed\n\nUser request:\n@Roadie')
  })

  test('bounds history by character budget, preferring recent messages', async () => {
    const result = await preprocessNewSessionMessage(setup([msg('110', 'older'), msg('120', 'x'.repeat(10_000))]))
    const history = result.prompt.split('Earlier messages in thread:\n')[1]!.split('\n\nUser request:')[0]
    expect(history).toHaveLength(8_000)
    expect(history).not.toContain('older')
  })

  test('fetch failure falls back to starter only', async () => {
    const input = setup([])
    input.fetch.mockRejectedValue(new Error('offline'))
    expect((await preprocessNewSessionMessage(input)).prompt).toBe('Context from thread:\nstarter\n\nUser request:\n@Roadie')
  })

  test('leading commands still work with earlier context', async () => {
    const input = setup([msg('110', '/wrong command')])
    input.message.content = '/build foo'
    const { prompt } = await preprocessNewSessionMessage(input)
    expect(extractLeadingCommand(prompt, [{ name: 'build', discordCommandName: 'build', description: '', source: 'command' }])?.command?.name).toBe('build')
  })
})
