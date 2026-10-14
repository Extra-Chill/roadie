import { describe, expect, test } from 'vitest'
import type { EventBufferEntry, EventBufferEvent } from './event-stream-state.js'
import { ThreadSessionRuntime } from './thread-session-runtime.js'
import type { AgentEvent, AgentMessage, AgentPart } from '../agent-backend/events.js'

type RuntimeInternals = {
  state?: { sessionId: string }
  eventBuffer: EventBufferEntry[]
  partBuffer: Map<string, Map<string, AgentPart>>
  compactEventForEventBuffer: (event: EventBufferEvent) => EventBufferEvent | undefined
  flushBufferedParts: () => Promise<void>
  handleMessageUpdated: (message: AgentMessage) => Promise<void>
  handlePartUpdated: (part: AgentPart) => Promise<void>
  handleNaturalAssistantCompletion: () => Promise<void>
  handleMainPart: (part: AgentPart) => Promise<void>
  handleSubtaskPart: (part: AgentPart) => Promise<void>
}

function summaryMessage({
  sessionId,
  messageId,
}: {
  sessionId: string
  messageId: string
}): AgentMessage {
  return {
    id: messageId,
    sessionId,
    role: 'assistant',
    parentId: 'msg_user',
    createdAt: 2,
    completedAt: 3,
    model: { providerId: 'test-provider', modelId: 'compaction-model' },
    agent: 'compaction',
    cost: 1,
    usage: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    finish: 'stop',
    summary: true,
  }
}

function summaryMessageEvent(input: { sessionId: string; messageId: string }): AgentEvent {
  return { type: 'message', message: summaryMessage(input) }
}

function summaryTextPart({
  sessionId,
  messageId,
}: {
  sessionId: string
  messageId: string
}): AgentPart {
  return {
    id: `prt_${messageId}`,
    sessionId,
    messageId,
    kind: 'text',
    text: 'internal compaction summary must not reach Discord',
    startedAt: 2,
    endedAt: 3,
  }
}

describe('ThreadSessionRuntime compaction summary routing', () => {
  test('drops summary message parts before fallback buffering or completion', async () => {
    const sessionId = 'ses_main'
    const messageId = 'msg_summary_embedded_parts'
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    Object.defineProperty(runtime, 'state', {
      value: { sessionId },
      configurable: true,
    })
    runtime.eventBuffer = [{ event: summaryMessageEvent({ sessionId, messageId }), timestamp: 1 }]
    runtime.partBuffer = new Map()
    runtime.flushBufferedParts = async () => {
      throw new Error('Summary message must not flush parts')
    }
    runtime.handleNaturalAssistantCompletion = async () => {
      throw new Error('Summary message must not complete the Discord turn')
    }

    await runtime.handleMessageUpdated(summaryMessage({ sessionId, messageId }))

    expect(runtime.partBuffer.size).toBe(0)
  })

  test.each([
    ['main session', 'ses_main'],
    ['subagent session', 'ses_child'],
  ])('preserves summary identity and drops %s parts before buffering', async (_, sessionId) => {
    const messageId = `msg_summary_${sessionId}`
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    const compacted = runtime.compactEventForEventBuffer(
      summaryMessageEvent({ sessionId, messageId }),
    )

    expect(compacted?.type).toBe('message')
    if (!compacted || compacted.type !== 'message') {
      throw new Error('Expected compacted summary message event')
    }
    expect(compacted.message.summary).toBe(true)

    runtime.eventBuffer = [{ event: compacted, timestamp: 1 }]
    runtime.partBuffer = new Map()

    await runtime.handlePartUpdated(summaryTextPart({ sessionId, messageId }))

    expect(runtime.partBuffer.size).toBe(0)
  })

  test.each([
    ['main session', 'ses_main'],
    ['subagent session', 'ses_child'],
  ])('holds %s parts until summary identity arrives, then drops them', async (_, sessionId) => {
    const messageId = `msg_summary_unknown_${sessionId}`
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    Object.defineProperty(runtime, 'state', {
      value: { sessionId: 'ses_main' },
      configurable: true,
    })
    runtime.eventBuffer = []
    runtime.partBuffer = new Map()
    runtime.handleMainPart = async () => {
      throw new Error('Unknown summary parts must not render')
    }
    runtime.handleSubtaskPart = async () => {
      throw new Error('Unknown summary parts must not render')
    }
    runtime.flushBufferedParts = async () => {
      throw new Error('Summary message must not flush parts')
    }
    runtime.handleNaturalAssistantCompletion = async () => {
      throw new Error('Summary message must not complete the Discord turn')
    }

    await runtime.handlePartUpdated(summaryTextPart({ sessionId, messageId }))

    expect(runtime.partBuffer.get(messageId)?.size).toBe(1)

    await runtime.handleMessageUpdated(summaryMessage({ sessionId, messageId }))

    expect(runtime.partBuffer.size).toBe(0)
  })
})
