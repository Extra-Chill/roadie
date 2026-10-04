// /fork — branch the current session into a new thread.
//
//   /fork                       fork the whole session; continue in the new thread
//   /fork prompt:<text>         fork and start working on <text> right away
//   /fork from:<message>        fork from before an earlier user message
//
// The source session keeps running. The fork runs with the source agent,
// model and pinned system prompt so its requests reuse the source prompt cache.

import { openCodeCatalogGetter } from '../agent-backend/registry.js'
import { parsePersistedEvents } from '../session-handler/persisted-events.js'
import type { EventBufferEntry } from '../session-handler/event-stream-state.js'
import {
  ChannelType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
} from 'discord.js'
import {
  getThreadSession,
  getThreadWorkingDirectory,
  setThreadSession,
  setThreadWorkingDirectory,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveTextChannel,
  resolveWorkingDirectory,
  sendThreadMessage,
} from '../discord-utils.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'
import { copySessionPreferences } from './model.js'
import { copySessionSystemPrompt } from '../system-message.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { OpenCodeSdkError } from '../errors.js'

const forkLogger = createLogger(LogPrefix.FORK)

function getThreadChannel(
  channel: ChatInputCommandInteraction['channel'] | StringSelectMenuInteraction['channel'],
): ThreadChannel | Error {
  if (!channel) {
    return new Error('This command can only be used in a channel')
  }

  if (
    channel.type !== ChannelType.PublicThread
    && channel.type !== ChannelType.PrivateThread
    && channel.type !== ChannelType.AnnouncementThread
  ) {
    return new Error('This command can only be used in a thread with an active session')
  }

  return channel
}

function parsePersistedEventRows({
  rows,
}: {
  rows: Array<{ event_json: string; timestamp: number; event_index: number; id: number }>
}): EventBufferEntry[] {
  return rows.flatMap((row) => {
    const events = parsePersistedEvents(row.event_json)
    if (events instanceof Error) {
      forkLogger.warn(
        `[fork] Skipping invalid persisted event row ${row.id}: ${events.message}`,
      )
      return []
    }
    return events.map((event) => ({
      event,
      timestamp: Number(row.timestamp),
      eventIndex: Number(row.event_index),
    }))
  })
}

function truncateLabelPart(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  if (maxLength <= 1) {
    return text.slice(0, maxLength)
  }
  return `${text.slice(0, maxLength - 1)}…`
}

function getSubagentOptionLabel({
  subagentType,
  description,
}: {
  subagentType?: string
  description?: string
}): string {
  const agent = truncateLabelPart(subagentType || 'task', 24)
  const cleanedDescription = description?.trim() || 'No description'
  const descriptionBudget = Math.max(1, 100 - agent.length - 3)
  const truncatedDescription = truncateLabelPart(
    cleanedDescription,
    descriptionBudget,
  )
  return `${agent} · ${truncatedDescription}`
}

// Resolves to [value, elapsed ms] so each fork setup step can be logged.
async function timed<T>(promise: Promise<T>): Promise<[T, number]> {
  const start = Date.now()
  const value = await promise
  return [value, Date.now() - start]
}

const THREAD_NAME_MAX = 100

export async function forkSessionToThread({
  sourceThread,
  projectDirectory,
  sdkDirectory,
  fromMessageId,
  prompt,
  userId,
  actorVia,
  username,
  appId,
  images,
}: {
  sourceThread: ThreadChannel
  projectDirectory: string
  /** The source thread's working directory, otherwise same as projectDirectory */
  sdkDirectory: string
  /** Fork from before this user message instead of the end of the session. */
  fromMessageId?: string
  /** Started in the fork right away when set. */
  prompt?: string
  userId: string
  actorVia?: 'chat' | 'cli'
  username: string
  appId: string | undefined
  images?: DiscordFileAttachment[]
}): Promise<{ thread: ThreadChannel; forkedSessionId: string } | Error> {
  const startedAt = Date.now()
  const [sessionId, getClientResult, textChannel] = await Promise.all([
    getThreadSession(sourceThread.id),
    initializeOpencodeForDirectory(projectDirectory),
    resolveTextChannel(sourceThread),
  ])

  if (!sessionId) {
    return new Error('No active session in this thread')
  }
  if (getClientResult instanceof Error) {
    return new Error(`Failed to fork session: ${getClientResult.message}`, {
      cause: getClientResult,
    })
  }
  if (!textChannel) {
    return new Error('Could not resolve parent text channel')
  }

  const threadLabel = prompt?.trim() || sourceThread.name.replace(/^(Fork: |btw: )/, '')

  // Fork and thread creation are independent round trips, so run them together.
  // If either side fails, remove whichever side succeeded.
  const initMs = Date.now() - startedAt
  const [forkSettled, threadSettled] = await Promise.allSettled([
    timed(getClientResult().session.fork({
      sessionID: sessionId,
      directory: sdkDirectory,
      ...(fromMessageId && { messageID: fromMessageId }),
    })),
    timed(textChannel.threads.create({
      name: `Fork: ${threadLabel}`.slice(0, THREAD_NAME_MAX),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Forked from session ${sessionId}`,
    })),
  ])
  const forkedSession = forkSettled.status === 'fulfilled' ? forkSettled.value[0].data : undefined
  const createdThread = threadSettled.status === 'fulfilled' ? threadSettled.value[0] : undefined
  const cleanup = async () => {
    await Promise.all([
      createdThread?.delete('fork setup failed').catch((error) => {
        forkLogger.warn(`Could not delete orphan fork thread ${createdThread.id}:`, error)
      }),
      forkedSession && getClientResult()
        .session.delete({ sessionID: forkedSession.id, directory: sdkDirectory })
        .catch((error) => {
          forkLogger.warn(`Could not delete orphan fork session ${forkedSession.id}:`, error)
        }),
    ])
  }
  if (!forkedSession) {
    await cleanup()
    const cause = forkSettled.status === 'rejected' ? forkSettled.reason : forkSettled.value[0].error
    return new OpenCodeSdkError({ operation: 'session.fork', cause })
  }
  if (!createdThread) {
    await cleanup()
    return new Error('Failed to create the fork thread', {
      cause: threadSettled.status === 'rejected' ? threadSettled.reason : undefined,
    })
  }
  const thread = createdThread
  const forkMs = forkSettled.status === 'fulfilled' ? forkSettled.value[1] : -1
  const threadMs = threadSettled.status === 'fulfilled' ? threadSettled.value[1] : -1
  const channelId = sourceThread.parentId || sourceThread.id
  const sourceThreadLink = `<#${sourceThread.id}>`

  // `false` (source not pinned yet) is the only fallback; I/O errors fail setup.
  const copyStartedAt = Date.now()
  const [, copiedSystem, history] = await Promise.all([
    copySessionPreferences({
      sourceSessionId: sessionId,
      targetSessionId: forkedSession.id,
      channelId,
      appId,
      getClient: () => ({ ...openCodeCatalogGetter(getClientResult)(), session: getClientResult().session }),
      directory: sdkDirectory,
    }),
    copySessionSystemPrompt({
      sourceSessionId: sessionId,
      targetSessionId: forkedSession.id,
    }),
    getClientResult().session.messages({
      sessionID: forkedSession.id,
      directory: sdkDirectory,
      limit: 10,
    }).catch((cause) => new OpenCodeSdkError({ operation: 'session.messages', cause })),
  ])
  if (copiedSystem instanceof Error) {
    await cleanup()
    return new Error(`Could not copy the source system prompt to the fork: ${copiedSystem.message}`, {
      cause: copiedSystem,
    })
  }

  const copyMs = Date.now() - copyStartedAt
  const trimmedPrompt = prompt?.trim()
  await Promise.all([
    // DB mapping must complete before dispatch so the thread is routable
    (async () => {
      await setThreadSession(thread.id, forkedSession.id)
      // The fork works where its source thread works.
      const source = await getThreadWorkingDirectory(sourceThread.id)
      if (!source) {
        return
      }
      await setThreadWorkingDirectory({ ...source, threadId: thread.id, projectDirectory })
    })(),
    thread.members.add(userId).catch((error) => {
      forkLogger.warn('Could not add fork member:', error)
    }),
    sendThreadMessage(
      thread,
      trimmedPrompt
        ? `Forked from ${sourceThreadLink}.\n${trimmedPrompt}`
        : `Forked from ${sourceThreadLink}. Continue the conversation here.`,
    ),
  ])

  forkLogger.log(
    `Created fork session ${forkedSession.id} in thread ${thread.id} from ${sourceThread.id} (session ${sessionId}${fromMessageId ? `, before message ${fromMessageId}` : ''}), system prompt ${copiedSystem ? 'reused' : 'regenerated'}`,
  )
  forkLogger.log(
    `[FORK TIMING] ${forkedSession.id} init=${initMs}ms fork=${forkMs}ms threadCreate=${threadMs}ms copyPrefs=${copyMs}ms total=${Date.now() - startedAt}ms`,
  )

  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory,
    sdkDirectory,
    channelId,
    appId,
    sessionId: forkedSession.id,
  })
  if (history instanceof Error || history.error) {
    forkLogger.warn('Could not load copied messages for fork cache diagnostics:', history)
  } else {
    const last = history.data?.findLast(({ info }) =>
      info.role === 'assistant' && typeof info.time.completed === 'number',
    )?.info
    if (last?.role === 'assistant') {
      runtime.seedForkPromptCacheBaseline(last)
    }
  }

  if (trimmedPrompt) {
    // Parent context stays in the user prompt only. Passing parentSessionId
    // would add a parent block to the system message and bust the prompt
    // cache shared with the source session.
    const forkedPrompt = [
      `This conversation was forked from thread <#${sourceThread.id}> (session ${sessionId}) into a new thread.`,
      `Do not send messages to the source session unless the user asks you to.`,
      ``,
      trimmedPrompt,
    ].join('\n')
    // Not awaited: the caller confirms right away while the runtime resolves
    // preferences and dispatches. Failures are reported in the fork.
    void runtime.enqueueIncoming({
      prompt: forkedPrompt,
      images,
      userId,
      actorVia,
      username,
      appId,
      mode: 'opencode',
    }).then(() => {
      forkLogger.log(`[FORK TIMING] ${forkedSession.id} promptAccepted=${Date.now() - startedAt}ms`)
    }, async (error) => {
      forkLogger.error('Fork dispatch failed:', error)
      await sendThreadMessage(thread, 'Could not send the request to the agent. Send it again in this thread.')
    })
  }

  return { thread, forkedSessionId: forkedSession.id }
}

export async function handleForkCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string | undefined
}): Promise<void> {
  const threadChannel = getThreadChannel(interaction.channel)
  if (threadChannel instanceof Error) {
    await interaction.reply({ content: threadChannel.message, flags: MessageFlags.Ephemeral })
    return
  }

  const resolved = await resolveWorkingDirectory({ channel: threadChannel })
  if (!resolved) {
    await interaction.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const prompt = interaction.options.getString('prompt') ?? undefined
  const fromMessageId = interaction.options.getString('from') ?? undefined
  try {
    const result = await forkSessionToThread({
      sourceThread: threadChannel,
      projectDirectory: resolved.projectDirectory,
      sdkDirectory: resolved.workingDirectory,
      ...(fromMessageId && { fromMessageId }),
      ...(prompt && { prompt }),
      userId: interaction.user.id,
      username: interaction.user.displayName,
      appId,
    })
    if (result instanceof Error) {
      await interaction.editReply(`Failed to fork session: ${result.message}`)
      return
    }
    await interaction.editReply(`Session forked! Continue in ${result.thread.toString()}`)
  } catch (error) {
    forkLogger.error('Error forking session:', error)
    await interaction.editReply(
      `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

/** `from:` choices: the session's recent user messages, newest first. */
export async function handleForkAutocomplete({
  interaction,
}: {
  interaction: AutocompleteInteraction
}): Promise<void> {
  const respondEmpty = () => interaction.respond([]).catch(() => undefined)
  const channel = interaction.channel
  if (!channel?.isThread()) {
    await respondEmpty()
    return
  }
  const [sessionId, resolved] = await Promise.all([
    getThreadSession(channel.id),
    resolveWorkingDirectory({ channel }),
  ])
  if (!sessionId || !resolved) {
    await respondEmpty()
    return
  }
  const getClient = await initializeOpencodeForDirectory(resolved.projectDirectory)
  if (getClient instanceof Error) {
    await respondEmpty()
    return
  }
  const response = await getClient().session.messages({
    sessionID: sessionId,
    directory: resolved.workingDirectory,
  }).catch(() => undefined)
  if (!response?.data) {
    await respondEmpty()
    return
  }
  const query = interaction.options.getFocused().toLowerCase()
  const choices = response.data
    .filter((m) => m.info.role === 'user')
    .flatMap((m) => {
      // Synthetic parts (context, reminders) would clutter the preview.
      const text = m.parts.find((p) => p.type === 'text' && !p.synthetic && typeof p.text === 'string')
      if (!text || text.type !== 'text') return []
      const preview = text.text.replace(/\s+/g, ' ').trim()
      if (!preview) return []
      return [{ preview, id: m.info.id }]
    })
    .reverse()
    .filter(({ preview }) => !query || preview.toLowerCase().includes(query))
    .slice(0, 25)
    .map(({ preview, id }) => ({
      name: preview.length > 100 ? `${preview.slice(0, 99)}…` : preview,
      value: id,
    }))
  await interaction.respond(choices).catch(() => undefined)
}

export { getThreadChannel, parsePersistedEventRows }
