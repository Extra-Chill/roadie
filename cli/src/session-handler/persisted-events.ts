// Turn a persisted session event (session_events.event_json) back into an
// event buffer entry.
//
// Rows written by the runtime hold Roadie agent events. Rows written before the
// agent event seam hold raw OpenCode events, recognizable by their
// `properties` envelope; those are translated so older sessions still hydrate.

import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { toAgentEvent } from '../agent-backend/opencode-events.js'
import type { EventBufferEvent } from './event-stream-state.js'

export function toBufferEvent(raw: unknown): EventBufferEvent | undefined {
  if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
    return undefined
  }
  const candidate = raw as { type: string; properties?: { sessionID?: unknown } }
  if (!candidate.properties) {
    return candidate as EventBufferEvent
  }
  if (candidate.type === 'queue.question-handoff-started') {
    const sessionId = candidate.properties.sessionID
    return typeof sessionId === 'string' ? { type: candidate.type, sessionId } : undefined
  }
  return toAgentEvent(candidate as OpenCodeEvent)
}

/** Parse one persisted row. Undefined for an event Roadie no longer reads; Error for bad JSON. */
export function parsePersistedEvent(json: string): EventBufferEvent | undefined | Error {
  try {
    return toBufferEvent(JSON.parse(json))
  } catch (error) {
    return new Error('Failed to parse persisted session event JSON', { cause: error })
  }
}
