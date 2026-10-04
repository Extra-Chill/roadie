import { describe, expect, test } from 'vitest'
import { parsePersistedEvents, toBufferEvent } from './persisted-events.js'

describe('persisted session events', () => {
  test('rows written before the agent event seam are translated', () => {
    expect(
      parsePersistedEvents(JSON.stringify({ type: 'session.idle', properties: { sessionID: 's1' } })),
    ).toEqual([{ type: 'idle', sessionId: 's1' }])
    expect(
      parsePersistedEvents(JSON.stringify({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })),
    ).toEqual([{ type: 'status', sessionId: 's1', status: { state: 'busy' } }])
  })

  test('legacy queue handoff markers keep their session', () => {
    expect(
      toBufferEvent({ type: 'queue.question-handoff-started', properties: { sessionID: 's1' } }),
    ).toEqual({ type: 'queue.question-handoff-started', sessionId: 's1' })
  })

  test('agent event rows round-trip unchanged', () => {
    const event = { type: 'status', sessionId: 's1', status: { state: 'idle' } }
    expect(parsePersistedEvents(JSON.stringify(event))).toEqual([event])
  })

  test('events Roadie no longer reads are skipped, bad JSON is an error', () => {
    expect(parsePersistedEvents(JSON.stringify({ type: 'lsp.updated', properties: {} }))).toEqual([])
    expect(parsePersistedEvents('{nope')).toBeInstanceOf(Error)
    expect(toBufferEvent(null)).toBeUndefined()
  })

  test('a raw OpenCode task part row expands into its child-session event', () => {
    const row = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p1',
          sessionID: 'parent',
          messageID: 'm1',
          type: 'tool',
          callID: 'c1',
          tool: 'task',
          state: {
            status: 'running',
            input: { subagent_type: 'explore', description: 'map the repo' },
            metadata: { sessionId: 'child' },
            time: { start: 1 },
          },
        },
      },
    }
    const events = parsePersistedEvents(JSON.stringify(row))
    expect(events).not.toBeInstanceOf(Error)
    const [part, started] = events as Exclude<typeof events, Error>
    expect(part).toMatchObject({
      type: 'part',
      part: { tool: 'task', subagent: { childSessionId: 'child', agent: 'explore', description: 'map the repo' } },
    })
    expect(started).toEqual({
      type: 'child_session_started',
      parentSessionId: 'parent',
      childSessionId: 'child',
      agent: 'explore',
      description: 'map the repo',
      status: 'running',
      messageId: 'm1',
    })
  })

  test('an agent part row written before the subagent field gains it and its child-session event', () => {
    const row = {
      type: 'part',
      part: {
        id: 'p1',
        sessionId: 'parent',
        messageId: 'm1',
        kind: 'tool',
        callId: 'c1',
        tool: 'task',
        status: 'completed',
        input: { subagent_type: 'general' },
        metadata: { sessionId: 'child' },
      },
    }
    const events = parsePersistedEvents(JSON.stringify(row)) as Exclude<ReturnType<typeof parsePersistedEvents>, Error>
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'part', part: { subagent: { childSessionId: 'child', agent: 'general' } } })
    expect(events[1]).toMatchObject({ type: 'child_session_finished', parentSessionId: 'parent', childSessionId: 'child', status: 'completed' })
  })

  test('an agent part row that already carries subagent is not expanded again', () => {
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
})
