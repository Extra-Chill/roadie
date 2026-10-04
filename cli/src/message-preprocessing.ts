// Message pre-processing pipeline for incoming Discord messages.
// Extracts prompt text, file/text attachments, replied-message context and
// thread starter context from a Discord Message before handing off to the
// runtime.
//
// This module exists so discord-bot.ts stays a thin event router and the
// async work (attachment download, starter message fetch) runs inside the
// runtime's serialized preprocessChain, preserving arrival order without a
// separate threadIngressQueue.

import type { Message, ThreadChannel } from 'discord.js'
import { DiscordOperationError } from './errors.js'
import type { DiscordFileAttachment } from './message-formatting.js'
import type { PreprocessResult } from './session-handler/thread-session-runtime.js'
import type { RepliedMessageContext } from './system-message.js'
import {
  resolveMentions,
  resolveContentMentions,
  serializeMessageExtras,
  getFileAttachments,
  getTextAttachments,
} from './message-formatting.js'
import { getThreadSession } from './database.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.SESSION)

export type { PreprocessResult }

const REPLIED_MESSAGE_TEXT_LIMIT = 1_000

/**
 * Shared ingress step for every Discord message that becomes a prompt: user
 * messages, `roadie send --thread` injections and `roadie send --channel`
 * starter messages. Appends embeds and text attachments. Every message goes
 * to the agent directly; a busy session takes it at its next step boundary.
 *
 * `text` must not contain embeds or attachments yet.
 */
export async function resolveMessagePrompt({
  message,
  text,
  includeExtras = true,
}: {
  message: Message
  text: string
  /** Append serialized embeds, polls and forwards of `message`. */
  includeExtras?: boolean
}): Promise<Pick<PreprocessResult, 'prompt' | 'images' | 'mode'>> {
  const [images, textAttachments] = await Promise.all([
    getFileAttachments(message),
    getTextAttachments(message),
  ])
  const prompt = [
    text,
    includeExtras ? serializeMessageExtras(message) : '',
    textAttachments,
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    prompt,
    images: images.length > 0 ? images : undefined,
    mode: 'opencode',
  }
}

function shouldSkipEmptyPrompt({
  message,
  prompt,
  images,
}: {
  message: Message
  prompt: string
  images?: DiscordFileAttachment[]
}): boolean {
  if (prompt.trim()) {
    return false
  }
  if ((images?.length || 0) > 0) {
    return false
  }
  if (message.attachments.size === 0) {
    return false
  }
  logger.warn(
    `[INGRESS] Skipping empty prompt after preprocessing attachments=${message.attachments.size}`,
  )
  return true
}

async function getRepliedMessageContext({
  message,
}: {
  message: Message
}): Promise<RepliedMessageContext | undefined> {
  if (!message.reference?.messageId) {
    return undefined
  }

  const referencedMessage = await message.fetchReference()
    .catch((e) => new DiscordOperationError({ operation: 'fetchReference', cause: e }))
  if (referencedMessage instanceof Error) {
    logger.warn(
      `[INGRESS] Failed to fetch replied message ${message.reference.messageId} for ${message.id}: ${referencedMessage.message}`,
    )
    return undefined
  }

  const repliedText = resolveMentions(referencedMessage)
    .trim()
    .slice(0, REPLIED_MESSAGE_TEXT_LIMIT)
  if (!repliedText) {
    return undefined
  }

  return {
    authorUsername: referencedMessage.author.username,
    text: repliedText,
  }
}

/**
 * Pre-process a message in an existing thread. Threads without a session yet
 * are handled as new sessions (see preprocessNewSessionMessage).
 */
export async function preprocessExistingThreadMessage({
  message,
  thread,
  isCliInjected,
}: {
  message: Message
  thread: ThreadChannel
  isCliInjected: boolean
}): Promise<PreprocessResult> {
  const sessionId = await getThreadSession(thread.id)
  if (!sessionId) {
    return preprocessNewSessionMessage({ message, thread })
  }

  logger.log(`[SESSION] Found session ${sessionId} for thread ${thread.id}`)
  const messageContent = isCliInjected
    ? (message.content || '')
    : resolveContentMentions(message)
  const repliedMessage = await getRepliedMessageContext({ message })

  const resolved = await resolveMessagePrompt({
    message,
    text: messageContent,
    // The roadie marker embed of CLI injections is metadata, not prompt text.
    includeExtras: !isCliInjected,
  })
  if (shouldSkipEmptyPrompt({ message, ...resolved })) {
    return { prompt: '', mode: 'opencode', skip: true }
  }
  return { ...resolved, repliedMessage }
}

/**
 * Pre-process a message that starts a new session in a thread (no existing
 * session). Adds the thread starter message as context.
 */
export async function preprocessNewSessionMessage({
  message,
  thread,
}: {
  message: Message
  thread: ThreadChannel
}): Promise<PreprocessResult> {
  logger.log(`No session for thread ${thread.id}, starting new session`)

  let prompt = resolveContentMentions(message)
  const repliedMessage = await getRepliedMessageContext({ message })

  // Fetch starter message for thread context
  const starterMessage = await thread
    .fetchStarterMessage()
    .catch((error) => {
      logger.warn(
        `[SESSION] Failed to fetch starter message for thread ${thread.id}:`,
        error instanceof Error ? error.stack : String(error),
      )
      return null
    })
  if (starterMessage && starterMessage.content !== message.content) {
    const starterTextAttachments = await getTextAttachments(starterMessage)
    const starterContent = resolveMentions(starterMessage)
    const starterText = starterTextAttachments
      ? `${starterContent}\n\n${starterTextAttachments}`
      : starterContent
    if (starterText) {
      prompt = `Context from thread:\n${starterText}\n\nUser request:\n${prompt}`
    }
  }

  const resolved = await resolveMessagePrompt({ message, text: prompt })
  if (shouldSkipEmptyPrompt({ message, ...resolved })) {
    return { prompt: '', mode: 'opencode', skip: true }
  }
  return { ...resolved, repliedMessage }
}

/**
 * Pre-process a message from a text channel (creates a new thread).
 */
export async function preprocessNewThreadMessage({
  message,
}: {
  message: Message
  thread: ThreadChannel
}): Promise<PreprocessResult> {
  const messageContent = resolveContentMentions(message)
  const repliedMessage = await getRepliedMessageContext({ message })
  const resolved = await resolveMessagePrompt({ message, text: messageContent })
  if (shouldSkipEmptyPrompt({ message, ...resolved })) {
    return { prompt: '', mode: 'opencode', skip: true }
  }
  return { ...resolved, repliedMessage }
}
