// The Discord chat thread must make the same Discord calls the runtime made
// directly before the seam. A recording stand-in for ThreadChannel checks that.

import { describe, expect, test } from 'vitest'
import { ChannelType, type ThreadChannel } from 'discord.js'
import { createDiscordChatThread } from './discord.js'
import { NOTIFY_MESSAGE_FLAGS, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'

function fakeThread(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = []
  const thread = {
    id: 'thread-1',
    name: 'Fix the bug',
    parentId: 'channel-1',
    guildId: 'guild-1',
    createdTimestamp: 1234,
    client: { user: { id: 'bot-1' } },
    parent: { type: ChannelType.GuildText, topic: '  project topic  ' },
    send: async (payload: unknown) => {
      calls.push(['send', payload])
      return { id: `msg-${calls.length}` }
    },
    sendTyping: async () => {
      calls.push(['typing', undefined])
    },
    setName: async (name: string) => {
      calls.push(['setName', name])
    },
    messages: {
      fetch: async (id: string) => ({ id, content: `text of ${id}` }),
      edit: async (id: string, payload: unknown) => {
        calls.push(['edit', { id, payload }])
      },
    },
    ...overrides,
  }
  return { thread: thread as unknown as ThreadChannel, calls }
}

describe('Discord chat thread', () => {
  test('exposes thread identity', () => {
    const chat = createDiscordChatThread(fakeThread().thread)
    expect([chat.id, chat.name, chat.parentId, chat.spaceId, chat.createdAt, chat.botUserId]).toEqual([
      'thread-1', 'Fix the bug', 'channel-1', 'guild-1', 1234, 'bot-1',
    ])
  })

  test('notices are silent, and replies never ping', async () => {
    const { thread, calls } = fakeThread()
    const chat = createDiscordChatThread(thread)
    await chat.sendNotice('status')
    await chat.sendNotice('queued', { replyTo: 'm-9' })
    expect(calls).toEqual([
      ['send', { content: 'status', flags: SILENT_MESSAGE_FLAGS }],
      ['send', {
        content: 'queued',
        flags: SILENT_MESSAGE_FLAGS,
        allowedMentions: { parse: [], repliedUser: false },
        reply: { messageReference: 'm-9', failIfNotExists: false },
      }],
    ])
  })

  test('messages are silent unless notify', async () => {
    const { thread, calls } = fakeThread()
    const chat = createDiscordChatThread(thread)
    await chat.sendMessage('quiet')
    await chat.sendMessage('loud', { notify: true })
    const flags = calls.map(([, payload]) => (payload as { flags: number }).flags)
    expect(flags).toEqual([SILENT_MESSAGE_FLAGS, NOTIFY_MESSAGE_FLAGS])
  })

  test('send failures come back as errors from sendNotice', async () => {
    const chat = createDiscordChatThread(fakeThread({ send: async () => { throw new Error('429') } }).thread)
    expect(await chat.sendNotice('x')).toBeInstanceOf(Error)
  })

  test('reads and edits message text, renames, types', async () => {
    const { thread, calls } = fakeThread()
    const chat = createDiscordChatThread(thread)
    expect(await chat.readMessageText('m-1')).toBe('text of m-1')
    expect(await chat.editMessageText('m-1', 'plain')).toBeUndefined()
    await chat.rename('New title')
    expect(await chat.sendTyping()).toBeUndefined()
    expect(calls).toEqual([
      ['edit', { id: 'm-1', payload: { content: 'plain' } }],
      ['setName', 'New title'],
      ['typing', undefined],
    ])
  })

  test('channel topic comes from the cached parent, trimmed', async () => {
    expect(await createDiscordChatThread(fakeThread().thread).channelTopic()).toBe('project topic')
    const uncached = fakeThread({ parent: null, guild: { channels: { fetch: async () => null } } })
    expect(await createDiscordChatThread(uncached.thread).channelTopic('c-2')).toBeUndefined()
  })
})
