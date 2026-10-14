// Fixture-driven tests for pure event-stream derivation helpers.
// Focuses on assistant message completion boundaries instead of session.idle.
//
// Fixtures in ./event-stream-fixtures are recorded real session streams, held
// as Roadie agent events ({ timestamp, event } per line) — what the runtime
// buffers whatever backend produced them. Inline events use the builders
// below, which take Roadie field names.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { childSessionEventsForPart, type AgentError, type AgentMessage, type AgentPart, type AgentUsage } from '../agent-backend/events.js'
import * as state from './event-stream-state.js'
import { formatPromptCacheClearMessage } from './event-stream-state.js'

type EventBufferEntry = state.EventBufferEntry

const {
  derivePendingPermissionRequests,
  getAssistantMessageIdsForLatestUserTurn,
  getDerivedSubagentSessions,
  getCurrentTurnStartTime,
  getDerivedSubtaskIndex,
  getDerivedSubtaskLabel,
  getLatestAssistantMessageIdForLatestUserTurn,
  getLatestRunInfo,
  getLatestTurnTokenUsage,
  getPromptCacheClear,
  getIdleTokenUsageDelta,
  getTokenUsageSessionIdsForIdle,
  isDerivedChildSession,
  hasAssistantMessageCompletedBefore,
  doesLatestUserTurnHaveNaturalCompletion,
  isAssistantMessageInLatestUserTurn,
  isAssistantMessageNaturalCompletion,
  getAssistantMessageKind,
  getLatestUserMessage,
  isSummaryAssistantMessage,
  isSessionBusy,
  isAssistantTextReadyForQuestion,
  deriveLatestUnansweredQuestion,
  shouldBufferSessionEvent,
  shouldRetainSessionEvent,
  trimEventBuffer,
  getEventBufferSessionId,
} = state

const fixturesDir = path.join(import.meta.dirname, 'event-stream-fixtures')
type AssistantMessage = AgentMessage & { role: 'assistant' }

function loadFixture(filename: string): EventBufferEntry[] {
  const content = fs.readFileSync(path.join(fixturesDir, filename), 'utf8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EventBufferEntry)
}

function getSessionId(events: EventBufferEntry[]): string {
  for (const entry of events) {
    const sessionId = getEventBufferSessionId(entry.event)
    if (sessionId) {
      return sessionId
    }
  }
  throw new Error('No sessionId found in fixture')
}

function getAssistantMessages(events: EventBufferEntry[], sessionId: string) {
  const messagesById = new Map<string, AssistantMessage>()
  events.forEach((entry) => {
    if (entry.event.type !== 'message') {
      return
    }
    const message = entry.event.message
    if (message.sessionId !== sessionId || message.role !== 'assistant') {
      return
    }
    messagesById.set(message.id, message as AssistantMessage)
  })
  return [...messagesById.values()]
}

function getAssistantMessageById({
  events,
  sessionId,
  messageId,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
}): AssistantMessage {
  const message = getAssistantMessages(events, sessionId).find((candidate) => {
    return candidate.id === messageId
  })
  if (!message) {
    throw new Error(`Assistant message ${messageId} not found`)
  }
  return message
}

function eventEntry(event: state.EventBufferEvent, timestamp = 1): EventBufferEntry {
  return { event, timestamp }
}

function usage(partial: Partial<AgentUsage> = {}): AgentUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...partial }
}

function userMessage(message: Omit<AgentMessage, 'role'>): EventBufferEntry {
  return eventEntry({ type: 'message', message: { ...message, role: 'user' } })
}

function assistantMessage(message: Omit<AgentMessage, 'role'>): EventBufferEntry {
  return eventEntry({ type: 'message', message: { ...message, role: 'assistant' } })
}

function partEvent(part: AgentPart): EventBufferEntry {
  return eventEntry({ type: 'part', part })
}

type ToolPart = Extract<AgentPart, { kind: 'tool' }>

/** A task tool part event plus the child-session events it implies, as a backend emits them. */
function delegation(part: ToolPart, timestamp = 1): EventBufferEntry[] {
  return [
    eventEntry({ type: 'part', part }, timestamp),
    ...childSessionEventsForPart(part).map((event) => eventEntry(event, timestamp)),
  ]
}

function findTaskPart(events: EventBufferEntry[], predicate: (part: ToolPart) => boolean): ToolPart {
  for (const entry of events) {
    const part = entry.event.type === 'part' ? entry.event.part : undefined
    if (part?.kind === 'tool' && part.tool === 'task' && predicate(part)) {
      return structuredClone(part)
    }
  }
  throw new Error('Expected to find task tool event in fixture')
}

function findAssistantCompletionEventIndex({
  events,
  sessionId,
  messageId,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
}): number {
  const index = events.findIndex((entry) => {
    if (entry.event.type !== 'message') {
      return false
    }
    const message = entry.event.message
    return message.sessionId === sessionId
      && message.role === 'assistant'
      && message.id === messageId
      && typeof message.completedAt === 'number'
  })
  if (index === -1) {
    throw new Error(`Completed assistant message ${messageId} not found`)
  }
  return index
}

describe('session-normal-completion', () => {
  const events = loadFixture('session-normal-completion.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('latest assistant message completes naturally', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(true)
  })

  test('latest user turn start time comes from the latest user message', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636294845)
  })

  test('completion history only appears after the completed update lands', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const completionIndex = findAssistantCompletionEventIndex({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(hasAssistantMessageCompletedBefore({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
      upToIndex: completionIndex - 1,
    })).toBe(false)
    expect(hasAssistantMessageCompletedBefore({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })).toBe(true)
  })

  test('completion history survives later non-completed duplicate updates', () => {
    const messageId = 'msg_duplicate_completion'
    const model = { providerId: 'deterministic-provider', modelId: 'deterministic-v2' }
    const duplicateEvents: EventBufferEntry[] = [
      assistantMessage({
        id: messageId,
        sessionId,
        createdAt: 1,
        completedAt: 2,
        parentId: 'msg_user',
        agent: 'build',
        model,
        cost: 0,
        usage: usage({ input: 1, output: 1 }),
        finish: 'stop',
      }),
      assistantMessage({
        id: messageId,
        sessionId,
        createdAt: 1,
        parentId: 'msg_user',
        agent: 'build',
        model,
        cost: 0,
        finish: 'stop',
      }),
    ]

    expect(hasAssistantMessageCompletedBefore({
      events: duplicateEvents,
      sessionId,
      messageId,
    })).toBe(true)
  })

  test('getLatestRunInfo', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'deterministic-v2',
      providerID: 'deterministic-provider',
      agent: 'build',
      tokensUsed: 2,
    })
  })
})

describe('derivePendingPermissionRequests', () => {
  test('tracks unresolved permission requests', () => {
    const sessionId = 'ses_pending_permission'
    const events = [
      eventEntry({
        type: 'permission.asked',
        request: { id: 'perm_1', sessionId, permission: 'bash', patterns: ['*'], always: [], metadata: {} },
      }),
      eventEntry({
        type: 'permission.asked',
        request: { id: 'perm_2', sessionId, permission: 'edit', patterns: ['src/**'], always: [], metadata: {} },
      }),
      eventEntry({ type: 'permission.replied', sessionId, requestId: 'perm_1', reply: 'once' }),
    ]

    expect(derivePendingPermissionRequests({ events, sessionId })).toMatchInlineSnapshot(`
      [
        "perm_2",
      ]
    `)
  })
})

describe('session-explicit-abort', () => {
  const events = loadFixture('session-explicit-abort.jsonl')
  const sessionId = getSessionId(events)
  const assistantMessages = getAssistantMessages(events, sessionId)
  const latestAssistant = assistantMessages[assistantMessages.length - 1]

  test('aborted assistant message is not a natural completion', () => {
    if (!latestAssistant) {
      throw new Error('Expected assistant message in fixture')
    }
    expect(isAssistantMessageNaturalCompletion({ message: latestAssistant })).toBe(false)
  })
})

describe('session-user-interruption', () => {
  const events = loadFixture('session-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const firstAssistantId = 'msg_cb95be135001I1vqtzLtT4Q1iQ'
  const slowSleepAssistantId = 'msg_cb95be39e001huREyY2wfjgV1M'
  const followupAssistantId = 'msg_cb95beeb8001MuEOER9WprXsPC'

  test('latest user turn only includes the follow-up assistant message', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: firstAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: slowSleepAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: followupAssistantId,
    })).toBe(true)
  })

  test('latest user turn start time follows the follow-up user message', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636335777)
  })
})

describe('compaction summary during an active user turn', () => {
  const sessionId = 'ses_compaction'
  const userMessageId = 'msg_user_compaction'
  const replyMessageId = 'msg_reply_compaction'
  const summaryMessageId = 'msg_summary_compaction'

  function assistantEvent({
    messageId,
    created,
    completed,
    summary,
  }: {
    messageId: string
    created: number
    completed?: number
    summary?: true
  }): EventBufferEntry {
    return assistantMessage({
      id: messageId,
      sessionId,
      parentId: userMessageId,
      createdAt: created,
      ...(completed !== undefined && { completedAt: completed }),
      agent: summary ? 'compaction' : 'build',
      model: { providerId: 'test-provider', modelId: summary ? 'compaction-model' : 'reply-model' },
      cost: summary ? 2 : 1,
      usage: usage({ input: summary ? 20 : 10, output: 1 }),
      ...(completed && { finish: 'stop' }),
      ...(summary && { summary: true }),
    })
  }

  const activeEvents = [
    eventEntry({
      type: 'message',
      message: {
        id: userMessageId,
        sessionId,
        role: 'user',
        createdAt: 1,
        agent: 'build',
        model: {
          providerId: 'test-provider',
          modelId: 'reply-model',
        },
      },
    }),
    assistantEvent({ messageId: replyMessageId, created: 2 }),
    assistantEvent({
      messageId: summaryMessageId,
      created: 3,
      completed: 4,
      summary: true,
    }),
  ]

  test('compaction completion does not replace or complete the user-facing reply', () => {
    expect(getAssistantMessageIdsForLatestUserTurn({
      events: activeEvents,
      sessionId,
    })).toEqual(new Set([replyMessageId]))
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events: activeEvents,
      sessionId,
    })).toBe(replyMessageId)
    expect(isAssistantMessageInLatestUserTurn({
      events: activeEvents,
      sessionId,
      messageId: summaryMessageId,
    })).toBe(false)
    expect(doesLatestUserTurnHaveNaturalCompletion({
      events: activeEvents,
      sessionId,
    })).toBe(false)
  })

  test('summary identity is derivable while its billed usage remains counted', () => {
    expect(getAssistantMessageKind({
      events: activeEvents.slice(0, 2),
      sessionId,
      messageId: summaryMessageId,
    })).toBe('unknown')
    expect(getAssistantMessageKind({
      events: activeEvents,
      sessionId,
      messageId: summaryMessageId,
    })).toBe('summary')
    expect(getAssistantMessageKind({
      events: activeEvents,
      sessionId,
      messageId: replyMessageId,
    })).toBe('user-facing')
    expect(isSummaryAssistantMessage({
      events: activeEvents,
      sessionId,
      messageId: summaryMessageId,
    })).toBe(true)
    expect(isAssistantMessageNaturalCompletion({
      message: getAssistantMessageById({
        events: activeEvents,
        sessionId,
        messageId: summaryMessageId,
      }),
    })).toBe(false)
    expect(getLatestRunInfo({ events: activeEvents, sessionId })).toEqual({
      model: 'reply-model',
      providerID: 'test-provider',
      agent: 'build',
      tokensUsed: 11,
    })
    expect(getLatestTurnTokenUsage({ events: activeEvents, sessionId })).toMatchObject({
      total: 32,
      cost: 3,
      assistantMessageCount: 2,
    })
  })

  test('the real continuation still completes normally after compaction', () => {
    const completedEvents = [
      ...activeEvents,
      assistantEvent({ messageId: replyMessageId, created: 2, completed: 5 }),
    ]
    expect(doesLatestUserTurnHaveNaturalCompletion({
      events: completedEvents,
      sessionId,
    })).toBe(true)
  })

  test('compaction user messages do not steal the latest user-facing turn', () => {
    const compactionUserId = 'msg_compaction_user'
    const events = [
      ...activeEvents,
      eventEntry({
        type: 'message',
        message: {
          id: compactionUserId,
          sessionId,
          role: 'user',
          createdAt: 6,
          agent: 'build',
          model: {
            providerId: 'test-provider',
            modelId: 'reply-model',
          },
        },
      }),
      eventEntry({
        type: 'part',
        part: {
          id: 'prt_compaction',
          sessionId,
          messageId: compactionUserId,
          kind: 'other',
          type: 'compaction',
        },
      }),
    ]
    expect(getLatestUserMessage({ events, sessionId })?.id).toBe(userMessageId)
    expect(getAssistantMessageIdsForLatestUserTurn({
      events,
      sessionId,
    })).toEqual(new Set([replyMessageId]))
  })
})

describe('session-two-completions-same-session', () => {
  const events = loadFixture('session-two-completions-same-session.jsonl')
  const sessionId = getSessionId(events)
  const assistantMessages = getAssistantMessages(events, sessionId)
  const firstAssistant = assistantMessages[0]
  const secondAssistant = assistantMessages[1]

  test('latest user turn points at the second completion only', () => {
    if (!firstAssistant || !secondAssistant) {
      throw new Error('Expected two assistant messages in fixture')
    }
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: firstAssistant.id,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: secondAssistant.id,
    })).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(secondAssistant.id)
  })
})

describe('session-concurrent-messages-serialized', () => {
  const events = loadFixture('session-concurrent-messages-serialized.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('fixture latest turn is still incomplete even though an older turn completed', () => {
    expect(doesLatestUserTurnHaveNaturalCompletion({
      events,
      sessionId,
    })).toBe(false)
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(message.id).toBe(latestAssistantMessageId)
  })
})

describe('ignored plugin notices do not steal the current Discord turn', () => {
  const sessionId = 'ses_notice'
  const userMessageId = 'msg_user'
  const replyMessageId = 'msg_asst'
  const noticeMessageId = 'msg_notice'
  const replyAfterNoticeMessageId = 'msg_asst_after_notice'
  const events: EventBufferEntry[] = [
    eventEntry({
      type: 'message',
      message: {
        id: userMessageId,
        sessionId,
        role: 'user',
        createdAt: 1,
        agent: 'build',
        model: {
          providerId: 'test-provider',
          modelId: 'reply-model',
        },
      },
    }),
    eventEntry({
      type: 'part',
      part: {
        id: 'prt_prompt',
        sessionId,
        messageId: userMessageId,
        kind: 'text',
        text: 'see how we display in discord tool calls',
      },
    }),
    eventEntry({
      type: 'part',
      part: {
        id: 'prt_branch',
        sessionId,
        messageId: userMessageId,
        kind: 'text',
        text: '\n[current git branch is main]\n',
        synthetic: true,
      },
    }),
    eventEntry({
      type: 'message',
      message: {
        id: replyMessageId,
        sessionId,
        role: 'assistant',
        createdAt: 2,
        parentId: userMessageId,
        agent: 'build',
        model: {
          providerId: 'test-provider',
          modelId: 'reply-model',
        },
        cost: 1,
        usage: {
          input: 10,
          output: 1,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    }),
    eventEntry({
      type: 'message',
      message: {
        id: noticeMessageId,
        sessionId,
        role: 'user',
        createdAt: 3,
        agent: 'build',
        model: {
          providerId: 'subrouter',
          modelId: 'build',
        },
      },
    }),
    eventEntry({
      type: 'part',
      part: {
        id: 'prt_notice',
        sessionId,
        messageId: noticeMessageId,
        kind: 'text',
        text: 'Subrouter: Using openai/gpt-5.6-sol because xai/grok-4.6 is rate limited.',
        ignored: true,
      },
    }),
    eventEntry({
      type: 'message',
      message: {
        id: replyAfterNoticeMessageId,
        sessionId,
        role: 'assistant',
        createdAt: 4,
        completedAt: 5,
        parentId: noticeMessageId,
        agent: 'build',
        model: {
          providerId: 'subrouter',
          modelId: 'build',
        },
        cost: 1,
        usage: {
          input: 10,
          output: 1,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        finish: 'stop',
      },
    }),
  ]

  test('keeps the real user prompt as the latest turn', () => {
    expect(getLatestUserMessage({ events, sessionId })?.id).toBe(userMessageId)
    expect(getAssistantMessageIdsForLatestUserTurn({
      events,
      sessionId,
    })).toEqual(new Set([replyMessageId, replyAfterNoticeMessageId]))
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(replyAfterNoticeMessageId)
    expect(doesLatestUserTurnHaveNaturalCompletion({
      events,
      sessionId,
    })).toBe(true)
  })

  test('keeps a file prompt with an ignored notice as the latest turn', () => {
    const fileUserId = 'msg_file_user'
    const fileAssistantId = 'msg_file_asst'
    const fileEvents: EventBufferEntry[] = [
      eventEntry({
        type: 'message',
        message: {
          id: fileUserId,
          sessionId,
          role: 'user',
          createdAt: 4,
          agent: 'build',
          model: {
            providerId: 'test-provider',
            modelId: 'reply-model',
          },
        },
      }),
      eventEntry({
        type: 'part',
        part: {
          id: 'prt_file',
          sessionId,
          messageId: fileUserId,
          kind: 'file',
          mime: 'image/png',
          url: 'https://example.com/shot.png',
          filename: 'shot.png',
        },
      }),
      eventEntry({
        type: 'part',
        part: {
          id: 'prt_file_notice',
          sessionId,
          messageId: fileUserId,
          kind: 'text',
          text: 'Subrouter: Using openai/gpt-5.6-sol because xai/grok-4.6 is rate limited.',
          ignored: true,
        },
      }),
      eventEntry({
        type: 'message',
        message: {
          id: fileAssistantId,
          sessionId,
          role: 'assistant',
          createdAt: 5,
          parentId: fileUserId,
          agent: 'build',
          model: {
            providerId: 'test-provider',
            modelId: 'reply-model',
          },
          cost: 1,
          usage: {
            input: 10,
            output: 1,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      }),
    ]
    expect(getLatestUserMessage({ events: fileEvents, sessionId })?.id).toBe(fileUserId)
    expect(getAssistantMessageIdsForLatestUserTurn({
      events: fileEvents,
      sessionId,
    })).toEqual(new Set([fileAssistantId]))
  })
})

describe('session-tool-call-noisy-stream', () => {
  const events = loadFixture('session-tool-call-noisy-stream.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('fixture ends busy on a tool-call handoff message', () => {
    expect(isSessionBusy({ events, sessionId })).toBe(true)
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(false)
  })

  test('getLatestRunInfo still works through dense tool events', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'deterministic-v2',
      providerID: 'deterministic-provider',
      agent: 'build',
      tokensUsed: 0,
    })
  })
})

describe('session-voice-queued-followup', () => {
  const events = loadFixture('session-voice-queued-followup.jsonl')
  const sessionId = getSessionId(events)

  test('latest user turn start moves to the queued follow-up', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636414577)
  })
})

describe('synthetic-question-followup', () => {
  const sessionId = 'ses_question'
  const events: EventBufferEntry[] = [
    {
      timestamp: 1,
      event: {
        type: 'message',
        message: {
          id: 'msg_user_1',
          sessionId,
          role: 'user',
          createdAt: 1,
          agent: 'build',
          model: {
            providerId: 'deterministic-provider',
            modelId: 'deterministic-v2',
          },
        },
      },
    },
    {
      timestamp: 2,
      event: {
        type: 'message',
        message: {
          id: 'msg_asst_1',
          sessionId,
          role: 'assistant',
          createdAt: 2,
          completedAt: 3,
          parentId: 'msg_user_1',
          agent: 'build',
          model: {
            providerId: 'deterministic-provider',
            modelId: 'deterministic-v2',
          },
          cost: 0,
          usage: {
            input: 1,
            output: 1,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          finish: 'stop',
        },
      },
    },
    {
      timestamp: 4,
      event: {
        type: 'message',
        message: {
          id: 'msg_user_2',
          sessionId,
          role: 'user',
          createdAt: 4,
          agent: 'build',
          model: {
            providerId: 'deterministic-provider',
            modelId: 'deterministic-v2',
          },
        },
      },
    },
  ]

  test('latest user turn flips immediately after the follow-up user message', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: 'msg_asst_1',
    })).toBe(false)
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(4)
  })
})

describe('real-session-task-normal', () => {
  const events = loadFixture('real-session-task-normal.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('latest assistant completion is terminal', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(true)
  })

  test('getLatestRunInfo has model info', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      agent: 'build',
      tokensUsed: 39025,
    })
  })
})

describe('real-session-task-user-interruption', () => {
  const events = loadFixture('real-session-task-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const childSessionId = 'ses_3464f3a1dffeBBD0d15EqnGjAh'
  const firstAssistantId = 'msg_cb9b0ba96001SpPjgzxWPmRuW9'
  const secondAssistantId = 'msg_cb9b1ae5c001E5G3Ql6aXNpst2'

  test('tool-call handoff assistant is not a natural completion but the resumed reply is', () => {
    const firstAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: firstAssistantId,
    })
    const secondAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: secondAssistantId,
    })
    // The first message finished with tool-calls — not a natural completion
    // (footer is deferred to session.idle). The second message IS natural.
    expect(isAssistantMessageNaturalCompletion({ message: firstAssistant })).toBe(false)
    expect(isAssistantMessageNaturalCompletion({ message: secondAssistant })).toBe(true)
  })

  test('latest user turn keeps both assistant messages for the same user turn', () => {
    const assistantIds = getAssistantMessageIdsForLatestUserTurn({ events, sessionId })
    expect(assistantIds.has(firstAssistantId)).toBe(true)
    expect(assistantIds.has(secondAssistantId)).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(secondAssistantId)
  })

  test('getDerivedSubtaskIndex starts at 1 for first task of assistant message', () => {
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toBe(1)
  })

  test('getDerivedSubtaskIndex restarts at 1 for a newer assistant message', () => {
    const firstTaskPart = findTaskPart(events, (part) => {
      return part.sessionId === sessionId
        && (part.status === 'running' || part.status === 'completed')
        && part.subagent?.childSessionId === childSessionId
    })

    const secondChildSessionId = 'ses_synthetic_child_2'
    const thirdChildSessionId = 'ses_synthetic_child_3'
    const syntheticAssistantMessageId = 'msg_synthetic_new_assistant'

    const delegatedPart = (suffix: string, childId: string): ToolPart => ({
      ...firstTaskPart,
      id: `${firstTaskPart.id}-${suffix}`,
      messageId: syntheticAssistantMessageId,
      status: 'completed',
      output: `task_id: ${childId}`,
      subagent: { ...firstTaskPart.subagent, childSessionId: childId },
    })

    const lastTimestamp = events[events.length - 1]?.timestamp || 0
    const augmentedEvents: EventBufferEntry[] = [
      ...events,
      ...delegation(delegatedPart('synthetic-2', secondChildSessionId), lastTimestamp + 1),
      ...delegation(delegatedPart('synthetic-3', thirdChildSessionId), lastTimestamp + 2),
    ]

    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: secondChildSessionId,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: thirdChildSessionId,
    })).toBe(2)
  })

  test('getDerivedSubtaskIndex returns undefined for unknown session', () => {
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: sessionId,
      candidateSessionId: 'ses_nonexistent',
    })).toBe(undefined)
  })

  test('does not label a child before its task call identifies it', () => {
    const candidateSessionId = 'ses_child_without_task_metadata'
    const childCreated = eventEntry({
      type: 'session.created',
      session: {
        id: candidateSessionId,
        title: 'child task',
        directory: '/test',
        createdAt: 1,
        updatedAt: 1,
        version: '1',
        parentId: sessionId,
      },
    })
    const beforeTaskMetadata = [...events, childCreated]
    expect(isDerivedChildSession({
      events: beforeTaskMetadata,
      mainSessionId: sessionId,
      candidateSessionId,
    })).toBe(true)
    expect(getDerivedSubtaskLabel({
      events: beforeTaskMetadata,
      mainSessionId: sessionId,
      candidateSessionId,
    })).toBeUndefined()
  })

  test('uses task agent and order for parallel child sessions', () => {
    const captured = loadFixture('real-session-task-three-parallel-sleeps.jsonl')
    const runningTaskParts = captured.flatMap((entry) => {
      const part = entry.event.type === 'part' ? entry.event.part : undefined
      return part?.kind === 'tool' && part.tool === 'task' && part.status === 'running' && part.subagent?.childSessionId
        ? [{ ...part, subagent: { ...part.subagent, agent: 'general' } }]
        : []
    })
    expect(runningTaskParts).toHaveLength(3)
    const taskEvents = runningTaskParts.flatMap((part) => delegation(part))
    const children = runningTaskParts.map((part) => part.subagent.childSessionId!)

    expect(children.map((candidateSessionId) => getDerivedSubtaskLabel({
      events: taskEvents,
      mainSessionId: getSessionId(captured),
      candidateSessionId,
    }))).toMatchInlineSnapshot(`
      [
        "general-1",
        "general-2",
        "general-3",
      ]
    `)

    // A later update that no longer names the agent keeps the earlier label.
    const { agent: _agent, ...withoutAgent } = runningTaskParts[1]!.subagent
    const laterUpdate = delegation({ ...runningTaskParts[1]!, subagent: withoutAgent })
    expect(getDerivedSubtaskLabel({
      events: [...taskEvents, ...laterUpdate],
      mainSessionId: getSessionId(captured),
      candidateSessionId: children[1]!,
    })).toMatchInlineSnapshot(`"general-2"`)
  })

  test('getDerivedSubagentSessions returns latest tasks first with agent labels', () => {
    const firstTaskPart = findTaskPart(events, (part) => {
      return part.sessionId === sessionId && (part.status === 'running' || part.status === 'completed')
    })

    const newerTaskPart: ToolPart = {
      ...firstTaskPart,
      id: `${firstTaskPart.id}-newer`,
      input: {
        ...firstTaskPart.input,
        description: 'inspect recent task output',
        subagent_type: 'explore',
      },
      subagent: {
        childSessionId: 'ses_newer_child',
        agent: 'explore',
        description: 'inspect recent task output',
      },
    }

    const latestTimestamp = events[events.length - 1]?.timestamp || 0
    const augmentedEvents: EventBufferEntry[] = [
      ...events,
      ...delegation(newerTaskPart, latestTimestamp + 1),
    ]

    expect(getDerivedSubagentSessions({
      events: augmentedEvents,
      mainSessionId: sessionId,
    })).toMatchInlineSnapshot(`
      [
        {
          "childSessionId": "ses_newer_child",
          "description": "inspect recent task output",
          "subagentType": "explore",
          "timestamp": 1772641957983,
        },
        {
          "childSessionId": "ses_3464f3a1dffeBBD0d15EqnGjAh",
          "description": undefined,
          "subagentType": undefined,
          "timestamp": 1772641955371,
        },
      ]
    `)
  })
})

describe('real-session-action-buttons', () => {
  const events = loadFixture('real-session-action-buttons.jsonl')
  const sessionId = getSessionId(events)
  const toolCallAssistantId = 'msg_cb9b55c3b001hXC9qxjVxLMypM'
  const finalAssistantId = 'msg_cb9b5ddd1001FALqKNM6xW98u6'

  test('tool-call handoff assistant is not a natural completion but final reply is', () => {
    const toolCallAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: toolCallAssistantId,
    })
    const finalAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: finalAssistantId,
    })
    // The tool-call message has finish="tool-calls" — not a natural completion
    // (footer is deferred to session.idle). The final text message IS natural.
    expect(isAssistantMessageNaturalCompletion({ message: toolCallAssistant })).toBe(false)
    expect(isAssistantMessageNaturalCompletion({ message: finalAssistant })).toBe(true)
  })

  test('latest user turn keeps both assistant messages for the same user turn', () => {
    const assistantIds = getAssistantMessageIdsForLatestUserTurn({ events, sessionId })
    expect(assistantIds.has(toolCallAssistantId)).toBe(true)
    expect(assistantIds.has(finalAssistantId)).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(finalAssistantId)
  })
})

describe('real-session-permission-external-file', () => {
  const events = loadFixture('real-session-permission-external-file.jsonl')
  const sessionId = getSessionId(events)

  test('permission flow has no terminal assistant completion yet', () => {
    const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })
    expect(latestAssistantMessageId).toBeDefined()
    if (!latestAssistantMessageId) {
      return
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(false)
  })
})

describe('real-session-footer-suppressed-on-pre-idle-interrupt', () => {
  const events = loadFixture('real-session-footer-suppressed-on-pre-idle-interrupt.jsonl')
  const sessionId = getSessionId(events)
  const oldAssistantId = 'msg_cbda8f408001VATHNUi9l05XqA'
  const abortedAssistantId = 'msg_cbda90cef001GOQW8EQxkUz9b5'
  const latestAssistantId = 'msg_cbda91463001DvEB6YMCXayZNj'

  test('latest user turn ignores stale assistant messages from the interrupted turn', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: oldAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: abortedAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: latestAssistantId,
    })).toBe(true)
  })
})

describe('getLatestTurnTokenUsage', () => {
  function userEvent({
    sessionId,
    messageId,
    created,
  }: {
    sessionId: string
    messageId: string
    created: number
  }) {
    return eventEntry({
      type: 'message',
      message: {
        id: messageId,
        sessionId,
        role: 'user',
        createdAt: created,
        agent: 'build',
        model: {
          providerId: 'openai',
          modelId: 'gpt-5.3-codex',
        },
      },
    })
  }

  function assistantEvent({
    sessionId,
    messageId,
    parentID,
    created,
    tokens,
    cost = 0,
    modelID = 'gpt-5.3-codex',
    providerID = 'openai',
  }: {
    sessionId: string
    messageId: string
    parentID: string
    created: number
    tokens: Partial<AgentUsage>
    cost?: number
    modelID?: string
    providerID?: string
  }) {
    return eventEntry({
      type: 'message',
      message: {
        id: messageId,
        sessionId,
        role: 'assistant',
        createdAt: created,
        completedAt: created + 1,
        parentId: parentID,
        agent: 'build',
        model: {
          providerId: providerID,
          modelId: modelID,
        },
        cost,
        usage: usage(tokens),
        finish: 'stop',
      },
    })
  }

  test('sums latest snapshot per assistant message in the latest turn', () => {
    const sessionId = 'ses_tokens'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
      }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cacheRead: 10, cacheWrite: 2,
        },
        cost: 1,
      }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_1',
        created: 3,
        tokens: {
          input: 50,
          output: 8,
          reasoning: 1,
          cacheRead: 4, cacheWrite: 0,
        },
        cost: 2,
      }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 150,
      output: 28,
      reasoning: 6,
      cacheRead: 14,
      cacheWrite: 2,
      total: 200,
      cost: 3,
      model: 'gpt-5.3-codex',
      providerID: 'openai',
      assistantMessageCount: 2,
      userMessageId: 'msg_user_1',
    })
  })

  test('ignores previous-turn assistant messages', () => {
    const sessionId = 'ses_tokens_turns'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 1000,
          output: 100,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 7,
          output: 3,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
        modelID: 'gemini-2.5-flash',
        providerID: 'google',
      }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 7,
      output: 3,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 10,
      cost: 0,
      model: 'gemini-2.5-flash',
      providerID: 'google',
      assistantMessageCount: 1,
      userMessageId: 'msg_user_2',
    })
  })

  test('returns zeros when the latest turn has no assistant tokens', () => {
    const sessionId = 'ses_empty'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
      model: undefined,
      providerID: undefined,
      assistantMessageCount: 0,
      userMessageId: 'msg_user_1',
    })
  })

  test('real-session-task-normal uses the completed assistant snapshot', () => {
    const events = loadFixture('real-session-task-normal.jsonl')
    const sessionId = getSessionId(events)
    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 39025,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 39025,
      cost: 0,
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      assistantMessageCount: 1,
      userMessageId: 'msg_cb9aae4c9001CxCOkoqgiXRsi1',
    })
  })

  test('real-session-task-user-interruption sums both assistant steps', () => {
    const events = loadFixture('real-session-task-user-interruption.jsonl')
    const sessionId = getSessionId(events)
    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 82526,
      output: 79,
      reasoning: 115,
      cacheRead: 0,
      cacheWrite: 0,
      total: 82720,
      cost: 0,
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      assistantMessageCount: 2,
      userMessageId: 'msg_cb9b0ba6c001i3YH7bGffdB6BF',
    })
  })

  test('uses tokens.total when it differs from the component sum', () => {
    const sessionId = 'ses_canonical_total'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          total: 47319,
          input: 1217,
          output: 278,
          reasoning: 54,
          cacheRead: 45824, cacheWrite: 0,
        },
      }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toMatchObject({
      input: 1217,
      output: 278,
      reasoning: 54,
      cacheRead: 45824,
      cacheWrite: 0,
      total: 47319,
      assistantMessageCount: 1,
    })
  })

  test('real-session-task-three-parallel-sleeps uses billed totals', () => {
    const events = loadFixture('real-session-task-three-parallel-sleeps.jsonl')
    const sessionId = getSessionId(events)
    expect(getLatestTurnTokenUsage({ events, sessionId })).toMatchObject({
      input: 47139,
      output: 1093,
      reasoning: 472,
      cacheRead: 45824,
      cacheWrite: 0,
      total: 94056,
      model: 'gpt-5.3-codex',
      providerID: 'openai',
      assistantMessageCount: 2,
    })
  })

  test('sums assistant tokens when the session has no user message', () => {
    const sessionId = 'ses_no_user'
    const events = [
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_missing',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
      }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 100,
      output: 10,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 110,
      cost: 0,
      model: 'gpt-5.3-codex',
      providerID: 'openai',
      assistantMessageCount: 1,
      userMessageId: undefined,
    })
  })
})

describe('getPromptCacheClear', () => {
  function userEvent({
    sessionId,
    messageId,
    created,
  }: {
    sessionId: string
    messageId: string
    created: number
  }) {
    return eventEntry({
      type: 'message',
      message: {
        id: messageId,
        sessionId,
        role: 'user',
        createdAt: created,
        agent: 'build',
        model: {
          providerId: 'openai',
          modelId: 'gpt-5.3-codex',
        },
      },
    })
  }

  function assistantEvent({
    sessionId,
    messageId,
    parentID,
    created,
    tokens,
    modelID = 'gpt-5.3-codex',
    providerID = 'openai',
    completed = true,
    error,
  }: {
    sessionId: string
    messageId: string
    parentID: string
    created: number
    tokens: Partial<AgentUsage>
    modelID?: string
    providerID?: string
    completed?: boolean
    error?: AgentError
  }) {
    return eventEntry({
      type: 'message',
      message: {
        id: messageId,
        sessionId,
        role: 'assistant',
        createdAt: created,
        completedAt: completed ? created + 1 : undefined,
        parentId: parentID,
        agent: 'build',
        model: {
          providerId: providerID,
          modelId: modelID,
        },
        cost: 0,
        usage: usage(tokens),
        error,
        finish: completed ? 'stop' : undefined,
      },
    })
  }

  test('skips the first completed assistant in a session', () => {
    const sessionId = 'ses_cache_start'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 20000,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_1',
    })).toBeUndefined()
  })

  test('skips a cache drop when the model changed', () => {
    const sessionId = 'ses_cache_model'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 20000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        modelID: 'gemini-2.5-flash',
        providerID: 'google',
        tokens: {
          input: 20100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toBeUndefined()
  })

  test('detects a cache miss when cache.read drops to zero', () => {
    const sessionId = 'ses_cache_miss'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 20000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 20100,
          output: 12,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 20100,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toEqual({
      expectedCacheRead: 20000,
      currentCacheRead: 0,
      previousMessageId: 'msg_asst_1',
      currentMessageId: 'msg_asst_2',
      minutesSincePreviousMessage: 0,
    })
  })

  test('measures request gap across a long tool call', () => {
    const sessionId = 'ses_cache_long_tool'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1_000 }),
      assistantEvent({
        sessionId, messageId: 'msg_asst_1', parentID: 'msg_user_1', created: 2_000,
        tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 577000, cacheWrite: 0 },
      }),
      eventEntry({
        type: 'part',
        part: {
          id: 'part_tool',
          sessionId,
          messageId: 'msg_asst_1',
          kind: 'tool',
          callId: 'call_1',
          tool: 'bash',
          status: 'completed',
          input: {},
          output: '',
          startedAt: 2_000,
          endedAt: 422_000,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 422_000 }),
      assistantEvent({
        sessionId, messageId: 'msg_asst_2', parentID: 'msg_user_2', created: 422_000,
        tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 577000 },
      }),
    ]
    const clear = getPromptCacheClear({ events, sessionId, currentMessageId: 'msg_asst_2' })
    expect(clear?.minutesSincePreviousMessage).toBe(7)
    expect(clear?.toolRuntimeMinutes).toBe(7)
    expect(formatPromptCacheClearMessage(clear!)).toBe('prompt cache missed (577k → 0) (7 mins since last request, tool ran 7 mins)')
  })

  test('detects a fork cache miss against its copied assistant history', () => {
    const sessionId = 'ses_btw_fork'
    const events = [
      assistantEvent({
        sessionId,
        messageId: 'msg_copied_assistant',
        parentID: 'msg_copied_user',
        created: 1000,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 20000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_btw_user', created: 301000 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_btw_assistant',
        parentID: 'msg_btw_user',
        created: 301001,
        tokens: {
          input: 20100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 20100,
        },
      }),
    ]
    const clear = getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_btw_assistant',
    })
    expect(clear).toEqual({
      expectedCacheRead: 20000,
      currentCacheRead: 0,
      previousMessageId: 'msg_copied_assistant',
      currentMessageId: 'msg_btw_assistant',
      minutesSincePreviousMessage: 5,
    })
    expect(formatPromptCacheClearMessage(clear!)).toBe('prompt cache missed (20k → 0) (5 mins passed)')
  })

  test('detects a miss on the second turn when the first turn only wrote cache', () => {
    const sessionId = 'ses_cache_second_turn'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 20000,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 100,
          output: 12,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 20200,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toEqual({
      expectedCacheRead: 20000,
      currentCacheRead: 0,
      previousMessageId: 'msg_asst_1',
      currentMessageId: 'msg_asst_2',
      minutesSincePreviousMessage: 0,
    })
  })

  test('detects consecutive misses, not only every other turn', () => {
    const sessionId = 'ses_cache_consecutive'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 20000, cacheWrite: 100,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 20300,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_3', created: 5 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_3',
        parentID: 'msg_user_3',
        created: 6,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 20500,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_3',
    })).toEqual({
      expectedCacheRead: 20300,
      currentCacheRead: 0,
      previousMessageId: 'msg_asst_2',
      currentMessageId: 'msg_asst_3',
      minutesSincePreviousMessage: 0,
    })
  })

  test('detects a cache drop when prompt size stays similar', () => {
    const sessionId = 'ses_cache_drop'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 40000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 200,
          output: 10,
          reasoning: 0,
          cacheRead: 8000, cacheWrite: 32000,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toEqual({
      expectedCacheRead: 40000,
      currentCacheRead: 8000,
      previousMessageId: 'msg_asst_1',
      currentMessageId: 'msg_asst_2',
      minutesSincePreviousMessage: 0,
    })
  })

  test('ignores a cache drop after a prune marker even if prompt grew', () => {
    const sessionId = 'ses_cache_prune_grew'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 100000, cacheWrite: 0,
        },
      }),
      eventEntry({
        type: 'part',
        part: {
          id: 'prt_pruned',
          sessionId,
          messageId: 'msg_asst_1',
          kind: 'tool',
          callId: 'call_pruned',
          tool: 'bash',
          status: 'completed',
          input: {},
          output: '',
          startedAt: 3,
          endedAt: 4,
          compactedAt: 5,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 6 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 7,
        tokens: {
          input: 101100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 101100,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toBeUndefined()
  })

  test('ignores a small prompt shrink from pruning', () => {
    const sessionId = 'ses_cache_prune'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 100000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 21000,
          output: 10,
          reasoning: 0,
          cacheRead: 79000, cacheWrite: 0,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toBeUndefined()
  })

  test('ignores a smaller prompt that is still read from cache after a revert', () => {
    const sessionId = 'ses_cache_revert'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 40000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 200,
          output: 10,
          reasoning: 0,
          cacheRead: 8000, cacheWrite: 0,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toBeUndefined()
  })

  test('detects a miss when the prompt shrank without pruning', () => {
    const sessionId = 'ses_cache_shrunk_miss'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 187000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 182000,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toEqual({
      expectedCacheRead: 182000,
      currentCacheRead: 0,
      previousMessageId: 'msg_asst_1',
      currentMessageId: 'msg_asst_2',
      minutesSincePreviousMessage: 0,
    })
  })

  test('compares against the previous user turn, not a same-turn tool step', () => {
    const sessionId = 'ses_cache_same_turn'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 20000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2a',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 80,
          output: 5,
          reasoning: 0,
          cacheRead: 20100, cacheWrite: 80,
        },
      }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2b',
        parentID: 'msg_user_2',
        created: 5,
        tokens: {
          input: 20180,
          output: 12,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 20180,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2b',
    })).toEqual({
      expectedCacheRead: 20000,
      currentCacheRead: 0,
      previousMessageId: 'msg_asst_1',
      currentMessageId: 'msg_asst_2b',
      minutesSincePreviousMessage: 0,
    })
  })

  test('ignores a cache hit that grew', () => {
    const sessionId = 'ses_cache_hit'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 20000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 80,
          output: 10,
          reasoning: 0,
          cacheRead: 22000, cacheWrite: 80,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toBeUndefined()
  })

  test('compares across an aborted assistant with the last good reply', () => {
    const sessionId = 'ses_cache_abort_bridge'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 40000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        error: { name: 'MessageAbortedError', message: 'aborted' },
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_3', created: 5 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_3',
        parentID: 'msg_user_3',
        created: 6,
        tokens: {
          input: 40100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 40100,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_3',
    })).toEqual({
      expectedCacheRead: 40000,
      currentCacheRead: 0,
      previousMessageId: 'msg_asst_1',
      currentMessageId: 'msg_asst_3',
      minutesSincePreviousMessage: 0,
    })
  })

  test('does not compare across a compaction summary', () => {
    const sessionId = 'ses_cache_compaction'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 40000, cacheWrite: 0,
        },
      }),
      eventEntry({
        type: 'message',
        message: {
          id: 'msg_summary',
          sessionId,
          role: 'assistant',
          createdAt: 3,
          completedAt: 4,
          parentId: 'msg_user_1',
          agent: 'compaction',
          model: {
            providerId: 'openai',
            modelId: 'gpt-5.3-codex',
          },
          cost: 0,
          usage: {
            input: 20,
            output: 1,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          summary: true,
          finish: 'stop',
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 5 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 6,
        tokens: {
          input: 40100,
          output: 10,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 40100,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toBeUndefined()
  })

  test('ignores aborted assistants with zero cache read', () => {
    const sessionId = 'ses_cache_abort'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 48512, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        error: { name: 'MessageAbortedError', message: 'aborted' },
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toBeUndefined()
  })

  test('ignores incomplete streaming snapshots', () => {
    const sessionId = 'ses_cache_stream'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 20000, cacheWrite: 0,
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        completed: false,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0, cacheWrite: 0,
        },
      }),
    ]
    expect(getPromptCacheClear({
      events,
      sessionId,
      currentMessageId: 'msg_asst_2',
    })).toBeUndefined()
  })

  test('formats a compact cache-miss notice', () => {
    expect(formatPromptCacheClearMessage({
      expectedCacheRead: 20000,
      currentCacheRead: 0,
      previousMessageId: 'msg_asst_1',
      currentMessageId: 'msg_asst_2',
      minutesSincePreviousMessage: 5,
    })).toBe('prompt cache missed (20k → 0) (5 mins passed)')
    expect(formatPromptCacheClearMessage({
      expectedCacheRead: 20000,
      currentCacheRead: 0,
      previousMessageId: 'msg_asst_1',
      currentMessageId: 'msg_asst_2',
      minutesSincePreviousMessage: 0,
    }, { additions: 4, deletions: 1 })).toBe('prompt cache missed (20k → 0) (0 mins passed), system +4 -1')
  })
})

describe('getIdleTokenUsageDelta', () => {
  function idleEvent(sessionId: string): EventBufferEntry {
    return eventEntry({
      type: 'idle',
      sessionId,
    })
  }

  test('emits the first idle snapshot and skips a later idle with the same tokens', () => {
    const sessionId = 'ses_delta'
    const events = [
      eventEntry({
        type: 'message',
        message: {
          id: 'msg_user_1',
          sessionId,
          role: 'user',
          createdAt: 1,
          agent: 'build',
          model: {
            providerId: 'openai',
            modelId: 'gpt-5.3-codex',
          },
        },
      }),
      eventEntry({
        type: 'message',
        message: {
          id: 'msg_asst_1',
          sessionId,
          role: 'assistant',
          createdAt: 2,
          completedAt: 3,
          parentId: 'msg_user_1',
          agent: 'build',
          model: {
            providerId: 'openai',
            modelId: 'gpt-5.3-codex',
          },
          cost: 0,
          usage: {
            input: 10,
            output: 5,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          finish: 'stop',
        },
      }),
      idleEvent(sessionId),
      idleEvent(sessionId),
    ]

    const firstIdleIndex = events.length - 2
    const secondIdleIndex = events.length - 1
    expect(getIdleTokenUsageDelta({
      events,
      sessionId,
      idleEventIndex: firstIdleIndex,
    })).toMatchObject({
      total: 15,
    })
    expect(getIdleTokenUsageDelta({
      events,
      sessionId,
      idleEventIndex: secondIdleIndex,
    })).toBeUndefined()
  })

  test('emits the growth after an early idle that saw zero tokens', () => {
    const sessionId = 'ses_late_tokens'
    const events = [
      eventEntry({
        type: 'message',
        message: {
          id: 'msg_user_1',
          sessionId,
          role: 'user',
          createdAt: 1,
          agent: 'build',
          model: {
            providerId: 'openai',
            modelId: 'gpt-5.3-codex',
          },
        },
      }),
      eventEntry({
        type: 'message',
        message: {
          id: 'msg_asst_1',
          sessionId,
          role: 'assistant',
          createdAt: 2,
          parentId: 'msg_user_1',
          agent: 'build',
          model: {
            providerId: 'openai',
            modelId: 'gpt-5.3-codex',
          },
          cost: 0,
          usage: {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      }),
      idleEvent(sessionId),
      eventEntry({
        type: 'message',
        message: {
          id: 'msg_asst_1',
          sessionId,
          role: 'assistant',
          createdAt: 2,
          completedAt: 4,
          parentId: 'msg_user_1',
          agent: 'build',
          model: {
            providerId: 'openai',
            modelId: 'gpt-5.3-codex',
          },
          cost: 0,
          usage: {
            input: 12,
            output: 8,
            reasoning: 3,
            cacheRead: 0,
            cacheWrite: 0,
            total: 20,
          },
          finish: 'stop',
        },
      }),
      idleEvent(sessionId),
    ]

    expect(getIdleTokenUsageDelta({
      events,
      sessionId,
      idleEventIndex: 2,
    })).toBeUndefined()
    expect(getIdleTokenUsageDelta({
      events,
      sessionId,
      idleEventIndex: events.length - 1,
    })).toMatchObject({
      input: 12,
      output: 8,
      reasoning: 3,
      total: 20,
    })
  })

  test('counts child session assistant tokens without a user message.updated', () => {
    const childSessionId = 'ses_task_child'
    const events = [
      eventEntry({
        type: 'message',
        message: {
          id: 'msg_child_asst_1',
          sessionId: childSessionId,
          role: 'assistant',
          createdAt: 2,
          completedAt: 3,
          parentId: 'msg_child_user_missing',
          agent: 'general',
          model: {
            providerId: 'openai',
            modelId: 'gpt-5.3-codex',
          },
          cost: 0.02,
          usage: {
            input: 30,
            output: 10,
            reasoning: 4,
            cacheRead: 0,
            cacheWrite: 0,
            total: 40,
          },
          finish: 'stop',
        },
      }),
      idleEvent(childSessionId),
    ]

    expect(getIdleTokenUsageDelta({
      events,
      sessionId: childSessionId,
      idleEventIndex: events.length - 1,
    })).toMatchObject({
      input: 30,
      output: 10,
      reasoning: 4,
      total: 40,
      cost: 0.02,
      assistantMessageCount: 1,
    })
  })

  test('falls back to session.updated Session.tokens for a child with no message.updated', () => {
    const childSessionId = 'ses_task_child_session_tokens'
    const events = [
      eventEntry({
        type: 'session.updated',
        session: {
          id: childSessionId,
          title: 'child task',
          directory: '/test',
          createdAt: 1,
          updatedAt: 2,
          version: '1',
          parentId: 'ses_main',
          cost: 0.05,
          usage: usage({ input: 100, output: 20, reasoning: 8, cacheRead: 4, cacheWrite: 1 }),
        },
      }),
      idleEvent(childSessionId),
    ]

    expect(getIdleTokenUsageDelta({
      events,
      sessionId: childSessionId,
      idleEventIndex: events.length - 1,
    })).toMatchObject({
      input: 100,
      output: 20,
      reasoning: 8,
      cacheRead: 4,
      cacheWrite: 1,
      total: 133,
      cost: 0.05,
    })
  })

  test('does not re-emit child tokens at parent idle after the child already idled', () => {
    const childSessionId = 'ses_task_child_dedupe'
    const events = [
      eventEntry({
        type: 'message',
        message: {
          id: 'msg_child_asst_1',
          sessionId: childSessionId,
          role: 'assistant',
          createdAt: 2,
          completedAt: 3,
          parentId: 'msg_child_user_missing',
          agent: 'general',
          model: {
            providerId: 'openai',
            modelId: 'gpt-5.3-codex',
          },
          cost: 0,
          usage: {
            input: 30,
            output: 10,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 40,
          },
          finish: 'stop',
        },
      }),
      idleEvent(childSessionId),
      idleEvent('ses_main'),
    ]

    expect(getIdleTokenUsageDelta({
      events,
      sessionId: childSessionId,
      idleEventIndex: 1,
    })).toMatchObject({ total: 40 })
    expect(getIdleTokenUsageDelta({
      events,
      sessionId: childSessionId,
      idleEventIndex: 2,
    })).toBeUndefined()
  })
})

describe('task child session token tracking', () => {
  function idleEvent(sessionId: string): EventBufferEntry {
    return eventEntry({
      type: 'idle',
      sessionId,
    })
  }

  test('isDerivedChildSession is true from session.created parentID before task metadata', () => {
    const mainSessionId = 'ses_main'
    const childSessionId = 'ses_child'
    const events = [
      eventEntry({
        type: 'session.created',
        session: {
          id: childSessionId,
          title: 'explore files',
          directory: '/test',
          createdAt: 1,
          updatedAt: 1,
          version: '1',
          parentId: mainSessionId,
        },
      }),
    ]

    expect(isDerivedChildSession({
      events,
      mainSessionId,
      candidateSessionId: childSessionId,
    })).toBe(true)
    expect(isDerivedChildSession({
      events,
      mainSessionId,
      candidateSessionId: 'ses_unrelated',
    })).toBe(false)
  })

  test('main idle also returns child session ids so their tokens can be tracked', () => {
    const mainSessionId = 'ses_main'
    const childSessionId = 'ses_child'
    const events = [
      eventEntry({
        type: 'session.created',
        session: {
          id: childSessionId,
          title: 'child task',
          directory: '/test',
          createdAt: 1,
          updatedAt: 1,
          version: '1',
          parentId: mainSessionId,
        },
      }),
      eventEntry({
        type: 'part',
        part: {
          id: 'prt_task',
          sessionId: mainSessionId,
          messageId: 'msg_asst',
          kind: 'tool',
          callId: 'call_task',
          tool: 'task',
          status: 'running',
          input: {
            subagent_type: 'general',
          },
          metadata: {
            sessionId: childSessionId,
          },
          subagent: {
            childSessionId,
            agent: 'general',
          },
        },
      }),
      idleEvent(mainSessionId),
    ]

    expect(getTokenUsageSessionIdsForIdle({
      events,
      mainSessionId,
      idleSessionId: mainSessionId,
    })).toEqual([mainSessionId, childSessionId])
    expect(getTokenUsageSessionIdsForIdle({
      events,
      mainSessionId,
      idleSessionId: childSessionId,
    })).toEqual([childSessionId])
  })
})

describe('question waits for preceding text-end', () => {
  const sessionId = 'ses_question_text'
  const messageId = 'msg_asst_question'
  const questionId = 'que_1'

  const textStart = eventEntry({
    type: 'part',
    part: {
      id: 'prt_text',
      sessionId,
      messageId,
      kind: 'text',
      text: '',
      startedAt: 1,
    },
  })
  const questionAsked = eventEntry({
    type: 'question.asked',
    request: {
      id: questionId,
      sessionId,
      questions: [
        {
          question: 'What next?',
          header: 'Next step',
          options: [
            {
              label: 'Commit',
              description: 'Commit these files',
            },
          ],
        },
      ],
      toolCall: {
        messageId,
        callId: 'call_question',
      },
    },
  })
  const textEnd = eventEntry({
    type: 'part',
    part: {
      id: 'prt_text',
      sessionId,
      messageId,
      kind: 'text',
      text: 'Done callout',
      startedAt: 1,
      endedAt: 2,
    },
  })
  const questionError = eventEntry({
    type: 'part',
    part: {
      id: 'prt_question',
      sessionId,
      messageId,
      kind: 'tool',
      callId: 'call_question',
      tool: 'question',
      status: 'error',
      input: {},
      error: 'Aborted',
      startedAt: 2,
      endedAt: 3,
    },
  })

  test('text is not ready when question.asked arrives before time.end', () => {
    const events = [textStart, questionAsked]
    expect(isAssistantTextReadyForQuestion({
      events,
      sessionId,
      messageId,
    })).toBe(false)
    expect(deriveLatestUnansweredQuestion({
      events,
      sessionId,
    })).toMatchObject({
      id: questionId,
      tool: { messageID: messageId },
    })
  })

  test('text is ready after time.end, and still unanswered', () => {
    const events = [textStart, questionAsked, textEnd]
    expect(isAssistantTextReadyForQuestion({
      events,
      sessionId,
      messageId,
    })).toBe(true)
    expect(deriveLatestUnansweredQuestion({
      events,
      sessionId,
    })?.id).toBe(questionId)
  })

  test('no text part means the question is ready immediately', () => {
    const events = [questionAsked]
    expect(isAssistantTextReadyForQuestion({
      events,
      sessionId,
      messageId,
    })).toBe(true)
  })

  test('aborted question is not unanswered', () => {
    const events = [textStart, questionAsked, textEnd, questionError]
    expect(deriveLatestUnansweredQuestion({
      events,
      sessionId,
    })).toBeUndefined()
  })

  test('question from an older user turn is not unanswered', () => {
    const firstUser = eventEntry({
      type: 'message',
      message: {
        id: 'msg_user_first',
        sessionId,
        role: 'user',
        createdAt: 1,
        agent: 'build',
        model: {
          providerId: 'deterministic-provider',
          modelId: 'deterministic-v2',
        },
      },
    })
    const questionAssistant = eventEntry({
      type: 'message',
      message: {
        id: messageId,
        sessionId,
        role: 'assistant',
        createdAt: 2,
        parentId: 'msg_user_first',
        agent: 'build',
        model: {
          providerId: 'deterministic-provider',
          modelId: 'deterministic-v2',
        },
        cost: 0,
        usage: {
          input: 1,
          output: 1,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    })
    const nextUser = eventEntry({
      type: 'message',
      message: {
        id: 'msg_user_commit',
        sessionId,
        role: 'user',
        createdAt: 3,
        agent: 'build',
        model: {
          providerId: 'deterministic-provider',
          modelId: 'deterministic-v2',
        },
      },
    })
    const events = [
      firstUser,
      questionAssistant,
      textStart,
      questionAsked,
      textEnd,
      nextUser,
    ]

    expect(deriveLatestUnansweredQuestion({
      events,
      sessionId,
    })).toBeUndefined()
  })
})

describe('shouldBufferSessionEvent', () => {
  const mainSessionId = 'ses_parent'
  const childSessionId = 'ses_child'
  const btwSessionId = 'ses_btw_fork'

  test('keeps the thread session and drops unrelated /btw fork events', () => {
    const parentBusy = eventEntry({
      type: 'status',
      sessionId: mainSessionId,
      status: {
        state: 'busy',
      },
    }).event
    const btwClone = eventEntry({
      type: 'message',
      message: {
        id: 'msg_cloned',
        sessionId: btwSessionId,
        role: 'user',
        createdAt: 1,
        agent: 'build',
        model: {
          providerId: 'test',
          modelId: 'test',
        },
      },
    }).event

    expect(shouldBufferSessionEvent({
      event: parentBusy,
      mainSessionId,
      isKnownChildSession: () => false,
    })).toBe(true)
    expect(shouldBufferSessionEvent({
      event: btwClone,
      mainSessionId,
      isKnownChildSession: () => false,
    })).toBe(false)
  })

  test('keeps the first child session.created so later child events can be recognized', () => {
    const childCreated = eventEntry({
      type: 'session.created',
      session: {
        id: childSessionId,
        title: 'task',
        directory: '/test',
        createdAt: 1,
        updatedAt: 1,
        version: '1',
        parentId: mainSessionId,
      },
    }).event

    expect(shouldBufferSessionEvent({
      event: childCreated,
      mainSessionId,
      isKnownChildSession: () => false,
    })).toBe(true)
  })

  test('keeps known child session events and global toasts', () => {
    const childBusy = eventEntry({
      type: 'status',
      sessionId: childSessionId,
      status: {
        state: 'busy',
      },
    }).event
    const toast = eventEntry({
      type: 'notice',
      title: 'ok',
      message: 'done',
      level: 'info',
    }).event
    const diff = eventEntry({
      type: 'session.diff',
      sessionId: mainSessionId,
    }).event

    expect(shouldBufferSessionEvent({
      event: childBusy,
      mainSessionId,
      isKnownChildSession: (sessionId) => sessionId === childSessionId,
    })).toBe(true)
    expect(shouldBufferSessionEvent({
      event: toast,
      mainSessionId,
      isKnownChildSession: () => false,
    })).toBe(true)
    expect(shouldBufferSessionEvent({
      event: diff,
      mainSessionId,
      isKnownChildSession: () => false,
    })).toBe(false)
  })

  test('drops scoped events until the thread session id is bound', () => {
    const parentBusy = eventEntry({
      type: 'status',
      sessionId: mainSessionId,
      status: {
        state: 'busy',
      },
    }).event
    const toast = eventEntry({
      type: 'notice',
      title: 'ok',
      message: 'done',
      level: 'info',
    }).event

    expect(shouldBufferSessionEvent({
      event: parentBusy,
      isKnownChildSession: () => false,
    })).toBe(false)
    expect(shouldBufferSessionEvent({
      event: toast,
      isKnownChildSession: () => false,
    })).toBe(true)
  })
})

describe('event buffer trim and busy derivation during task children', () => {
  const mainSessionId = 'ses_parent'
  const childSessionId = 'ses_task_child'

  function parentBusy(): EventBufferEntry {
    return eventEntry({
      type: 'status',
      sessionId: mainSessionId,
      status: {
        state: 'busy',
      },
    })
  }

  function runningTaskPart(): EventBufferEntry {
    return eventEntry({
      type: 'part',
      part: {
        id: 'prt_task',
        sessionId: mainSessionId,
        messageId: 'msg_asst',
        kind: 'tool',
        callId: 'call_task',
        tool: 'task',
        status: 'running',
        input: {
          subagent_type: 'mythos-review',
        },
        metadata: {
          sessionId: childSessionId,
        },
        subagent: {
          childSessionId,
          agent: 'mythos-review',
        },
      },
    })
  }

  function childPart(index: number): EventBufferEntry {
    return eventEntry({
      type: 'part',
      part: {
        id: `prt_child_${index}`,
        sessionId: childSessionId,
        messageId: 'msg_child',
        kind: 'text',
        text: 'child output',
      },
    })
  }

  test('isSessionBusy stays true for a running task even without status events', () => {
    expect(isSessionBusy({
      events: [runningTaskPart()],
      sessionId: mainSessionId,
    })).toBe(true)
  })

  // A delegation queued behind parallel ones is pending with no child session
  // yet, so it emits no child_session_started. It must still hold the queue.
  test('isSessionBusy stays true for a pending task that has no child session yet', () => {
    expect(isSessionBusy({
      events: [
        eventEntry({
          type: 'part',
          part: {
            id: 'prt_task_pending',
            sessionId: mainSessionId,
            messageId: 'msg_asst',
            kind: 'tool',
            callId: 'call_task_pending',
            tool: 'task',
            status: 'pending',
            input: {
              subagent_type: 'explore',
            },
            subagent: {
              agent: 'explore',
            },
          },
        }),
      ],
      sessionId: mainSessionId,
    })).toBe(true)
  })

  test('isSessionBusy is false after the same task call completes without status events', () => {
    const events = [
      runningTaskPart(),
      eventEntry({
        type: 'part',
        part: {
          id: 'prt_task',
          sessionId: mainSessionId,
          messageId: 'msg_asst',
          kind: 'tool',
          callId: 'call_task',
          tool: 'task',
          status: 'completed',
          input: {
            subagent_type: 'mythos-review',
          },
          output: 'done',
          metadata: {
            sessionId: childSessionId,
          },
          subagent: {
            childSessionId,
            agent: 'mythos-review',
          },
        },
      }),
    ]
    expect(isSessionBusy({ events, sessionId: mainSessionId })).toBe(false)
  })

  test('isSessionBusy is false after the running task errors and the session idles', () => {
    const events = [
      runningTaskPart(),
      eventEntry({
        type: 'part',
        part: {
          id: 'prt_task',
          sessionId: mainSessionId,
          messageId: 'msg_asst',
          kind: 'tool',
          callId: 'call_task',
          tool: 'task',
          status: 'error',
          input: {
            subagent_type: 'mythos-review',
          },
          error: 'Task cancelled',
          metadata: {
            sessionId: childSessionId,
          },
          subagent: {
            childSessionId,
            agent: 'mythos-review',
          },
        },
      }),
      eventEntry({
        type: 'idle',
        sessionId: mainSessionId,
      }),
    ]
    expect(isSessionBusy({ events, sessionId: mainSessionId })).toBe(false)
  })

  test('trim keeps parent busy across a child-session event flood', () => {
    const busy = parentBusy()
    const task = runningTaskPart()
    const events = [
      busy,
      task,
      ...Array.from({ length: 1000 }, (_, index) => childPart(index)),
    ]
    const trimmed = trimEventBuffer({
      events,
      mainSessionId,
      max: 1000,
      isKnownChildSession: (sessionId) => sessionId === childSessionId,
    })
    expect(trimmed.length).toBeLessThanOrEqual(1000)
    expect(isSessionBusy({ events: trimmed, sessionId: mainSessionId })).toBe(true)
  })

  test('shouldRetainSessionEvent drops child part updates but keeps parent task parts', () => {
    expect(shouldRetainSessionEvent({
      event: runningTaskPart().event,
      mainSessionId,
      isKnownChildSession: (sessionId) => sessionId === childSessionId,
    })).toBe(true)
    expect(shouldRetainSessionEvent({
      event: childPart(1).event,
      mainSessionId,
      isKnownChildSession: (sessionId) => sessionId === childSessionId,
    })).toBe(false)
    expect(shouldRetainSessionEvent({
      event: eventEntry({
        type: 'message',
        message: {
          id: 'msg_child',
          sessionId: childSessionId,
          role: 'assistant',
          createdAt: 1,
          agent: 'mythos-review',
          model: {
            providerId: 'test',
            modelId: 'test',
          },
          cost: 0,
        },
      }).event,
      mainSessionId,
      isKnownChildSession: (sessionId) => sessionId === childSessionId,
    })).toBe(true)
    expect(shouldBufferSessionEvent({
      event: childPart(1).event,
      mainSessionId,
      isKnownChildSession: (sessionId) => sessionId === childSessionId,
    })).toBe(true)
  })
})

describe('resolveActionParentSessionId', () => {
  const isChildSession = (sessionId: string) => sessionId === 'child'

  test('the thread session reports its cross-thread parent', () => {
    expect(state.resolveActionParentSessionId({
      eventSessionId: 'main', mainSessionId: 'main', threadParentSessionId: 'origin', isChildSession,
    })).toBe('origin')
  })

  test('a thread session started without a parent reports none', () => {
    expect(state.resolveActionParentSessionId({
      eventSessionId: 'main', mainSessionId: 'main', threadParentSessionId: undefined, isChildSession,
    })).toBeUndefined()
  })

  test('a delegated child reports the main session that spawned it', () => {
    expect(state.resolveActionParentSessionId({
      eventSessionId: 'child', mainSessionId: 'main', threadParentSessionId: 'origin', isChildSession,
    })).toBe('main')
  })

  test('an unrelated or missing session has no parent', () => {
    expect(state.resolveActionParentSessionId({
      eventSessionId: 'other', mainSessionId: 'main', threadParentSessionId: undefined, isChildSession,
    })).toBeUndefined()
    expect(state.resolveActionParentSessionId({
      eventSessionId: undefined, mainSessionId: 'main', threadParentSessionId: 'origin', isChildSession,
    })).toBeUndefined()
  })
})
