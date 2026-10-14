// `send --wait` / `session wait` judge completion and render output from the
// session events the bot persists, never from a backend the CLI starts (#217).
// The streams below are shaped like the bot's normalized events for a Pi
// session (a non-`ses_` id), which the old OpenCode-polling waiter rejected.

import { describe, expect, test } from 'vitest'
import type { AgentEvent, AgentMessage, AgentPart } from './agent-backend/events.js'
import type { EventBufferEntry } from './session-handler/event-stream-state.js'
import { ShareMarkdown } from './markdown.js'
import { persistedMessages, persistedSessionReader, persistedSessionState } from './wait-session.js'

const SESSION = '01a1379e-2d77-7133-9ae0-9a4b45e3ab39'

function stream(events: AgentEvent[]): EventBufferEntry[] {
  return events.map((event, eventIndex) => ({ event, timestamp: 1_000 + eventIndex, eventIndex }))
}

function user(id: string, createdAt: number): AgentEvent {
  return { type: 'message', message: { id, sessionId: SESSION, role: 'user', createdAt } }
}

function assistant(id: string, parentId: string, extra: Partial<AgentMessage> = {}): AgentEvent {
  return { type: 'message', message: { id, sessionId: SESSION, role: 'assistant', createdAt: 2_000, parentId, ...extra } }
}

function text(id: string, messageId: string, value: string): AgentEvent {
  const part: AgentPart = { id, sessionId: SESSION, messageId, kind: 'text', text: value }
  return { type: 'part', part }
}

const busy: AgentEvent = { type: 'status', sessionId: SESSION, status: { state: 'busy' } }
const idle: AgentEvent[] = [{ type: 'status', sessionId: SESSION, status: { state: 'idle' } }, { type: 'idle', sessionId: SESSION }]

function completedTurn(): AgentEvent[] {
  return [
    { type: 'session.created', session: { id: SESSION, title: 'Pi backend rollout check' } },
    user('u1', 5_000),
    busy,
    assistant('a1', 'u1'),
    text('t1', 'u1', 'Rollout check for #732'),
    text('t2', 'a1', 'ROADIE_BACKEND is pi'),
    assistant('a1', 'u1', { completedAt: 6_000, finish: 'stop' }),
    ...idle,
  ]
}

describe('persistedSessionState', () => {
  test('a finished turn on an idle session is complete', () => {
    expect(persistedSessionState({ events: stream(completedTurn()), sessionId: SESSION, waitStartedAtMs: 4_000 })).toBe('complete')
  })

  test('a busy session is still running', () => {
    const events = completedTurn().slice(0, -2)
    expect(persistedSessionState({ events: stream(events), sessionId: SESSION })).toBe('running')
  })

  test('a turn that ended on tool calls is not complete', () => {
    const events = [user('u1', 5_000), assistant('a1', 'u1', { completedAt: 6_000, finish: 'tool-calls' }), ...idle]
    expect(persistedSessionState({ events: stream(events), sessionId: SESSION })).toBe('running')
  })

  test('a turn finished before the wait began does not count', () => {
    expect(persistedSessionState({ events: stream(completedTurn()), sessionId: SESSION, waitStartedAtMs: 9_000 })).toBe('running')
  })

  test('a pending permission keeps the session running', () => {
    const events: AgentEvent[] = [
      ...completedTurn(),
      { type: 'permission.asked', request: { id: 'p1', sessionId: SESSION, permission: 'bash', patterns: ['rm -rf x'], always: [], metadata: {} } },
    ]
    expect(persistedSessionState({ events: stream(events), sessionId: SESSION })).toBe('running')
  })

  test('a busy session parked on a question counts as done', () => {
    const events: AgentEvent[] = [
      user('u1', 5_000),
      busy,
      { type: 'question.asked', request: { id: 'q1', sessionId: SESSION, questions: [{ question: 'Which?', header: 'Pick', options: [] }] } },
    ]
    expect(persistedSessionState({ events: stream(events), sessionId: SESSION })).toBe('question')
  })

  test("another session's events are ignored", () => {
    const other: AgentEvent = { type: 'status', sessionId: 'ses_other', status: { state: 'busy' } }
    expect(persistedSessionState({ events: stream([...completedTurn(), other]), sessionId: SESSION })).toBe('complete')
  })
})

describe('persistedMessages', () => {
  test('keeps the latest version of each message and part', () => {
    const events: AgentEvent[] = [
      user('u1', 1),
      assistant('a1', 'u1'),
      text('t1', 'a1', 'draft'),
      text('t1', 'a1', 'final'),
      assistant('a1', 'u1', { completedAt: 3, finish: 'stop' }),
    ]
    const messages = persistedMessages({ events: stream(events), sessionId: SESSION })
    expect(messages.map((entry) => entry.message.id)).toEqual(['u1', 'a1'])
    expect(messages[1]!.message.finish).toBe('stop')
    expect(messages[1]!.parts).toEqual([expect.objectContaining({ id: 't1', text: 'final' })])
  })

  test('honours removals', () => {
    const events: AgentEvent[] = [
      user('u1', 1),
      text('t1', 'u1', 'keep'),
      text('t2', 'u1', 'drop'),
      { type: 'part.removed', sessionId: SESSION, messageId: 'u1', partId: 't2' },
      user('u2', 2),
      { type: 'message.removed', sessionId: SESSION, messageId: 'u2' },
    ]
    const messages = persistedMessages({ events: stream(events), sessionId: SESSION })
    expect(messages.map((entry) => entry.message.id)).toEqual(['u1'])
    expect(messages[0]!.parts.map((part) => part.id)).toEqual(['t1'])
  })
})

describe('persistedSessionReader', () => {
  test('renders session markdown with no backend', async () => {
    const reader = persistedSessionReader({ events: stream(completedTurn()), sessionId: SESSION })
    const markdown = await new ShareMarkdown(reader).generate({ sessionID: SESSION })
    expect(markdown).not.toBeInstanceOf(Error)
    expect(markdown).toContain('# Pi backend rollout check')
    expect(markdown).toContain('ROADIE_BACKEND is pi')
  })

  test('an unknown session reads as not found', async () => {
    const reader = persistedSessionReader({ events: stream(completedTurn()), sessionId: SESSION })
    expect(await reader.sessions.get({ sessionId: 'ses_unknown' })).toBeUndefined()
  })
})
