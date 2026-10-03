// Discord implementation of the chat platform seam. Each method performs the
// exact Discord call the session runtime made before the seam existed.

import { ChannelType, type ThreadChannel } from 'discord.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  SILENT_MESSAGE_FLAGS,
  sendSessionPartMessage,
  sendThreadMessage,
} from '../discord-utils.js'
import { DiscordOperationError } from '../errors.js'
import type { ChatThread } from './types.js'

function flagsFor(notify: boolean | undefined): number {
  return notify ? NOTIFY_MESSAGE_FLAGS : SILENT_MESSAGE_FLAGS
}

export function createDiscordChatThread(thread: ThreadChannel): ChatThread {
  return {
    get id() {
      return thread.id
    },
    get name() {
      return thread.name
    },
    get parentId() {
      return thread.parentId
    },
    get spaceId() {
      return thread.guildId
    },
    get createdAt() {
      return thread.createdTimestamp
    },
    get botUserId() {
      return thread.client.user?.id
    },

    async sendNotice(content, options) {
      return thread.send({
        content,
        flags: SILENT_MESSAGE_FLAGS,
        ...(options?.replyTo && {
          allowedMentions: { parse: [], repliedUser: false },
          reply: { messageReference: options.replyTo, failIfNotExists: false },
        }),
      }).catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    },

    async sendMessage(content, options) {
      return sendThreadMessage(thread, content, { flags: flagsFor(options?.notify) })
    },

    async sendPart(content, options) {
      return sendSessionPartMessage(thread, content, {
        leadWithBlankLine: options?.leadWithBlankLine,
        flags: flagsFor(options?.notify),
      })
    },

    async readMessageText(messageId) {
      const message = await thread.messages.fetch(messageId)
        .catch((e) => new DiscordOperationError({ operation: 'fetchMessage', cause: e }))
      return message instanceof Error ? message : message.content
    },

    async editMessageText(messageId, content) {
      const result = await thread.messages.edit(messageId, { content })
        .catch((e) => new DiscordOperationError({ operation: 'editMessage', cause: e }))
      return result instanceof Error ? result : undefined
    },

    async sendTyping() {
      const result = await thread.sendTyping()
        .catch((e) => new DiscordOperationError({ operation: 'sendTyping', cause: e }))
      return result instanceof Error ? result : undefined
    },

    async rename(name) {
      await thread.setName(name)
    },

    async channelTopic(channelId) {
      if (thread.parent?.type === ChannelType.GuildText) {
        return thread.parent.topic?.trim() || undefined
      }
      if (!channelId) {
        return undefined
      }
      const fetched = await thread.guild.channels.fetch(channelId)
        .catch((e) => new DiscordOperationError({ operation: 'fetchChannel', cause: e }))
      if (fetched instanceof Error || !fetched || fetched.type !== ChannelType.GuildText) {
        return undefined
      }
      return fetched.topic?.trim() || undefined
    },
  }
}
