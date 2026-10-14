// Wait utilities for polling session completion.
// Used by `roadie send --wait` and `roadie session wait` to block until a
// session completes (idle, latest turn finished naturally, no pending
// permission) OR pauses for a user question. A session parked on a `question`
// tool never completes on its own, so it is treated as done for automation.
//
// Everything is read from the session events the running bot persists, never
// from an agent backend this process starts. The bot is the one running the
// session: a second backend here cannot see a Pi session (Pi has no shared
// server; a CLI that cannot run `pi` even routed Pi ids to OpenCode, #217),
// and the persisted stream is the same normalized events for every backend.

import type { AgentMessage, AgentSession } from './agent-backend/events.js'
import type { AgentSessionMessage, AgentSessionOperations } from './agent-backend/types.js'
import { parsePersistedEvents } from './session-handler/persisted-events.js'
import { getSessionEventSnapshot, getThreadSession } from './database.js'
import { ShareMarkdown } from './markdown.js'
import { createLogger, LogPrefix } from './logger.js'
import {
  deriveLatestUnansweredQuestion,
  derivePendingPermissionRequests,
  isAssistantMessageNaturalCompletion,
  isSessionBusy,
  type EventBufferEntry,
} from './session-handler/event-stream-state.js'

const waitLogger = createLogger(LogPrefix.SESSION)

/**
 * Poll the roadie database until a session ID appears for the given thread.
 * The bot writes this mapping in session-handler.ts:551 when it picks up
 * the thread and creates/reuses a session.
 */
export async function waitForSessionId({
  threadId,
  timeoutMs = 120_000,
}: {
  threadId: string
  timeoutMs?: number
}): Promise<string> {
  const startTime = Date.now()
  const pollIntervalMs = 2_000

  while (Date.now() - startTime < timeoutMs) {
    const sessionId = await getThreadSession(threadId)
    if (sessionId) {
      waitLogger.log(`Session ID resolved: ${sessionId}`)
      return sessionId
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs)
    })
  }

  throw new Error(
    `Timed out waiting for session ID (thread: ${threadId}, timeout: ${timeoutMs}ms)`,
  )
}

/** Where a session stands, judged from its persisted events alone. */
export type PersistedSessionState = 'complete' | 'question' | 'running'

export function persistedSessionState({
  events,
  sessionId,
  waitStartedAtMs = 0,
}: {
  events: EventBufferEntry[]
  sessionId: string
  waitStartedAtMs?: number
}): PersistedSessionState {
  const busy = isSessionBusy({ events, sessionId })
  // A session parked on a `question` tool stays busy and never completes on
  // its own, so a live question counts as done for automation. Guard on busy:
  // an orphaned question left after an abort (session idle) falls through to
  // the normal completion checks.
  if (busy && deriveLatestUnansweredQuestion({ events, sessionId })) return 'question'
  if (busy) return 'running'
  if (derivePendingPermissionRequests({ events, sessionId }).length > 0) return 'running'
  const messages = persistedMessages({ events, sessionId }).map((entry) => entry.message)
  return hasCompletedUserTurn({ messages, sessionId, waitStartedAtMs }) ? 'complete' : 'running'
}

/**
 * Poll the session events the bot persists until the session is idle, its
 * latest user turn completed naturally, and no permission prompt is pending
 * -- or until the session pauses on a user question.
 */
export async function waitForSessionComplete({
  sessionId,
  timeoutMs = 30 * 60 * 1000,
  waitStartedAtMs = 0,
}: {
  sessionId: string
  timeoutMs?: number
  waitStartedAtMs?: number
}): Promise<void> {
  const pollIntervalMs = 5_000
  const startTime = Date.now()
  let completedSinceMs: number | null = null

  while (Date.now() - startTime < timeoutMs) {
    const events = await loadPersistedSessionEvents({ sessionId })
    const state = persistedSessionState({ events, sessionId, waitStartedAtMs })
    if (state === 'question') {
      waitLogger.log(`Session ${sessionId} is showing a user question; treating as complete`)
      return
    }
    // Stable across one poll: the bot persists events debounced, so a single
    // idle snapshot can precede the turn's last events.
    if (state === 'complete') {
      completedSinceMs ??= Date.now()
      if (Date.now() - completedSinceMs >= pollIntervalMs) {
        waitLogger.log(`Session ${sessionId} completed`)
        return
      }
    } else {
      completedSinceMs = null
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs)
    })
  }

  throw new Error(
    `Timed out waiting for session completion (session: ${sessionId}, timeout: ${timeoutMs}ms)`,
  )
}

/**
 * The session's messages and parts, rebuilt from its persisted events: the
 * latest version of each message and part, in first-seen order.
 */
export function persistedMessages({
  events,
  sessionId,
}: {
  events: EventBufferEntry[]
  sessionId: string
}): AgentSessionMessage[] {
  const messages = new Map<string, AgentSessionMessage>()
  for (const { event } of events) {
    if (event.type === 'message' && event.message.sessionId === sessionId) {
      const existing = messages.get(event.message.id)
      messages.set(event.message.id, { message: event.message, parts: existing?.parts ?? [] })
    } else if (event.type === 'message.removed' && event.sessionId === sessionId) {
      messages.delete(event.messageId)
    } else if (event.type === 'part' && event.part.sessionId === sessionId) {
      const entry = messages.get(event.part.messageId)
      if (!entry) continue
      const index = entry.parts.findIndex((part) => part.id === event.part.id)
      if (index === -1) entry.parts.push(event.part)
      else entry.parts[index] = event.part
    } else if (event.type === 'part.removed' && event.sessionId === sessionId) {
      const entry = messages.get(event.messageId)
      if (entry) entry.parts = entry.parts.filter((part) => part.id !== event.partId)
    }
  }
  return [...messages.values()]
}

/** A read-only session view over persisted events, enough for ShareMarkdown. */
export function persistedSessionReader({
  events,
  sessionId,
}: {
  events: EventBufferEntry[]
  sessionId: string
}): { sessions: Pick<AgentSessionOperations, 'get' | 'messages'> } {
  let session: AgentSession | undefined
  for (const { event } of events) {
    if ((event.type === 'session.created' || event.type === 'session.updated') && event.session.id === sessionId) {
      session = event.session
    }
  }
  const messages = persistedMessages({ events, sessionId })
  return {
    sessions: {
      get: async ({ sessionId: id }) => (id === sessionId ? session ?? { id, title: '' } : undefined),
      messages: async ({ sessionId: id }) => (id === sessionId ? messages : []),
    },
  }
}

export async function waitAndOutputExistingSession({
  sessionId,
  completionTimeoutMs,
  waitStartedAtMs,
}: {
  sessionId: string
  completionTimeoutMs?: number
  waitStartedAtMs?: number
}): Promise<void> {
  waitLogger.log(`Waiting for session ${sessionId} to complete...`)
  await waitForSessionComplete({
    sessionId,
    timeoutMs: completionTimeoutMs,
    waitStartedAtMs,
  })

  await outputSessionMarkdown({ sessionId })
}

async function outputSessionMarkdown({
  sessionId,
}: {
  sessionId: string
}): Promise<void> {
  waitLogger.log('Generating session output...')
  const events = await loadPersistedSessionEvents({ sessionId })
  const markdown = new ShareMarkdown(persistedSessionReader({ events, sessionId }))
  const result = await markdown.generate({ sessionID: sessionId })
  if (result instanceof Error) {
    throw new Error(`Failed to generate session markdown: ${result.message}`, {
      cause: result,
    })
  }

  process.stdout.write(result)
}

export async function loadPersistedSessionEvents({
  sessionId,
}: {
  sessionId: string
}): Promise<EventBufferEntry[]> {
  const rows = await getSessionEventSnapshot({ sessionId })
  return rows.flatMap((row) => {
    const events = parsePersistedEvents(row.event_json)
    if (events instanceof Error) {
      waitLogger.warn(`Skipping invalid persisted session event for ${sessionId}: ${events.message}`)
      return []
    }
    return events.map((event) => ({
      event,
      timestamp: Number(row.timestamp),
      eventIndex: Number(row.event_index),
    }))
  })
}

function hasCompletedUserTurn({
  messages,
  sessionId,
  waitStartedAtMs,
}: {
  messages: AgentMessage[]
  sessionId: string
  waitStartedAtMs: number
}): boolean {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => {
      return message.sessionId === sessionId
        && message.role === 'user'
        && message.createdAt >= waitStartedAtMs
    })
  if (!latestUserMessage) {
    return false
  }

  const latestAssistant = [...messages]
    .reverse()
    .find((message) => {
      return message.sessionId === sessionId
        && message.role === 'assistant'
        && message.parentId === latestUserMessage.id
    })
  if (!latestAssistant) {
    return false
  }

  return isAssistantMessageNaturalCompletion({ message: latestAssistant })
}

/**
 * Wait for session completion and output the session markdown to stdout.
 * Orchestrates the full wait flow: session ID resolution -> completion -> output.
 */
export async function waitAndOutputSession({
  threadId,
  sessionIdTimeoutMs,
  completionTimeoutMs,
  waitStartedAtMs,
}: {
  threadId: string
  sessionIdTimeoutMs?: number
  completionTimeoutMs?: number
  waitStartedAtMs?: number
}): Promise<void> {
  waitLogger.log('Waiting for session ID...')
  const sessionId = await waitForSessionId({
    threadId,
    timeoutMs: sessionIdTimeoutMs,
  })

  waitLogger.log(`Waiting for session ${sessionId} to complete...`)
  await waitForSessionComplete({
    sessionId,
    timeoutMs: completionTimeoutMs,
    waitStartedAtMs,
  })

  await outputSessionMarkdown({ sessionId })
}
