// Turn a persisted session event (session_events.event_json) back into event
// buffer entries.
//
// Rows written by the runtime hold Roadie agent events. Rows written before the
// agent event seam hold raw OpenCode events, recognizable by their
// `properties` envelope; those are translated so older sessions still hydrate.
//
// One row can expand into several events: a delegation tool part persisted
// before child-session events existed also implies its child_session_* events.

import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import type { AgentEvent } from '../agent-backend/events.js'
import { toAgentEvents, upgradeLegacyAgentEvent } from '../agent-backend/opencode-events.js'
import type { EventBufferEvent } from './event-stream-state.js'

export function toBufferEvents(raw: unknown): EventBufferEvent[] {
  if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
    return []
  }
  const candidate = raw as { type: string; properties?: { sessionID?: unknown } }
  if (!candidate.properties) {
    if (candidate.type === 'part') {
      return upgradeLegacyAgentEvent(candidate as AgentEvent)
    }
    return [candidate as EventBufferEvent]
  }
  if (candidate.type === 'queue.question-handoff-started') {
    const sessionId = candidate.properties.sessionID
    return typeof sessionId === 'string' ? [{ type: candidate.type, sessionId }] : []
  }
  return toAgentEvents(candidate as OpenCodeEvent)
}

/** The primary event of a persisted row, without implied child-session events. */
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
