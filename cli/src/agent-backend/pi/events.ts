// Pi RPC records → Roadie agent events (../events.ts).
//
// Pi messages carry no ids. Every message does carry a stable `timestamp`, the
// same in the live stream and in `get_messages`, so ids are derived from it:
// message `pi-<role>-<timestamp>`, content part `<messageId>-<contentIndex>`,
// tool part the tool call id. Live events and history then agree, which the
// runtime needs to de-duplicate parts it already rendered.
//
// The translator is per session because Pi's stream is per process and the
// runtime needs to know which user message an assistant reply answers.

import { childSessionEventsForPart } from '../events.js'
import type {
  AgentError,
  AgentEvent,
  AgentMessage,
  AgentModelRef,
  AgentPart,
  AgentSubagentInfo,
  AgentUsage,
} from '../events.js'
import type { PiRecord } from './rpc.js'
import { ROADIE_CONTEXT_TYPE } from './roadie-extension.js'

type PiContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'image'; mimeType?: string; data?: string }

type PiUsage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  cost?: { total?: number }
}

export type PiMessage =
  | { role: 'user'; content: string | PiContent[]; timestamp: number }
  | {
      role: 'assistant'
      content: PiContent[]
      provider?: string
      model?: string
      usage?: PiUsage
      stopReason?: string
      errorMessage?: string
      timestamp: number
    }
  | {
      role: 'toolResult'
      toolCallId: string
      toolName: string
      content: PiContent[]
      isError?: boolean
      timestamp: number
    }
  | { role: string; timestamp: number; content?: unknown; customType?: string }

type PiAssistantMessage = Extract<PiMessage, { role: 'assistant' }>

/** A context-only message the backend recorded through the append command: Pi stores it as a custom message, the model reads it as a user turn. */
export function isContextMessage(message: PiMessage): boolean {
  return message.role === 'custom' && message.customType === ROADIE_CONTEXT_TYPE
}

export function piMessageId(message: { role: string; timestamp: number }): string {
  return `pi-${message.role}-${message.timestamp}`
}

function contentList(content: unknown): PiContent[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as PiContent[]) : []
}

function textOf(content: unknown): string {
  return contentList(content)
    .flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join('\n')
}

export function toUsage(usage: PiUsage | undefined): AgentUsage {
  const result: AgentUsage = {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    reasoning: 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
  }
  const sum = result.input + result.output + result.cacheRead + result.cacheWrite
  if (usage?.totalTokens !== undefined && usage.totalTokens !== sum) result.total = usage.totalTokens
  return result
}

function toFinish(stopReason: string | undefined): string | undefined {
  if (stopReason === 'toolUse') return 'tool-calls'
  if (stopReason === 'stop' || stopReason === 'length') return stopReason
  return undefined
}

function toError(message: PiAssistantMessage): AgentError | undefined {
  if (message.stopReason === 'aborted') {
    return { name: 'MessageAbortedError', message: message.errorMessage || 'Aborted', ...(message.provider && { provider: message.provider }) }
  }
  if (message.stopReason === 'error') {
    return { name: 'APIError', message: message.errorMessage || 'Model request failed', ...(message.provider && { provider: message.provider }) }
  }
  return undefined
}

function toModel(message: PiAssistantMessage): AgentModelRef | undefined {
  return message.provider && message.model ? { providerId: message.provider, modelId: message.model } : undefined
}

export function toAgentMessage({
  message,
  sessionId,
  parentId,
  completed,
}: {
  message: PiMessage
  sessionId: string
  parentId?: string
  completed: boolean
}): AgentMessage | undefined {
  const id = piMessageId(message)
  if (message.role === 'user' || isContextMessage(message)) {
    return { id, sessionId, role: 'user', createdAt: message.timestamp }
  }
  if (message.role !== 'assistant') return undefined
  const assistant = message as PiAssistantMessage
  const model = toModel(assistant)
  const error = completed ? toError(assistant) : undefined
  const finish = completed ? toFinish(assistant.stopReason) : undefined
  return {
    id,
    sessionId,
    role: 'assistant',
    createdAt: assistant.timestamp,
    ...(completed && { completedAt: Date.now() }),
    ...(parentId && { parentId }),
    ...(model && { model }),
    ...(completed && assistant.usage && { usage: toUsage(assistant.usage), cost: assistant.usage.cost?.total ?? 0 }),
    ...(error && { error }),
    ...(finish && { finish }),
  }
}

/** The Roadie parts for a whole message, as stored. Tool results are merged in by call id. */
export function toAgentParts({
  message,
  sessionId,
  toolResults,
}: {
  message: PiMessage
  sessionId: string
  toolResults?: Map<string, Extract<PiMessage, { role: 'toolResult' }>>
}): AgentPart[] {
  const messageId = piMessageId(message)
  if (message.role !== 'user' && message.role !== 'assistant' && !isContextMessage(message)) return []
  const parts: AgentPart[] = contentList(message.content).flatMap((item, index): AgentPart[] => {
    const base = { id: `${messageId}-${index}`, sessionId, messageId }
    if (item.type === 'text') {
      return [{ ...base, kind: 'text', text: item.text, startedAt: message.timestamp, endedAt: message.timestamp }]
    }
    if (item.type === 'thinking') {
      return [{ ...base, kind: 'reasoning', text: item.thinking, startedAt: message.timestamp, endedAt: message.timestamp }]
    }
    if (item.type === 'toolCall') {
      const result = toolResults?.get(item.id)
      return [{
        id: item.id,
        sessionId,
        messageId,
        kind: 'tool',
        callId: item.id,
        tool: item.name,
        input: item.arguments ?? {},
        status: result ? (result.isError ? 'error' : 'completed') : 'completed',
        ...(result && !result.isError && { output: textOf(result.content) }),
        ...(result?.isError && { error: textOf(result.content) }),
      }]
    }
    return [{ ...base, kind: 'other', type: item.type }]
  })
  if (message.role === 'assistant') {
    const assistant = message as PiAssistantMessage
    parts.push({
      id: `${messageId}-finish`,
      sessionId,
      messageId,
      kind: 'step-finish',
      reason: assistant.stopReason ?? 'stop',
      cost: assistant.usage?.cost?.total ?? 0,
      usage: toUsage(assistant.usage),
    })
  }
  return parts
}

/** The last non-empty assistant text in a message list, as a task result. */
export function finalAssistantText(messages: PiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue
    const text = textOf((message as PiAssistantMessage).content).trim()
    if (text) return text
  }
  return ''
}

/** `get_messages` output as Roadie session messages, tool results folded into their calls. */
export function toAgentHistory({
  messages,
  sessionId,
}: {
  messages: PiMessage[]
  sessionId: string
}): Array<{ message: AgentMessage; parts: AgentPart[] }> {
  const toolResults = new Map<string, Extract<PiMessage, { role: 'toolResult' }>>()
  for (const message of messages) {
    if (message.role === 'toolResult') {
      const result = message as Extract<PiMessage, { role: 'toolResult' }>
      toolResults.set(result.toolCallId, result)
    }
  }
  let lastUserId: string | undefined
  return messages.flatMap((message) => {
    const agentMessage = toAgentMessage({ message, sessionId, parentId: lastUserId, completed: true })
    if (!agentMessage) return []
    if (message.role === 'user' || isContextMessage(message)) lastUserId = agentMessage.id
    // History has no completion time; the creation time is the closest stable value.
    if (agentMessage.role === 'assistant') agentMessage.completedAt = message.timestamp
    return [{ message: agentMessage, parts: toAgentParts({ message, sessionId, toolResults }) }]
  })
}

type ToolState = { messageId: string; tool: string; input: Record<string, unknown>; subagent?: AgentSubagentInfo; startedAt?: number }

/** Stateful translation of one session's live stream. */
export class PiEventTranslator {
  private lastUserId: string | undefined
  private assistantId: string | undefined
  private assistantStartedAt: number | undefined
  private tools = new Map<string, ToolState>()

  constructor(readonly sessionId: string) {}

  /** The assistant message that issued a tool call, when the stream showed it. */
  messageIdForCall(callId: string): string | undefined {
    return this.tools.get(callId)?.messageId ?? this.assistantId
  }

  /**
   * Record that a tool call spawned a child session (the task tool; Roadie's
   * backend answers the extension's roadie:task request). The stored info rides
   * on every later part update for the call, like OpenCode's task parts. The
   * returned running update makes child_session_started fire even though the
   * earlier running part predated the child session.
   */
  registerSubagent(callId: string, info: AgentSubagentInfo): AgentEvent[] {
    const known = this.tools.get(callId)
    const state: ToolState = {
      messageId: known?.messageId ?? this.assistantId ?? 'pi-assistant-unknown',
      tool: known?.tool ?? 'task',
      input: known?.input ?? {},
      subagent: info,
      startedAt: known?.startedAt,
    }
    this.tools.set(callId, state)
    const part: AgentPart = {
      id: callId,
      sessionId: this.sessionId,
      messageId: state.messageId,
      kind: 'tool',
      callId,
      tool: state.tool,
      status: 'running',
      input: state.input,
      subagent: info,
      ...(state.startedAt !== undefined && { startedAt: state.startedAt }),
    }
    return [{ type: 'part', part }, ...childSessionEventsForPart(part)]
  }

  /** One Pi record as Roadie events, plus the child-session lifecycle its delegation part implies. */
  translate(record: PiRecord): AgentEvent[] {
    return this.translateRecord(record).flatMap((event): AgentEvent[] => (event.type === 'part' ? [event, ...childSessionEventsForPart(event.part)] : [event]))
  }

  private translateRecord(record: PiRecord): AgentEvent[] {
    const sessionId = this.sessionId
    switch (record.type) {
      case 'agent_start':
        return [{ type: 'status', sessionId, status: { state: 'busy' } }]
      case 'agent_end':
        this.assistantId = undefined
        return [{ type: 'status', sessionId, status: { state: 'idle' } }, { type: 'idle', sessionId }]
      case 'message_start':
        return this.messageStart(record.message as PiMessage)
      case 'message_update':
        // Pi 1.x drops `message` from updates; the id comes from message_start.
        return this.messageUpdate(record.message as PiAssistantMessage | undefined, record.assistantMessageEvent as Record<string, unknown>)
      case 'message_end':
        return this.messageEnd(record.message as PiMessage)
      case 'tool_execution_start':
        return this.toolEvent(record.toolCallId as string, record.toolName as string, { status: 'running', input: record.args as Record<string, unknown>, startedAt: Date.now() })
      case 'tool_execution_end': {
        const result = record.result as { content?: unknown; details?: { title?: unknown } } | undefined
        const text = textOf(result?.content)
        const title = typeof result?.details?.title === 'string' ? result.details.title : undefined
        return this.toolEvent(record.toolCallId as string, record.toolName as string, record.isError
          ? { status: 'error', error: text, endedAt: Date.now() }
          : { status: 'completed', output: text, endedAt: Date.now(), ...(title && { title }) })
      }
      case 'auto_retry_start':
        return [{
          type: 'status',
          sessionId,
          status: {
            state: 'retry',
            attempt: Number(record.attempt ?? 1),
            message: String(record.errorMessage ?? ''),
            nextAt: Date.now() + Number(record.delayMs ?? 0),
          },
        }]
      case 'auto_retry_end':
        return record.success
          ? [{ type: 'status', sessionId, status: { state: 'busy' } }]
          : [{ type: 'error', sessionId, error: { name: 'APIError', message: String(record.finalError ?? 'Retries exhausted') } }]
      case 'compaction_end':
        return record.errorMessage
          ? [{ type: 'notice', message: `Compaction failed: ${String(record.errorMessage)}`, level: 'warning' }]
          : []
      case 'extension_error':
        return [{ type: 'notice', title: 'Pi extension error', message: String(record.error ?? ''), level: 'error' }]
      default:
        return []
    }
  }

  private messageStart(message: PiMessage): AgentEvent[] {
    const sessionId = this.sessionId
    if (message.role === 'user' || isContextMessage(message)) {
      const agentMessage = toAgentMessage({ message, sessionId, completed: true })!
      this.lastUserId = agentMessage.id
      return [
        { type: 'message', message: agentMessage },
        ...toAgentParts({ message, sessionId }).map((part): AgentEvent => ({ type: 'part', part })),
      ]
    }
    if (message.role !== 'assistant') return []
    const agentMessage = toAgentMessage({ message, sessionId, parentId: this.lastUserId, completed: false })!
    this.assistantId = agentMessage.id
    this.assistantStartedAt = message.timestamp
    return [{ type: 'message', message: agentMessage }]
  }

  private messageUpdate(message: PiAssistantMessage | undefined, event: Record<string, unknown>): AgentEvent[] {
    const sessionId = this.sessionId
    const messageId = message ? piMessageId(message) : this.assistantId
    if (!messageId) return []
    const startedAt = message?.timestamp ?? this.assistantStartedAt ?? Date.now()
    const index = Number(event.contentIndex ?? 0)
    const partId = `${messageId}-${index}`
    switch (event.type) {
      case 'text_start':
        return [{ type: 'part', part: { id: partId, sessionId, messageId, kind: 'text', text: '', startedAt: Date.now() } }]
      case 'thinking_start':
        return [{ type: 'part', part: { id: partId, sessionId, messageId, kind: 'reasoning', text: '', startedAt: Date.now() } }]
      case 'text_delta':
      case 'thinking_delta':
        return [{ type: 'part.delta', sessionId, messageId, partId, field: 'text', delta: String(event.delta ?? '') }]
      case 'text_end':
        return [{ type: 'part', part: { id: partId, sessionId, messageId, kind: 'text', text: String(event.content ?? ''), startedAt, endedAt: Date.now() } }]
      case 'thinking_end':
        return [{ type: 'part', part: { id: partId, sessionId, messageId, kind: 'reasoning', text: String(event.content ?? ''), startedAt, endedAt: Date.now() } }]
      case 'toolcall_end': {
        const call = event.toolCall as { id: string; name: string; arguments?: Record<string, unknown> }
        this.tools.set(call.id, { messageId, tool: call.name, input: call.arguments ?? {} })
        return [{ type: 'part', part: { id: call.id, sessionId, messageId, kind: 'tool', callId: call.id, tool: call.name, status: 'pending', input: call.arguments ?? {} } }]
      }
      default:
        return []
    }
  }

  private messageEnd(message: PiMessage): AgentEvent[] {
    if (message.role !== 'assistant') return []
    const sessionId = this.sessionId
    const agentMessage = toAgentMessage({ message, sessionId, parentId: this.lastUserId, completed: true })!
    const assistant = message as PiAssistantMessage
    const error = toError(assistant)
    return [
      { type: 'message', message: agentMessage },
      {
        type: 'part',
        part: {
          id: `${agentMessage.id}-finish`,
          sessionId,
          messageId: agentMessage.id,
          kind: 'step-finish',
          reason: assistant.stopReason ?? 'stop',
          cost: assistant.usage?.cost?.total ?? 0,
          usage: toUsage(assistant.usage),
        },
      },
      ...(error ? [{ type: 'error' as const, sessionId, error }] : []),
    ]
  }

  private toolEvent(
    callId: string,
    toolName: string,
    update: { status: 'running' | 'completed' | 'error'; input?: Record<string, unknown>; output?: string; error?: string; title?: string; startedAt?: number; endedAt?: number },
  ): AgentEvent[] {
    const known = this.tools.get(callId)
    const state: ToolState = {
      messageId: known?.messageId ?? this.assistantId ?? `pi-assistant-unknown`,
      tool: known?.tool ?? toolName,
      input: update.input ?? known?.input ?? {},
      subagent: known?.subagent,
      startedAt: update.startedAt ?? known?.startedAt,
    }
    this.tools.set(callId, state)
    if (update.status !== 'running') this.tools.delete(callId)
    return [{
      type: 'part',
      part: {
        id: callId,
        sessionId: this.sessionId,
        messageId: state.messageId,
        kind: 'tool',
        callId,
        tool: state.tool,
        status: update.status,
        input: state.input,
        ...(state.subagent && { subagent: state.subagent }),
        ...(update.output !== undefined && { output: update.output }),
        ...(update.title !== undefined && { title: update.title }),
        ...(update.error !== undefined && { error: update.error }),
        ...(state.startedAt !== undefined && { startedAt: state.startedAt }),
        ...(update.endedAt !== undefined && { endedAt: update.endedAt }),
      },
    }]
  }
}
