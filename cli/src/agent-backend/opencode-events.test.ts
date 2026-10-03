// The OpenCode translator, checked against real recorded sessions.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { agentEventSessionId } from './events.js'
import { toAgentEvent, toAgentError } from './opencode-events.js'

const fixturesDir = path.join(import.meta.dirname, '..', 'session-handler', 'event-stream-fixtures')

function loadFixtureEvents(): OpenCodeEvent[] {
  return fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(fixturesDir, f), 'utf8').split('\n'))
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { event: OpenCodeEvent }).event)
}

const events = loadFixtureEvents()

function sessionIdOf(event: OpenCodeEvent): string | undefined {
  const p = event.properties as Record<string, any>
  return p.sessionID ?? p.info?.sessionID ?? p.info?.id ?? p.part?.sessionID
}

describe('toAgentEvent over recorded sessions', () => {
  test('fixtures cover the main event types', () => {
    const types = new Set(events.map((e) => e.type))
    for (const t of ['message.updated', 'message.part.updated', 'message.part.delta', 'session.status', 'session.idle', 'session.error', 'permission.asked']) {
      expect(types).toContain(t)
    }
  })

  test('every recorded event translates and keeps its session', () => {
    for (const event of events) {
      const translated = toAgentEvent(event)
      expect(translated, event.type).toBeDefined()
      expect(agentEventSessionId(translated!), event.type).toBe(sessionIdOf(event))
    }
  })

  test('parts keep ids, kind and the fields the runtime renders', () => {
    for (const event of events) {
      if (event.type !== 'message.part.updated') continue
      const source = event.properties.part
      const translated = toAgentEvent(event)
      if (translated?.type !== 'part') throw new Error('expected part')
      const part = translated.part
      expect(part.id).toBe(source.id)
      expect(part.messageId).toBe(source.messageID)
      expect(part.kind).toBe(source.type)
      if (part.kind === 'text' && source.type === 'text') expect(part.text).toBe(source.text)
      if (part.kind === 'reasoning' && source.type === 'reasoning') expect(part.text).toBe(source.text)
      if (part.kind === 'tool' && source.type === 'tool') {
        expect(part.tool).toBe(source.tool)
        expect(part.callId).toBe(source.callID)
        expect(part.status).toBe(source.state.status)
        expect(part.input).toEqual(source.state.input)
        if (source.state.status === 'completed') expect(part.output).toBe(source.state.output)
      }
      if (part.kind === 'step-finish' && source.type === 'step-finish') {
        expect(part.usage.input).toBe(source.tokens?.input ?? 0)
        expect(part.usage.cacheRead).toBe(source.tokens?.cache?.read ?? 0)
      }
    }
  })

  test('assistant messages carry usage, model, parent and errors', () => {
    let sawError = false
    for (const event of events) {
      if (event.type !== 'message.updated' || event.properties.info.role !== 'assistant') continue
      const info = event.properties.info
      const translated = toAgentEvent(event)
      if (translated?.type !== 'message') throw new Error('expected message')
      const message = translated.message
      expect(message.parentId).toBe(info.parentID)
      expect(message.model?.modelId).toBe(info.modelID)
      expect(message.usage?.output).toBe(info.tokens?.output ?? 0)
      if (info.error) {
        sawError = true
        expect(message.error?.name).toBe(info.error.name)
      }
    }
    expect(sawError).toBe(true)
  })

  test('status maps busy, idle and retry', () => {
    const statuses = new Set<string>()
    for (const event of events) {
      if (event.type !== 'session.status') continue
      const translated = toAgentEvent(event)
      if (translated?.type !== 'status') throw new Error('expected status')
      statuses.add(translated.status.state)
      expect(translated.status.state).toBe(event.properties.status.type)
    }
    expect(statuses).toContain('busy')
    expect(statuses).toContain('idle')
  })
})

describe('toAgentEvent edge cases', () => {
  test('a step-finish without token counts reports zero usage', () => {
    const translated = toAgentEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p', sessionID: 's', messageID: 'm', type: 'step-finish', reason: 'stop' } },
    } as unknown as OpenCodeEvent)
    expect(translated).toEqual({
      type: 'part',
      part: {
        id: 'p', sessionId: 's', messageId: 'm', kind: 'step-finish', reason: 'stop', cost: 0,
        usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    })
  })

  test('events Roadie does not consume are ignored', () => {
    expect(toAgentEvent({ type: 'lsp.updated', properties: {} } as unknown as OpenCodeEvent)).toBeUndefined()
  })

  test('questions, replies, rejections and toasts translate', () => {
    const asked = toAgentEvent({
      type: 'question.asked',
      properties: {
        id: 'q1',
        sessionID: 's1',
        questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }], multiple: false }],
        tool: { messageID: 'm1', callID: 'c1' },
      },
    } as unknown as OpenCodeEvent)
    expect(asked).toEqual({
      type: 'question.asked',
      request: {
        id: 'q1',
        sessionId: 's1',
        questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }], multiple: false }],
        toolCall: { messageId: 'm1', callId: 'c1' },
      },
    })
    expect(
      toAgentEvent({ type: 'question.replied', properties: { sessionID: 's1', requestID: 'q1', answers: [['A']] } } as unknown as OpenCodeEvent),
    ).toEqual({ type: 'question.replied', sessionId: 's1', requestId: 'q1', answers: [['A']] })
    expect(
      toAgentEvent({ type: 'question.rejected', properties: { sessionID: 's1', requestID: 'q1' } } as unknown as OpenCodeEvent),
    ).toEqual({ type: 'question.rejected', sessionId: 's1', requestId: 'q1' })
    const toast = toAgentEvent({ type: 'tui.toast.show', properties: { message: 'hi', variant: 'warning' } } as unknown as OpenCodeEvent)
    expect(toast).toEqual({ type: 'notice', message: 'hi', level: 'warning' })
    expect(agentEventSessionId(toast!)).toBeUndefined()
  })

  test('retry status keeps attempt, message and next time', () => {
    expect(
      toAgentEvent({
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'retry', attempt: 2, message: 'rate limited', next: 123 } },
      } as unknown as OpenCodeEvent),
    ).toEqual({ type: 'status', sessionId: 's1', status: { state: 'retry', attempt: 2, message: 'rate limited', nextAt: 123 } })
  })

  test('errors normalize name, message and API details', () => {
    expect(toAgentError({ name: 'APIError', data: { message: 'boom', statusCode: 429, isRetryable: true } })).toEqual({
      name: 'APIError',
      message: 'boom',
      statusCode: 429,
      retryable: true,
    })
    expect(toAgentError({ name: 'MessageAbortedError', data: {} })).toEqual({ name: 'MessageAbortedError', message: 'MessageAbortedError' })
    expect(toAgentError(undefined)).toBeUndefined()
  })
})
