// Discord implementation of the chat platform seam. Each method performs the
// exact Discord call the session runtime made before the seam existed.

import { ChannelType, Routes, type TextChannel, type ThreadChannel } from 'discord.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  SILENT_MESSAGE_FLAGS,
  sendSessionPartMessage,
  sendThreadMessage,
  resolveThreadFooterMentionUserId,
} from '../discord-utils.js'
import { showPermissionButtons, addPermissionRequestToContext, pendingPermissionContexts } from '../commands/permissions.js'
import { showAskUserQuestionDropdowns, hasPendingQuestionForThread, cancelPendingQuestion } from '../commands/ask-question.js'
import { showActionButtons, pendingActionButtonContexts } from '../commands/action-buttons.js'
import { pendingFileUploadContexts, showFileUploadButton } from '../commands/file-upload.js'
import { DiscordApiError, DiscordOperationError } from '../errors.js'
import { readChannelMessages } from '../discord-channel-reads.js'
import type { ChatThread } from './types.js'

function flagsFor(notify: boolean | undefined): number {
  return notify ? NOTIFY_MESSAGE_FLAGS : SILENT_MESSAGE_FLAGS
}

export function createDiscordChatThread(thread: ThreadChannel): ChatThread {
  return {
    platform: 'discord',
    capabilities: { rename: true, typing: true },
    footerMentionUserId: (sessionUserId) => resolveThreadFooterMentionUserId({ thread, sessionUserId }),
    interactions: {
      permission: (input) => showPermissionButtons({ thread, ...input }),
      addPermissionRequest: addPermissionRequestToContext,
      clearPermission: (hash) => { pendingPermissionContexts.delete(hash) },
      question: (input) => showAskUserQuestionDropdowns({ thread, ...input }),
      actions: async (input) => { await showActionButtons({ thread, ...input }) },
      upload: (input) => showFileUploadButton({ thread, ...input }),
      hasQuestion: () => hasPendingQuestionForThread(thread.id),
      hasPending: () => [
        ...pendingActionButtonContexts.values(),
        ...pendingFileUploadContexts.values(),
        ...pendingPermissionContexts.values(),
      ].some((context) => context.thread.id === thread.id),
      cancelQuestion: async () => { await cancelPendingQuestion(thread.id) },
      dispose: () => {},
    },
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

    async readRecentMessages(limit) {
      const messages = await readChannelMessages({ rest: thread.client.rest, channelId: thread.id, limit })
      if (messages instanceof DiscordApiError) return messages
      return messages.map((message) => ({
        author: message.author,
        bot: message.bot,
        timestamp: message.timestamp,
        content: message.content,
      }))
    },

    async editMessageText(messageId, content) {
      const result = await thread.messages.edit(messageId, { content })
        .catch((e) => new DiscordOperationError({ operation: 'editMessage', cause: e }))
      return result instanceof Error ? result : undefined
    },

    async setPendingMarker(messageId, on) {
      const route = Routes.channelMessageOwnReaction(thread.id, messageId, encodeURIComponent('⏳'))
      const result = await (on ? thread.client.rest.put(route) : thread.client.rest.delete(route))
        .catch((e) => new DiscordOperationError({ operation: on ? 'addReaction' : 'removeReaction', cause: e }))
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

/**
 * A text channel answered inline (channel policy `threads: none`). The channel
 * itself is the conversation container: one long-running session keyed by the
 * channel id. It is never renamed, and each turn's first reply is anchored to
 * the message that started it so answers stay legible in a busy channel.
 */
export function createDiscordChatChannel(channel: TextChannel): ChatThread {
  // The interactive prompt helpers only use the members a text channel shares
  // with a thread (id, send, messages, client); thread-only fields such as
  // ownerId read as undefined.
  const container = channel as unknown as ThreadChannel
  const base = createDiscordChatThread(container)
  let replyAnchor: string | undefined
  const takeAnchor = () => {
    const anchor = replyAnchor
    replyAnchor = undefined
    return anchor
  }
  return {
    platform: 'discord',
    capabilities: { rename: false, typing: true },
    interactions: base.interactions,
    footerMentionUserId: async (sessionUserId) => {
      const botUserId = channel.client.user?.id
      return sessionUserId && sessionUserId !== botUserId ? sessionUserId : undefined
    },
    get id() {
      return channel.id
    },
    get name() {
      return channel.name
    },
    get parentId() {
      return channel.id
    },
    get spaceId() {
      return channel.guildId
    },
    get createdAt() {
      return channel.createdTimestamp
    },
    get botUserId() {
      return channel.client.user?.id
    },
    setReplyAnchor(messageId) {
      replyAnchor = messageId
    },
    async syncTitle() {
      // Session titles are not shown on a channel; never rename it.
    },
    async sendMessage(content, options) {
      return sendThreadMessage(channel, content, { flags: flagsFor(options?.notify), replyTo: takeAnchor() })
    },
    async sendPart(content, options) {
      return sendSessionPartMessage(channel, content, {
        leadWithBlankLine: options?.leadWithBlankLine,
        flags: flagsFor(options?.notify),
        replyTo: takeAnchor(),
      })
    },
    async rename() {
      // Never rename a channel from a session title.
    },
    async channelTopic() {
      return channel.topic?.trim() || undefined
    },
    sendNotice: base.sendNotice,
    readMessageText: base.readMessageText,
    readRecentMessages: base.readRecentMessages,
    editMessageText: base.editMessageText,
    setPendingMarker: base.setPendingMarker,
    sendTyping: base.sendTyping,
  }
}
