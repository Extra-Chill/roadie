// Debug helper for writing raw backend event stream entries as JSONL.
// When enabled, writes one file per session ID so event ordering and
// lifecycle behavior can be analyzed with jq.
//
// Entries hold the backend's raw payload, tagged with the backend id that
// produced it (`backend`): OpenCode events keep their { type, properties }
// envelope; other backends (e.g. Pi) store their native records as-is.

import fs from 'node:fs'
import path from 'node:path'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'

import { getDataDir } from '../config.js'
import { FilesystemOperationError } from '../errors.js'

let eventLogDirPromise: Promise<string> | null = null
let eventLogWriteDisabled = false

export function isOpencodeSessionEventLogEnabled(): boolean {
  return process.env['ROADIE_LOG_OPENCODE_SESSION_EVENTS'] === '1'
}

function sessionIdFromEventProperties(properties: OpenCodeEvent['properties']): string | undefined {
  if (!properties || typeof properties !== 'object') {
    return undefined
  }
  const sessionID = Reflect.get(properties, 'sessionID')
  if (typeof sessionID === 'string') {
    return sessionID
  }
  const info = Reflect.get(properties, 'info')
  if (info && typeof info === 'object') {
    const id = Reflect.get(info, 'id')
    if (typeof id === 'string') {
      return id
    }
    const infoSessionId = Reflect.get(info, 'sessionID')
    if (typeof infoSessionId === 'string') {
      return infoSessionId
    }
  }
  const part = Reflect.get(properties, 'part')
  if (part && typeof part === 'object') {
    const partSessionId = Reflect.get(part, 'sessionID')
    if (typeof partSessionId === 'string') {
      return partSessionId
    }
  }
  return undefined
}

export function getOpencodeEventSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case 'message.updated':
      return event.properties.info.sessionID
    case 'message.part.updated':
      return event.properties.part.sessionID
    case 'message.part.delta':
    case 'message.part.removed':
    case 'session.status':
    case 'session.idle':
    case 'session.diff':
    case 'permission.asked':
    case 'permission.replied':
    case 'question.asked':
    case 'question.replied':
    case 'question.rejected':
      return event.properties.sessionID
    case 'session.error':
      return event.properties.sessionID
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return event.properties.info.id
    default:
      // session.next.* and later SDK events put sessionID on properties.
      return sessionIdFromEventProperties(event.properties)
  }
}

function sanitizeSessionIdForFilename(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function resolveEventLogDirectory(): Promise<string> {
  if (!eventLogDirPromise) {
    eventLogDirPromise = (async () => {
      const configuredEventLogDir = process.env['ROADIE_OPENCODE_SESSION_EVENTS_DIR']
      const baseDir = configuredEventLogDir || path.join(getDataDir(), 'opencode-session-events')
      await fs.promises.mkdir(baseDir, { recursive: true })
      return baseDir
    })()
  }
  return eventLogDirPromise
}

export type OpencodeEventLogEntry = {
  timestamp: number
  threadId: string
  projectDirectory: string
  /** Which backend produced `event`; absent in older files, which hold OpenCode events only. */
  backend?: string
  /** An OpenCode event for backend "opencode"; another backend's raw record as-is. */
  event: OpenCodeEvent | (Record<string, unknown> & { type: string })
}

export function buildOpencodeEventLogLine({
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
}): OpencodeEventLogEntry {
  return {
    timestamp,
    threadId,
    projectDirectory,
    ...(backend && { backend }),
    event,
  } as OpencodeEventLogEntry
}

/**
 * Whether a raw backend payload has OpenCode's event shape. The runtime hands
 * this log the backend's payload as opaque `unknown`; OpenCode payloads are
 * recognized by their envelope, other backends must say who they are.
 */
export function isOpenCodeEvent(event: unknown): event is OpenCodeEvent {
  if (!event || typeof event !== 'object') return false
  const { type, properties } = event as { type?: unknown; properties?: unknown }
  return typeof type === 'string' && Boolean(properties) && typeof properties === 'object'
}

/**
 * The project directory a persisted session event names, in either persisted
 * shape: Roadie agent events (current rows) carry `session.directory`, raw
 * OpenCode events (legacy rows) `properties.info.directory`. Undefined when
 * the row names no directory — never throws on rows of the other shape.
 */
export function persistedEventProjectDirectory(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined
  const { type } = event as { type?: unknown }
  if (type !== 'session.created' && type !== 'session.updated' && type !== 'session.deleted') return undefined
  const { session, properties } = event as {
    session?: { directory?: unknown }
    properties?: { info?: { directory?: unknown } }
  }
  for (const candidate of [session?.directory, properties?.info?.directory]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return undefined
}

export async function appendOpencodeSessionEventLog(
  entry: Omit<OpencodeEventLogEntry, 'timestamp' | 'event'> & {
    event: unknown
    /** The agent event's session id, for raw records that do not name one. */
    sessionId?: string
  },
): Promise<Error | null> {
  if (!isOpencodeSessionEventLogEnabled() || eventLogWriteDisabled) {
    return null
  }

  const { event, backend, sessionId: fallbackSessionId } = entry
  // OpenCode payloads carry their own envelope; any other backend must be
  // tagged with its id, or the provenance of the record is unknown and it
  // is dropped rather than misfiled as an OpenCode event.
  const backendId = backend ?? (isOpenCodeEvent(event) ? 'opencode' : undefined)
  if (!backendId) {
    return null
  }
  const sessionId = (isOpenCodeEvent(event) ? getOpencodeEventSessionId(event) : undefined) ?? fallbackSessionId
  if (!sessionId) {
    return null
  }

  const logDirResult = await resolveEventLogDirectory()
    .catch((e) => new FilesystemOperationError({ operation: 'resolveEventLogDir', cause: e }))
  if (logDirResult instanceof Error) {
    eventLogWriteDisabled = true
    return logDirResult
  }

  const safeSessionId = sanitizeSessionIdForFilename(sessionId)
  const logFilePath = path.join(logDirResult, `${safeSessionId}.jsonl`)

  const now = Date.now()
  const line = `${JSON.stringify(
    buildOpencodeEventLogLine({
      timestamp: now,
      threadId: entry.threadId,
      projectDirectory: entry.projectDirectory,
      backend: backendId,
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
