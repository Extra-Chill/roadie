import { describe, expect, test } from 'vitest'
import type { AgentMessage, AgentPart } from '../agent-backend/events.js'
import { formatContextBreakdown } from './context-usage.js'

type PartBody = AgentPart extends infer P ? P extends AgentPart ? Omit<P, 'id' | 'sessionId' | 'messageId'> : never : never

const part = (messageId: string, value: PartBody): AgentPart => ({
  id: `part-${messageId}`,
  sessionId: 'session',
  messageId,
  ...value,
} as AgentPart)

const user = (id: string, system?: string): AgentMessage => ({
  id, sessionId: 'session', role: 'user', createdAt: 1,
  agent: 'build', model: { providerId: 'test', modelId: 'test' }, ...(system !== undefined && { system }),
})

const assistant = (id: string, input: number): AgentMessage => ({
  id, sessionId: 'session', role: 'assistant', createdAt: 2,
  parentId: 'user', model: { providerId: 'test', modelId: 'test' },
  agent: 'build', cost: 0,
  usage: { input, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
})

describe('formatContextBreakdown', () => {
  test('attributes tool call inputs and outputs by type, and excludes the response to the measured prompt', () => {
    const messages = [
      { message: user('user', 's'.repeat(40)), parts: [part('user', { kind: 'text', text: 'u'.repeat(20) })] },
      { message: assistant('first', 20), parts: [
        part('first', {
          kind: 'tool', tool: 'read', callId: 'call', status: 'completed',
          input: { filePath: 'a'.repeat(28) }, output: 'o'.repeat(40),
          title: 'read', metadata: {}, startedAt: 1, endedAt: 2,
        }),
      ] },
      { message: assistant('last', 50), parts: [part('last', { kind: 'text', text: 'x'.repeat(800) })] },
    ]

    expect(formatContextBreakdown({ messages, lastAssistantId: 'last', inputTokens: 50 }))
      .toMatchInlineSnapshot(`"**Estimated input mix:** tool read 42.0% (21) · system 20.0% (10) · other 38.0% (19) tokens (other includes messages and unexposed prompts)"`)
  })

  test('ignores compacted history and old tool outputs', () => {
    const messages = [
      { message: user('old', 'x'.repeat(800)), parts: [part('old', { kind: 'text', text: 'x'.repeat(800) })] },
      { message: assistant('old-answer', 30), parts: [part('old-answer', {
        kind: 'tool', tool: 'bash', callId: 'old', status: 'completed',
        input: {}, output: 'x'.repeat(800), title: 'old', metadata: {},
        startedAt: 1, endedAt: 2, compactedAt: 3,
      })] },
      { message: user('compact'), parts: [part('compact', { kind: 'other', type: 'compaction' })] },
      { message: assistant('summary', 20), parts: [part('summary', { kind: 'text', text: 'summary'.repeat(8) })] },
      { message: user('new', 's'.repeat(20)), parts: [part('new', { kind: 'text', text: 'u'.repeat(20) })] },
      { message: assistant('last', 40), parts: [] },
    ]

    expect(formatContextBreakdown({ messages, lastAssistantId: 'last', inputTokens: 40 }))
      .toMatchInlineSnapshot(`"**Estimated input mix:** system 12.5% (5) · other 87.5% (35) tokens (other includes messages and unexposed prompts)"`)
  })
})
