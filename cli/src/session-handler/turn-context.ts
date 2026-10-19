// Turn-context resolution for one thread runtime.
// Builds the pinned per-session system prompt (with scheduled-task info and
// session_start host context) and the per-turn host context sent when the
// speaker changes. Plain functions over explicit inputs; the runtime owns the
// caches and passes them in.

import type { ChatThread } from '../chat-platform/types.js'
import { channelContextBinding } from '../channel-policy.js'
import {
  isContextProviderConfigured,
  renderContextSections,
  requestContext,
  speakerKey,
} from '../context-provider.js'
import { getScheduledTask, getSessionStartSource } from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  getSystemMessage,
  resolveSessionSystemPrompt,
  type AgentInfo,
  type ScheduledTaskSystemContext,
} from '../system-message.js'
import type * as threadState from './thread-runtime-state.js'

const logger = createLogger(LogPrefix.SESSION)

/**
 * Resolve the scheduled-task context for the system message, once per
 * session. The row in session_start_sources is immutable, so caching the
 * result keeps the system prompt identical across turns (prompt-cache safe).
 * One-shot 'at' tasks are deleted after their run, so only schedule_kind
 * survives for them.
 */
export async function resolveScheduledTaskContext({
  sessionId,
  cache,
}: {
  sessionId: string
  cache: Map<string, ScheduledTaskSystemContext | undefined>
}): Promise<ScheduledTaskSystemContext | undefined> {
  if (cache.has(sessionId)) {
    return cache.get(sessionId)
  }
  const context = await (async (): Promise<
    ScheduledTaskSystemContext | undefined
  > => {
    const source = await getSessionStartSource({ sessionId })
    if (!source) {
      return undefined
    }
    const task = source.scheduled_task_id
      ? await getScheduledTask(source.scheduled_task_id)
      : null
    return {
      taskId: source.scheduled_task_id ?? undefined,
      scheduleKind: source.schedule_kind,
      cronExpr: task?.cron_expr,
      timezone: task?.timezone,
    }
  })().catch((error) => {
    logger.warn(
      `[SCHEDULED TASK CONTEXT] Failed to resolve for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  })
  cache.set(sessionId, context)
  return context
}

function contextSpeaker({
  platform,
  input,
}: {
  platform: ChatThread['platform']
  input: { userId?: string; username?: string; personId?: string; actorVia?: 'chat' | 'cli' }
}) {
  if (!input.userId || (input.actorVia ?? 'chat') !== 'chat') return {}
  return {
    actor: {
      platform,
      id: input.userId,
      ...(input.username ? { name: input.username } : {}),
    },
    ...(input.personId ? { personId: input.personId } : {}),
  }
}

/**
 * Per-turn host context, fetched only when the speaker differs from the
 * previous turn's. First/reconstructed turns have no successful speaker
 * lookup, so they fetch too. Shared session context carries no speaker.
 */
export async function resolveTurnContext({
  sessionId,
  input,
  chat,
  threadId,
  runtimeThreadId,
  channelId,
  directory,
  lastSpeakerKey,
  setLastSpeakerKey,
}: {
  sessionId: string
  input: { userId?: string; username?: string; personId?: string; actorVia?: 'chat' | 'cli'; contextOnly?: boolean }
  isFirstTurn: boolean
  chat: ChatThread
  /** Id of the platform thread object. */
  threadId: string
  /** Id the runtime is registered under; fallback for the channel binding. */
  runtimeThreadId: string
  channelId: string | undefined
  directory: string
  /** Speaker key of the last turn we fetched per-turn host context for. */
  lastSpeakerKey: string | undefined
  setLastSpeakerKey: (key: string) => void
}): Promise<string> {
  if (input.contextOnly || !isContextProviderConfigured()) return ''
  const speaker = contextSpeaker({ platform: chat.platform, input })
  const key = speakerKey(speaker)
  const previous = lastSpeakerKey
  if (previous === key) return ''
  if (key === 'none') {
    setLastSpeakerKey(key)
    return ''
  }
  const sections = await requestContext({
    event: 'turn',
    sessionId,
    spaceId: chat.spaceId ?? undefined,
    threadId,
    channelId,
    directory,
    ...channelContextBinding(channelId || runtimeThreadId),
    ...speaker,
  })
  // Empty/error responses are not a successful refresh. Retry on the next
  // turn rather than permanently caching the failed speaker lookup.
  if (sections.length > 0) setLastSpeakerKey(key)
  return renderContextSections(sections)
}

/**
 * Pinned system prompt for this turn. Generated only on the first turn of a
 * session; forks start with the source session's pinned prompt.
 */
export async function resolveTurnSystemPrompt({
  sessionId,
  channelTopic,
  agents,
  input,
  chat,
  threadId,
  runtimeThreadId,
  channelId,
  directory,
  getState,
  scheduledTaskContextCache,
}: {
  sessionId: string
  channelTopic: string | undefined
  agents: AgentInfo[]
  input: { username?: string; userId?: string; parentSessionId?: string }
  chat: ChatThread
  /** Id of the platform thread object. */
  threadId: string
  /** Id the runtime is registered under; fallback for the channel binding. */
  runtimeThreadId: string
  channelId: string | undefined
  directory: string
  getState: () => threadState.ThreadRunState | undefined
  scheduledTaskContextCache: Map<string, ScheduledTaskSystemContext | undefined>
}) {
  return resolveSessionSystemPrompt({
    sessionId,
    generate: async () => {
      const base = getSystemMessage({
        platform: chat.platform,
        sessionId,
        channelId,
        guildId: chat.spaceId ?? undefined,
        threadId,
        channelTopic,
        agents,
        username: getState()?.sessionUsername || input.username,
        userId: getState()?.sessionUserId || input.userId,
        parentSessionId: getState()?.parentSessionId || input.parentSessionId,
        scheduledTask: await resolveScheduledTaskContext({
          sessionId,
          cache: scheduledTaskContextCache,
        }),
      })
      // Host context for the whole session, pinned with the prompt so it
      // stays cache-stable across turns.
      const sections = await requestContext({
        event: 'session_start',
        sessionId,
        spaceId: chat.spaceId ?? undefined,
        threadId,
        channelId,
        directory,
        ...channelContextBinding(channelId || runtimeThreadId),
      })
      return base + renderContextSections(sections)
    },
  })
}
