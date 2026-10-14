// Turn a persisted session event (session_events.event_json) back into event
// buffer entries.
//
// Rows hold Roadie agent events. Rows in any other shape (e.g. a retired
// backend's raw `{ type, properties }` events) are skipped: their sessions
// are retired and never resumed, so nothing reads their history.

import type { EventBufferEvent } from './event-stream-state.js'

export function toBufferEvents(raw: unknown): EventBufferEvent[] {
  if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
    return []
  }
  if ('properties' in raw) {
    return []
  }
  return [raw as EventBufferEvent]
}

/** The primary event of a persisted row. */
export function toBufferEvent(raw: unknown): EventBufferEvent | undefined {
  return toBufferEvents(raw)[0]
}

/** Parse one persisted row. Empty for an event Roadie no longer reads; Error for bad JSON. */
export function parsePersistedEvents(json: string): EventBufferEvent[] | Error {
  try {
    return toBufferEvents(JSON.parse(json))
  } catch (error) {
    return new Error('Failed to parse persisted session event JSON', { cause: error })
  }
}
