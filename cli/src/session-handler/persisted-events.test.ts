import { describe, expect, test } from 'vitest'
import { parsePersistedEvents, toBufferEvent } from './persisted-events.js'

describe('persisted session events', () => {
  test('agent event rows round-trip unchanged', () => {
    const event = { type: 'status', sessionId: 's1', status: { state: 'idle' } }
    expect(parsePersistedEvents(JSON.stringify(event))).toEqual([event])
    const handoff = { type: 'queue.question-handoff-started', sessionId: 's1' }
    expect(toBufferEvent(handoff)).toEqual(handoff)
  })

  test('a task part row carrying its subagent passes through as written', () => {
    const row = {
      type: 'part',
      part: {
        id: 'p1',
        sessionId: 'parent',
        messageId: 'm1',
        kind: 'tool',
        callId: 'c1',
        tool: 'task',
        status: 'running',
        input: {},
        subagent: { childSessionId: 'child' },
      },
    }
    expect(parsePersistedEvents(JSON.stringify(row))).toEqual([row])
  })

  test('raw rows from a retired backend are skipped', () => {
    expect(parsePersistedEvents(JSON.stringify({ type: 'session.idle', properties: { sessionID: 's1' } }))).toEqual([])
    expect(toBufferEvent({ type: 'queue.question-handoff-started', properties: { sessionID: 's1' } })).toBeUndefined()
  })

  test('malformed rows are skipped, bad JSON is an error', () => {
    expect(parsePersistedEvents(JSON.stringify({ nope: true }))).toEqual([])
    expect(parsePersistedEvents('{nope')).toBeInstanceOf(Error)
    expect(toBufferEvent(null)).toBeUndefined()
  })
})
