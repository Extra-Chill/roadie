import { describe, expect, test } from 'vitest'
import type { AgentMessage, AgentPart } from '../agent-backend/events.js'
import { getContinuationTurnOutcome, type EventBufferEntry } from './event-stream-state.js'

const SESSION = 'ses_cont'
const PROMPT = 'Roadie restarted while you were working on this.'

let clock = 1_000

function message(info: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role'>): EventBufferEntry {
  clock += 1
  return {
    timestamp: clock,
    event: { type: 'message', message: { sessionId: SESSION, createdAt: clock, ...info } },
  }
}

type PartInput = AgentPart extends infer P ? P extends AgentPart ? Omit<P, 'sessionId'> : never : never

function part(value: PartInput): EventBufferEntry {
  clock += 1
  return { timestamp: clock, event: { type: 'part', part: { sessionId: SESSION, ...value } as AgentPart } }
}

function userTurn(id: string, text: string): EventBufferEntry[] {
  return [
    message({ id, role: 'user' }),
    part({ id: `${id}-p`, messageId: id, kind: 'text', text }),
  ]
}

function outcome(events: EventBufferEntry[], priorUserMessageIds: ReadonlySet<string> = new Set()) {
  return getContinuationTurnOutcome({ events, sessionId: SESSION, promptText: PROMPT, priorUserMessageIds })
}

const aborted = { name: 'MessageAbortedError', message: 'Aborted' }

describe('getContinuationTurnOutcome', () => {
  test('pending until the continuation prompt shows up', () => {
    expect(outcome([])).toBe('pending')
    expect(outcome([message({ id: 'u1', role: 'user' })])).toBe('pending')
  })

  test('an idle for the turn before the continuation stays pending', () => {
    const earlier = [
      ...userTurn('u0', 'work'),
      message({ id: 'a0', role: 'assistant', parentId: 'u0', error: aborted }),
    ]
    expect(outcome(earlier, new Set(['u0']))).toBe('pending')
  })

  test('an earlier continuation from a previous restart is not this one', () => {
    const earlier = [
      ...userTurn('u0', PROMPT),
      message({ id: 'a0', role: 'assistant', parentId: 'u0', error: aborted }),
    ]
    expect(outcome(earlier, new Set(['u0']))).toBe('pending')
  })

  test('aborted with no output, as in the live incident', () => {
    expect(outcome([
      ...userTurn('u1', PROMPT),
      message({ id: 'a1', role: 'assistant', parentId: 'u1' }),
      message({ id: 'a1', role: 'assistant', parentId: 'u1', completedAt: 2, error: aborted }),
    ])).toBe('aborted-empty')
  })

  test('a turn that never created an assistant message counts as empty', () => {
    expect(outcome(userTurn('u1', PROMPT))).toBe('aborted-empty')
  })

  test('an abort reported as a session error before the message update counts', () => {
    clock += 1
    expect(outcome([
      ...userTurn('u1', PROMPT),
      message({ id: 'a1', role: 'assistant', parentId: 'u1' }),
      { timestamp: clock, event: { type: 'error', sessionId: SESSION, error: aborted } },
    ])).toBe('aborted-empty')
  })

  test('an abort error from before the continuation does not count', () => {
    clock += 1
    expect(outcome([
      { timestamp: clock, event: { type: 'error', sessionId: SESSION, error: aborted } },
      ...userTurn('u1', PROMPT),
      message({ id: 'a1', role: 'assistant', parentId: 'u1', finish: 'stop' }),
    ])).toBe('answered')
  })

  test('any output means the continuation answered, even if it was later aborted', () => {
    expect(outcome([
      ...userTurn('u1', PROMPT),
      message({ id: 'a1', role: 'assistant', parentId: 'u1' }),
      part({ id: 'a1-s', messageId: 'a1', kind: 'step-start' }),
      part({ id: 'a1-t', messageId: 'a1', kind: 'text', text: 'picking up' }),
      message({ id: 'a1', role: 'assistant', parentId: 'u1', error: aborted }),
    ])).toBe('answered')
  })

  test('lifecycle parts alone are not output', () => {
    expect(outcome([
      ...userTurn('u1', PROMPT),
      message({ id: 'a1', role: 'assistant', parentId: 'u1' }),
      part({ id: 'a1-s', messageId: 'a1', kind: 'step-start' }),
      message({ id: 'a1', role: 'assistant', parentId: 'u1', error: aborted }),
    ])).toBe('aborted-empty')
  })

  test('a non-abort error is left to the session error notice', () => {
    expect(outcome([
      ...userTurn('u1', PROMPT),
      message({ id: 'a1', role: 'assistant', parentId: 'u1', error: { name: 'APIError', message: 'overloaded' } }),
    ])).toBe('failed')
  })

  test('a newer user message supersedes the continuation', () => {
    expect(outcome([
      ...userTurn('u1', PROMPT),
      message({ id: 'a1', role: 'assistant', parentId: 'u1', error: aborted }),
      ...userTurn('u2', 'are you there?'),
    ])).toBe('superseded')
  })

  test('only the latest continuation attempt is judged', () => {
    expect(outcome([
      ...userTurn('u1', PROMPT),
      message({ id: 'a1', role: 'assistant', parentId: 'u1', error: aborted }),
      ...userTurn('u2', PROMPT),
      message({ id: 'a2', role: 'assistant', parentId: 'u2' }),
      part({ id: 'a2-t', messageId: 'a2', kind: 'text', text: 'resumed' }),
      message({ id: 'a2', role: 'assistant', parentId: 'u2', finish: 'stop', completedAt: 5 }),
    ])).toBe('answered')
  })
})
