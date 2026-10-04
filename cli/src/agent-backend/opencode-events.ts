// Translate OpenCode's event stream into Roadie agent events (./events.ts).
// Returns undefined for OpenCode events Roadie does not consume (LSP, file
// watcher, installation, TUI chrome, ...), so new upstream event types are
// ignored rather than breaking the runtime.

import type {
  AssistantMessage,
  Event as OpenCodeEvent,
  Part as OpenCodePart,
  Session as OpenCodeSession,
  UserMessage,
} from '@opencode-ai/sdk/v2'
import type {
  AgentError,
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentSession,
  AgentStatus,
  AgentSubagentInfo,
  AgentUsage,
} from './events.js'
import { childSessionEventsForPart } from './events.js'

type OpenCodeTokens = {
  total?: number
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

// The SDK types mark token counts as required, but recorded streams contain
// step-finish parts and messages without them. Missing counts are zero.
function toUsage(tokens: OpenCodeTokens | undefined): AgentUsage {
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cacheRead: tokens?.cache?.read ?? 0,
    cacheWrite: tokens?.cache?.write ?? 0,
    ...(tokens?.total !== undefined && { total: tokens.total }),
  }
}

export function toAgentError(error: unknown): AgentError | undefined {
  if (!error || typeof error !== 'object') return undefined
  const { name, data } = error as { name?: unknown; data?: Record<string, unknown> }
  const message = typeof data?.message === 'string' ? data.message : undefined
  return {
    name: typeof name === 'string' ? name : 'UnknownError',
    message: message ?? (typeof name === 'string' ? name : 'Unknown error'),
    ...(typeof data?.statusCode === 'number' && { statusCode: data.statusCode }),
    ...(typeof data?.isRetryable === 'boolean' && { retryable: data.isRetryable }),
    ...(typeof data?.providerID === 'string' && { provider: data.providerID }),
  }
}

export function toAgentSession(info: OpenCodeSession): AgentSession {
  return {
    id: info.id,
    title: info.title,
    ...(info.parentID && { parentId: info.parentID }),
    ...(info.agent && { agent: info.agent }),
    ...(info.model && {
      model: {
        providerId: info.model.providerID,
        modelId: info.model.id,
        ...(info.model.variant && { variant: info.model.variant }),
      },
    }),
    ...(info.cost !== undefined && { cost: info.cost }),
    ...(info.tokens && { usage: toUsage(info.tokens) }),
  }
}

// Some OpenCode versions inline a message's parts on message.updated.
function inlinePartsOf(info: object): OpenCodePart[] {
  const parts = (info as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return []
  return parts.filter((part): part is OpenCodePart => {
    const candidate = part as { id?: unknown; type?: unknown; messageID?: unknown } | null
    return Boolean(candidate)
      && typeof candidate!.id === 'string'
      && typeof candidate!.type === 'string'
  })
}

export function toAgentMessage(info: UserMessage | AssistantMessage): AgentMessage {
  const inline = inlinePartsOf(info)
  const partsSummary = inline.length > 0 ? inline.map((p) => ({ id: p.id, type: p.type })) : undefined
  // Full parts only when they carry their message id, like streamed parts do.
  const fullParts = inline.filter((p) => typeof (p as { messageID?: unknown }).messageID === 'string')
  const parts = fullParts.length > 0 ? fullParts.map(toAgentPart) : undefined
  if (info.role === 'user') {
    return {
      id: info.id,
      sessionId: info.sessionID,
      role: 'user',
      createdAt: info.time.created,
      agent: info.agent,
      model: {
        providerId: info.model.providerID,
        modelId: info.model.modelID,
        ...(info.model.variant && { variant: info.model.variant }),
      },
      ...(info.system && { system: info.system }),
      ...(partsSummary && { partsSummary }),
      ...(parts && { parts }),
    }
  }
  const error = toAgentError(info.error)
  return {
    id: info.id,
    sessionId: info.sessionID,
    role: 'assistant',
    createdAt: info.time.created,
    ...(info.time.completed !== undefined && { completedAt: info.time.completed }),
    parentId: info.parentID,
    // `mode` is the older name for the agent; prefer `agent` when both exist.
    agent: info.agent || info.mode,
    model: {
      providerId: info.providerID,
      modelId: info.modelID,
      ...(info.variant && { variant: info.variant }),
    },
    cost: info.cost ?? 0,
    ...(info.tokens && { usage: toUsage(info.tokens) }),
    ...(error && { error }),
    ...(info.summary && { summary: true }),
    ...(info.finish && { finish: info.finish }),
    ...(partsSummary && { partsSummary }),
    ...(parts && { parts }),
  }
}

// OpenCode task tool parts carry delegation info in state: the spawned child
// session id lands in state.metadata.sessionId once the child exists, and the
// agent/description inputs name the delegation. In real streams the inputs are
// often dropped after the tool starts, so every field is optional.
function toTaskSubagentInfo(state: {
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}): AgentSubagentInfo {
  const metadataSessionId = state.metadata?.sessionId
  const agent = state.input?.subagent_type
  const description = state.input?.description
  return {
    ...(typeof metadataSessionId === 'string' && metadataSessionId && { childSessionId: metadataSessionId }),
    ...(typeof agent === 'string' && agent && { agent }),
    ...(typeof description === 'string' && description && { description }),
  }
}

export function toAgentPart(part: OpenCodePart): AgentPart {
  const base = { id: part.id, sessionId: part.sessionID, messageId: part.messageID }
  switch (part.type) {
    case 'text':
      return {
        ...base,
        kind: 'text',
        text: part.text,
        ...(part.synthetic && { synthetic: true }),
        ...(part.ignored && { ignored: true }),
        ...(part.metadata && { metadata: part.metadata }),
        ...(part.time?.start !== undefined && { startedAt: part.time.start }),
        ...(part.time?.end !== undefined && { endedAt: part.time.end }),
      }
    case 'reasoning':
      return {
        ...base,
        kind: 'reasoning',
        text: part.text,
        startedAt: part.time.start,
        ...(part.time.end !== undefined && { endedAt: part.time.end }),
      }
    case 'tool': {
      const state = part.state
      return {
        ...base,
        kind: 'tool',
        callId: part.callID,
        tool: part.tool,
        status: state.status,
        input: state.input,
        ...('title' in state && state.title && { title: state.title }),
        ...(state.status === 'completed' && { output: state.output }),
        ...(state.status === 'error' && { error: state.error }),
        ...('metadata' in state && state.metadata && { metadata: state.metadata }),
        ...(part.tool === 'task' && { subagent: toTaskSubagentInfo(state) }),
        ...('time' in state && { startedAt: state.time.start }),
        ...('time' in state && 'end' in state.time && { endedAt: state.time.end }),
        ...('time' in state && 'compacted' in state.time && typeof state.time.compacted === 'number' && {
          compactedAt: state.time.compacted,
        }),
      }
    }
    case 'step-start':
      return { ...base, kind: 'step-start' }
    case 'step-finish':
      return { ...base, kind: 'step-finish', reason: part.reason, cost: part.cost ?? 0, usage: toUsage(part.tokens) }
    case 'file':
      return {
        ...base,
        kind: 'file',
        mime: part.mime,
        url: part.url,
        ...(part.filename && { filename: part.filename }),
      }
    case 'snapshot':
      return { ...base, kind: 'other', type: part.type, detail: part.snapshot }
    default:
      return { ...base, kind: 'other', type: part.type }
  }
}

function toAgentStatus(status: { type: string; attempt?: number; message?: string; next?: number }): AgentStatus {
  if (status.type === 'retry') {
    return {
      state: 'retry',
      attempt: status.attempt ?? 0,
      message: status.message ?? '',
      nextAt: status.next ?? 0,
    }
  }
  return status.type === 'busy' ? { state: 'busy' } : { state: 'idle' }
}

export function toAgentEvent(event: OpenCodeEvent): AgentEvent | undefined {
  switch (event.type) {
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return { type: event.type, session: toAgentSession(event.properties.info) }
    case 'message.updated':
      return { type: 'message', message: toAgentMessage(event.properties.info) }
    case 'message.removed':
      return { type: 'message.removed', sessionId: event.properties.sessionID, messageId: event.properties.messageID }
    case 'message.part.updated':
      return { type: 'part', part: toAgentPart(event.properties.part) }
    case 'message.part.removed':
      return {
        type: 'part.removed',
        sessionId: event.properties.sessionID,
        messageId: event.properties.messageID,
        partId: event.properties.partID,
      }
    case 'message.part.delta':
      return {
        type: 'part.delta',
        sessionId: event.properties.sessionID,
        messageId: event.properties.messageID,
        partId: event.properties.partID,
        field: event.properties.field,
        delta: event.properties.delta,
      }
    case 'session.status':
      return { type: 'status', sessionId: event.properties.sessionID, status: toAgentStatus(event.properties.status) }
    case 'session.idle':
      return { type: 'idle', sessionId: event.properties.sessionID }
    case 'session.error': {
      const error = toAgentError(event.properties.error)
      return {
        type: 'error',
        ...(event.properties.sessionID && { sessionId: event.properties.sessionID }),
        ...(error && { error }),
      }
    }
    case 'session.diff':
      return { type: 'session.diff', sessionId: event.properties.sessionID }
    case 'permission.asked': {
      const request = event.properties
      return {
        type: 'permission.asked',
        request: {
          id: request.id,
          sessionId: request.sessionID,
          permission: request.permission,
          patterns: request.patterns,
          always: request.always,
          metadata: request.metadata,
          ...(request.tool && { toolCall: { messageId: request.tool.messageID, callId: request.tool.callID } }),
        },
      }
    }
    case 'permission.replied':
      return {
        type: 'permission.replied',
        sessionId: event.properties.sessionID,
        requestId: event.properties.requestID,
        reply: event.properties.reply,
      }
    case 'question.asked': {
      const request = event.properties
      return {
        type: 'question.asked',
        request: {
          id: request.id,
          sessionId: request.sessionID,
          questions: request.questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: q.options.map((o) => ({ label: o.label, description: o.description })),
            ...(q.multiple !== undefined && { multiple: q.multiple }),
            ...(q.custom !== undefined && { custom: q.custom }),
          })),
          ...(request.tool && { toolCall: { messageId: request.tool.messageID, callId: request.tool.callID } }),
        },
      }
    }
    case 'question.replied':
      return {
        type: 'question.replied',
        sessionId: event.properties.sessionID,
        requestId: event.properties.requestID,
        answers: event.properties.answers,
      }
    case 'question.rejected':
      return { type: 'question.rejected', sessionId: event.properties.sessionID, requestId: event.properties.requestID }
    case 'tui.toast.show':
      return {
        type: 'notice',
        ...(event.properties.title && { title: event.properties.title }),
        message: event.properties.message,
        level: event.properties.variant,
      }
    default:
      return undefined
  }
}

// Translate one OpenCode event into every Roadie agent event it implies:
// the direct translation plus child-session lifecycle events for task tool
// part updates. The runtime's event pump consumes this.
export function toAgentEvents(event: OpenCodeEvent): AgentEvent[] {
  const primary = toAgentEvent(event)
  if (!primary) {
    return []
  }
  if (primary.type !== 'part') {
    return [primary]
  }
  return [primary, ...childSessionEventsForPart(primary.part)]
}

// Persisted rows written before child-session events existed hold agent part
// events whose task tool part has no `subagent` field. Fill it in and emit the
// child-session events the row implies, so /fork-subagent, subtask labels and
// the busy check see delegations in older history. Rows already carrying
// `subagent` were written alongside their own child-session events and pass
// through unchanged.
export function upgradeLegacyAgentEvent(event: AgentEvent): AgentEvent[] {
  if (event.type !== 'part' || event.part.kind !== 'tool' || event.part.tool !== 'task' || event.part.subagent) {
    return [event]
  }
  const part: AgentPart = {
    ...event.part,
    subagent: toTaskSubagentInfo({ input: event.part.input, metadata: event.part.metadata }),
  }
  return [{ ...event, part }, ...childSessionEventsForPart(part)]
}
