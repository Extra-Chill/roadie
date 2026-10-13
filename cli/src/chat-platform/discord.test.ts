// The Discord chat thread must make the same Discord calls the runtime made
// directly before the seam. A recording stand-in for ThreadChannel checks that.

import { describe, expect, test } from 'vitest'
import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import { createDiscordChatChannel, createDiscordChatThread } from './discord.js'
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

function fakeTextChannel() {
  const calls: Array<[string, unknown]> = []
  const channel = {
    id: 'channel-9',
    name: 'roadie',
    type: ChannelType.GuildText,
    guildId: 'guild-1',
    createdTimestamp: 99,
    topic: '  team channel  ',
    client: { user: { id: 'bot-1' } },
    send: async (payload: unknown) => {
      calls.push(['send', payload])
      return { id: `msg-${calls.length}` }
    },
    setName: async (name: string) => {
      calls.push(['setName', name])
    },
  }
  return { channel: channel as unknown as TextChannel, calls }
}

const anchored = (messageId: string) => ({
  allowedMentions: { parse: [], repliedUser: false },
  reply: { messageReference: messageId, failIfNotExists: false },
})

describe('Discord inline channel conversation (threads: none)', () => {
  test('the channel is the conversation container', async () => {
    const { channel } = fakeTextChannel()
    const chat = createDiscordChatChannel(channel)
    expect([chat.id, chat.name, chat.parentId, chat.spaceId, chat.createdAt, chat.botUserId]).toEqual([
      'channel-9', 'roadie', 'channel-9', 'guild-1', 99, 'bot-1',
    ])
    expect(chat.capabilities.rename).toBe(false)
    expect(await chat.channelTopic()).toBe('team channel')
  })

  test('a turn anchors only its first reply to the message that started it', async () => {
    const { channel, calls } = fakeTextChannel()
    const chat = createDiscordChatChannel(channel)
    chat.setReplyAnchor?.('user-msg-1')
    await chat.sendPart('first answer')
    await chat.sendPart('more')
    await chat.sendMessage('footer')
    const sends = calls.map(([, payload]) => payload as Record<string, unknown>)
    expect(sends[0]).toMatchObject(anchored('user-msg-1'))
    expect(sends[1]).not.toHaveProperty('reply')
    expect(sends[2]).not.toHaveProperty('reply')
  })

  test('the next turn re-anchors to its own message', async () => {
    const { channel, calls } = fakeTextChannel()
    const chat = createDiscordChatChannel(channel)
    chat.setReplyAnchor?.('user-msg-1')
    await chat.sendPart('answer one')
    chat.setReplyAnchor?.('user-msg-2')
    await chat.sendMessage('answer two')
    const sends = calls.map(([, payload]) => payload as Record<string, unknown>)
    expect(sends[0]).toMatchObject(anchored('user-msg-1'))
    expect(sends[1]).toMatchObject(anchored('user-msg-2'))
  })

  test('session titles never rename the channel', async () => {
    const { channel, calls } = fakeTextChannel()
    const chat = createDiscordChatChannel(channel)
    await chat.rename('A session title')
    await chat.syncTitle?.('A session title')
    expect(calls).toEqual([])
  })

  test('footer mentions the speaker, never the bot', async () => {
    const chat = createDiscordChatChannel(fakeTextChannel().channel)
    expect(await chat.footerMentionUserId('user-7')).toBe('user-7')
    expect(await chat.footerMentionUserId('bot-1')).toBeUndefined()
    expect(await chat.footerMentionUserId(undefined)).toBeUndefined()
  })
})

describe('Discord chat thread without an anchor', () => {
  test('thread parts are never sent as replies', async () => {
    const { thread, calls } = fakeThread()
    const chat = createDiscordChatThread(thread)
    expect(chat.setReplyAnchor).toBeUndefined()
    await chat.sendPart('answer')
    expect(calls[0]?.[1]).not.toHaveProperty('reply')
  })
})
