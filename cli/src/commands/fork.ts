// /fork — branch the current session into a new thread.
//
//   /fork                       fork the whole session; continue in the new thread
//   /fork prompt:<text>         fork and start working on <text> right away
//   /fork from:<message>        fork from before an earlier user message
//
// The source session keeps running. The fork runs with the source agent,
// model and pinned system prompt so its requests reuse the source prompt cache.
// When the host supplies a fork_workspace provider, the fork automatically
// works in a freshly provisioned host worktree; without one it stays in the
// source directory.

import { backendChannelId, getAgentBackendProvider } from '../agent-backend/registry.js'
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
  recordSessionForkOrigin,
  setThreadSession,
  setThreadWorkingDirectory,
} from '../database.js'
import {
  resolveTextChannel,
  resolveWorkingDirectory,
  sendThreadMessage,
} from '../discord-utils.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'
import { copySessionPreferences } from './model.js'
import { copySessionSystemPrompt } from '../system-message.js'
import { getOrCreateRuntime } from '../session-handler/runtime-registry.js'
import { AgentBackendError } from '../errors.js'
import { resolveForkWorkspace, forkWorkspaceNotice } from '../fork-workspace.js'
import { doAction } from '../hooks.js'
import { markPendingSessionTitle } from '../session-title.js'
import { replyOrEditInteraction } from '../interaction-reply.js'

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
  const [sessionId, getBackend, textChannel] = await Promise.all([
    getThreadSession(sourceThread.id),
    getAgentBackendProvider().initializeForDirectory(projectDirectory, {
      channelId: backendChannelId(sourceThread),
    }),
    resolveTextChannel(sourceThread),
  ])

  if (!sessionId) {
    return new Error('No active session in this thread')
  }
  if (getBackend instanceof Error) {
    return new Error(`Failed to fork session: ${getBackend.message}`, {
      cause: getBackend,
    })
  }
  if (!textChannel) {
    return new Error('Could not resolve parent text channel')
  }

  const workspace = await resolveForkWorkspace({
    sourceSessionId: sessionId, sourceThreadId: sourceThread.id,
    projectDirectory, sourceDirectory: sdkDirectory, prompt, userId,
    platform: 'discord', spaceId: sourceThread.guildId, channelId: sourceThread.parentId ?? undefined,
  })
  if (workspace instanceof Error) return workspace
  const forkDirectory = workspace.binding?.workingDirectory ?? sdkDirectory
  const forkProjectDirectory = workspace.binding?.projectDirectory ?? projectDirectory

  // Fork and thread creation are independent round trips, so run them together.
  // If either side fails, remove whichever side succeeded.
  const initMs = Date.now() - startedAt
  const backend = getBackend()
  const [forkSettled, threadSettled] = await Promise.allSettled([
    timed(backend.sessions.fork({
      sessionId, directory: sdkDirectory,
      ...(workspace.binding && { targetDirectory: forkDirectory, targetProjectDirectory: forkProjectDirectory }),
      ...(fromMessageId && { messageId: fromMessageId }),
    })),
    timed(textChannel.threads.create({
      name: `Fork: ${sourceThread.name.replace(/^(Fork: |btw: )/, '')}`.slice(0, THREAD_NAME_MAX),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Forked from session ${sessionId}`,
    })),
  ])
  const forkResult = forkSettled.status === 'fulfilled' ? forkSettled.value[0] : undefined
  const forkedSession = forkResult instanceof Error ? undefined : forkResult
  const createdThread = threadSettled.status === 'fulfilled' ? threadSettled.value[0] : undefined
  const cleanup = async () => {
    await Promise.all([
      createdThread?.delete('fork setup failed').catch((error) => {
        forkLogger.warn(`Could not delete orphan fork thread ${createdThread.id}:`, error)
      }),
      forkedSession && backend.sessions
        .delete({ sessionId: forkedSession.id, directory: forkDirectory })
        .then((result) => {
          if (result instanceof Error) forkLogger.warn(`Could not delete orphan fork session ${forkedSession.id}:`, result)
        }),
    ])
    if (workspace.binding) await doAction('fork_workspace_abandoned', { request: workspace.request, binding: workspace.binding })
  }
  if (!forkedSession) {
    await cleanup()
    const cause = forkSettled.status === 'rejected' ? forkSettled.reason : forkResult
    return cause instanceof Error ? cause : new AgentBackendError({ operation: 'session.fork', cause })
  }
  if (!createdThread) {
    await cleanup()
    return new Error('Failed to create the fork thread', {
      cause: threadSettled.status === 'rejected' ? threadSettled.reason : undefined,
    })
  }
  const thread = createdThread
  await markPendingSessionTitle(forkedSession)
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
      getClient: () => backend,
      directory: sdkDirectory,
    }),
    copySessionSystemPrompt({
      sourceSessionId: sessionId,
      targetSessionId: forkedSession.id,
    }),
    backend.sessions.messages({
      sessionId: forkedSession.id,
      directory: forkDirectory,
      limit: 10,
    }),
  ])
  if (copiedSystem instanceof Error) {
    await cleanup()
    return new Error(`Could not copy the source system prompt to the fork: ${copiedSystem.message}`, {
      cause: copiedSystem,
    })
  }

  const copyMs = Date.now() - copyStartedAt
  const trimmedPrompt = prompt?.trim()
  const bindingResult = await Promise.all([
    // DB mapping must complete before dispatch so the thread is routable
    (async () => {
      await setThreadSession(thread.id, forkedSession.id)
      await recordSessionForkOrigin({
        sessionId: forkedSession.id,
        sourceSessionId: sessionId,
        sourceThreadId: sourceThread.id,
      })
      if (workspace.binding) {
        await setThreadWorkingDirectory({ threadId: thread.id, ...workspace.binding })
        return
      }
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
  ]).catch((cause) => new AgentBackendError({ operation: 'fork workspace binding', cause }))
  if (bindingResult instanceof Error) {
    await cleanup()
    return bindingResult
  }
  if (workspace.binding) await sendThreadMessage(thread, forkWorkspaceNotice(workspace.binding))

  forkLogger.log(
    `Created fork session ${forkedSession.id} in thread ${thread.id} from ${sourceThread.id} (session ${sessionId}${fromMessageId ? `, before message ${fromMessageId}` : ''}), system prompt ${copiedSystem ? 'reused' : 'regenerated'}`,
  )
  forkLogger.log(
    `[FORK TIMING] ${forkedSession.id} init=${initMs}ms fork=${forkMs}ms threadCreate=${threadMs}ms copyPrefs=${copyMs}ms total=${Date.now() - startedAt}ms`,
  )

  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory: forkProjectDirectory,
    sdkDirectory: forkDirectory,
    channelId,
    appId,
    sessionId: forkedSession.id,
  })
  if (history instanceof Error) {
    forkLogger.warn('Could not load copied messages for fork cache diagnostics:', history)
  } else {
    const last = history.findLast(({ message }) =>
      message.role === 'assistant' && typeof message.completedAt === 'number',
    )?.message
    if (last) {
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
      titlePrompt: trimmedPrompt,
      prompt: forkedPrompt,
      images,
      userId,
      actorVia,
      username,
      appId,
      mode: 'direct',
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
  if (!interaction.deferred) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  }
  const threadChannel = getThreadChannel(interaction.channel)
  if (threadChannel instanceof Error) {
    await replyOrEditInteraction(interaction, threadChannel.message)
    return
  }

  const resolved = await resolveWorkingDirectory({ channel: threadChannel })
  if (!resolved) {
    await replyOrEditInteraction(interaction, 'Could not determine project directory for this channel')
    return
  }

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
      forkLogger.warn('Fork setup failed:', { sourceThreadId: threadChannel.id, workingDirectory: resolved.workingDirectory, error: result })
      await interaction.editReply(`Failed to fork session: ${result.message}`)
      return
    }
    await interaction.editReply(`Session forked! Continue in ${result.thread.toString()}`)
  } catch (error) {
    forkLogger.error('Error forking session:', { sourceThreadId: threadChannel.id, workingDirectory: resolved.workingDirectory, error })
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
  const getBackend = await getAgentBackendProvider().initializeForDirectory(
    resolved.projectDirectory,
    { channelId: backendChannelId(channel) },
  )
  if (getBackend instanceof Error) {
    await respondEmpty()
    return
  }
  const messages = await getBackend().sessions.messages({
    sessionId,
    directory: resolved.workingDirectory,
  }).catch(() => undefined)
  if (!messages || messages instanceof Error) {
    await respondEmpty()
    return
  }
  const query = interaction.options.getFocused().toLowerCase()
  const choices = messages
    .filter((m) => m.message.role === 'user')
    .flatMap((m) => {
      // Synthetic parts (context, reminders) would clutter the preview.
      const text = m.parts.find((p) => p.kind === 'text' && !p.synthetic)
      if (!text || text.kind !== 'text') return []
      const preview = text.text.replace(/\s+/g, ' ').trim()
      if (!preview) return []
      return [{ preview, id: m.message.id }]
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
