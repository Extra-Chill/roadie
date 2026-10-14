// Debug helper for writing raw backend event stream entries as JSONL.
// When enabled (ROADIE_LOG_SESSION_EVENTS=1), writes one file per session ID
// so event ordering and lifecycle behavior can be analyzed with jq.
//
// Entries hold the backend's native record as-is, tagged with the id of the
// backend that produced it (`backend`) and filed under the agent event's
// session id.

import fs from 'node:fs'
import path from 'node:path'

import { getDataDir } from '../config.js'
import { FilesystemOperationError } from '../errors.js'

let eventLogDirPromise: Promise<string> | null = null
let eventLogWriteDisabled = false

export function isSessionEventLogEnabled(): boolean {
  return process.env['ROADIE_LOG_SESSION_EVENTS'] === '1'
}

function sanitizeSessionIdForFilename(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function resolveEventLogDirectory(): Promise<string> {
  if (!eventLogDirPromise) {
    eventLogDirPromise = (async () => {
      const configuredEventLogDir = process.env['ROADIE_SESSION_EVENTS_DIR']
      const baseDir = configuredEventLogDir || path.join(getDataDir(), 'session-events')
      await fs.promises.mkdir(baseDir, { recursive: true })
      return baseDir
    })()
  }
  return eventLogDirPromise
}

export type SessionEventLogEntry = {
  timestamp: number
  threadId: string
  projectDirectory: string
  /** Which backend produced `event`. Absent for persisted Roadie agent event rows. */
  backend?: string
  event: Record<string, unknown> & { type: string }
}

export function buildSessionEventLogLine({
  timestamp,
  threadId,
  projectDirectory,
  backend,
  event,
}: {
  timestamp: number
  threadId: string
  projectDirectory: string
  backend?: string
  event: unknown
}): SessionEventLogEntry {
  return {
    timestamp,
    threadId,
    projectDirectory,
    ...(backend && { backend }),
    event,
  } as SessionEventLogEntry
}

/**
 * The project directory a persisted session event (a Roadie agent event row)
 * names in `session.directory`. Undefined when the row names no directory.
 */
export function persistedEventProjectDirectory(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined
  const { type } = event as { type?: unknown }
  if (type !== 'session.created' && type !== 'session.updated' && type !== 'session.deleted') return undefined
  const directory = (event as { session?: { directory?: unknown } }).session?.directory
  return typeof directory === 'string' && directory ? directory : undefined
}

export async function appendSessionEventLog(entry: {
  threadId: string
  projectDirectory: string
  /** The backend that produced `event`; untagged records are dropped. */
  backend?: string
  /** The agent event's session id; the record is filed under it. */
  sessionId?: string
  event: unknown
}): Promise<Error | null> {
  if (!isSessionEventLogEnabled() || eventLogWriteDisabled) {
    return null
  }

  const { event, backend, sessionId } = entry
  if (!backend || !sessionId) {
    return null
  }

  const logDirResult = await resolveEventLogDirectory()
    .catch((e) => new FilesystemOperationError({ operation: 'resolveEventLogDir', cause: e }))
  if (logDirResult instanceof Error) {
    eventLogWriteDisabled = true
    return logDirResult
  }

  const logFilePath = path.join(logDirResult, `${sanitizeSessionIdForFilename(sessionId)}.jsonl`)
  const line = `${JSON.stringify(
    buildSessionEventLogLine({
      timestamp: Date.now(),
      threadId: entry.threadId,
      projectDirectory: entry.projectDirectory,
      backend,
      event,
    }),
  )}\n`

  const appendResult = await fs.promises.appendFile(logFilePath, line, 'utf8')
    .catch((e) => new FilesystemOperationError({ operation: 'appendEventLog', cause: e }))
  if (appendResult instanceof Error) {
    eventLogWriteDisabled = true
    return appendResult
  }

  return null
}
