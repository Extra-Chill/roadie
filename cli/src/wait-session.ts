// Wait utilities for polling session completion.
// Used by `roadie send --wait` and `roadie session wait` to block until a
// session completes (idle, latest turn finished naturally, no pending
// permission) OR pauses for a user question. A session parked on a `question`
// tool never completes on its own, so it is treated as done for automation.

import type { AgentMessage } from './agent-backend/events.js'
import { getAgentBackendProvider } from './agent-backend/registry.js'
import { parsePersistedEvents } from './session-handler/persisted-events.js'
import { getSessionEventSnapshot, getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { ShareMarkdown } from './markdown.js'
import { createLogger, LogPrefix } from './logger.js'
import {
  derivePendingPermissionRequests,
  isAssistantMessageNaturalCompletion,
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

/**
 * Poll the OpenCode SDK and persisted Roadie events until the session is idle,
 * its latest user turn completed naturally, and no permission prompt is pending
 * -- or until the session pauses on a user question (which never completes on
 * its own and is treated as done for automation).
 */
export async function waitForSessionComplete({
  projectDirectory,
  sessionId,
  timeoutMs = 30 * 60 * 1000,
  waitStartedAtMs = 0,
}: {
  projectDirectory: string
  sessionId: string
  timeoutMs?: number
  waitStartedAtMs?: number
}): Promise<void> {
  const pollIntervalMs = 5_000
  const startTime = Date.now()
  let completedSinceMs: number | null = null

  const getBackend = await getAgentBackendProvider().initializeForDirectory(projectDirectory)
  if (getBackend instanceof Error) {
    throw new Error(
      `Failed to connect to OpenCode server: ${getBackend.message}`,
      {
        cause: getBackend,
      },
    )
  }

  while (Date.now() - startTime < timeoutMs) {
    const statuses = await getBackend().sessions.status({
      directory: projectDirectory,
    })
    if (statuses instanceof Error) {
      throw new Error('Failed to check session status', { cause: statuses })
    }
    const sessionStatus = statuses[sessionId]
    const isBusy = Boolean(sessionStatus && sessionStatus.state !== 'idle')

    // A session parked on a `question` tool reports busy but will never complete
    // on its own, so treat a live question as done for automation and stop
    // waiting. Guard on `busy`: an orphaned question left after an abort
    // (session idle) must fall through to the normal idle/completion checks
    // instead of returning early.
    if (isBusy) {
      const questions = await getBackend().sessions.questions?.({ directory: projectDirectory })
      const hasPendingQuestion = (questions instanceof Error ? [] : questions ?? []).some((request) => {
        return request.sessionId === sessionId
      })
      if (hasPendingQuestion) {
        waitLogger.log(`Session ${sessionId} is showing a user question; treating as complete`)
        return
      }
    }

    const messagesResult = await getBackend().sessions.messages({
      sessionId,
      directory: projectDirectory,
    })
    const messages = messagesResult instanceof Error ? [] : messagesResult.map((entry) => entry.message)
    const events = await loadPersistedSessionEvents({ sessionId })
    const pendingPermissions = derivePendingPermissionRequests({
      events,
      sessionId,
    })

    const isIdle = !sessionStatus || sessionStatus.state === 'idle'
    const hasPendingPermissions = pendingPermissions.length > 0
    const hasCompletedTurn = hasCompletedUserTurn({
      messages,
      sessionId,
      waitStartedAtMs,
    })

    if (isIdle && hasCompletedTurn && !hasPendingPermissions) {
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

export async function waitAndOutputExistingSession({
  sessionId,
  projectDirectory,
  completionTimeoutMs,
  waitStartedAtMs,
}: {
  sessionId: string
  projectDirectory: string
  completionTimeoutMs?: number
  waitStartedAtMs?: number
}): Promise<void> {
  waitLogger.log(`Waiting for session ${sessionId} to complete...`)
  await waitForSessionComplete({
    projectDirectory,
    sessionId,
    timeoutMs: completionTimeoutMs,
    waitStartedAtMs,
  })

  await outputSessionMarkdown({ sessionId, projectDirectory })
}

async function outputSessionMarkdown({
  sessionId,
  projectDirectory,
}: {
  sessionId: string
  projectDirectory: string
}): Promise<void> {
  waitLogger.log('Generating session output...')
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    throw new Error(
      `Failed to connect to OpenCode server: ${getClient.message}`,
      {
        cause: getClient,
      },
    )
  }

  const markdown = new ShareMarkdown(getClient())
  const result = await markdown.generate({ sessionID: sessionId })
  if (result instanceof Error) {
    throw new Error(`Failed to generate session markdown: ${result.message}`, {
      cause: result,
    })
  }

  process.stdout.write(result)
}

async function loadPersistedSessionEvents({
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
  projectDirectory,
  sessionIdTimeoutMs,
  completionTimeoutMs,
  waitStartedAtMs,
}: {
  threadId: string
  projectDirectory: string
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
    projectDirectory,
    sessionId,
    timeoutMs: completionTimeoutMs,
    waitStartedAtMs,
  })

  await outputSessionMarkdown({ sessionId, projectDirectory })
}
