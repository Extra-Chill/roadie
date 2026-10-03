import { describe, expect, test } from 'vitest'
import { parsePersistedEvent, toBufferEvent } from './persisted-events.js'

describe('persisted session events', () => {
  test('rows written before the agent event seam are translated', () => {
    expect(
      parsePersistedEvent(JSON.stringify({ type: 'session.idle', properties: { sessionID: 's1' } })),
    ).toEqual({ type: 'idle', sessionId: 's1' })
    expect(
      parsePersistedEvent(JSON.stringify({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })),
    ).toEqual({ type: 'status', sessionId: 's1', status: { state: 'busy' } })
  })

  test('legacy queue handoff markers keep their session', () => {
    expect(
      toBufferEvent({ type: 'queue.question-handoff-started', properties: { sessionID: 's1' } }),
    ).toEqual({ type: 'queue.question-handoff-started', sessionId: 's1' })
  })

  test('agent event rows round-trip unchanged', () => {
    const event = { type: 'status', sessionId: 's1', status: { state: 'idle' } }
    expect(parsePersistedEvent(JSON.stringify(event))).toEqual(event)
  })

  test('events Roadie no longer reads are skipped, bad JSON is an error', () => {
    expect(parsePersistedEvent(JSON.stringify({ type: 'lsp.updated', properties: {} }))).toBeUndefined()
    expect(parsePersistedEvent('{nope')).toBeInstanceOf(Error)
    expect(toBufferEvent(null)).toBeUndefined()
  })
})
