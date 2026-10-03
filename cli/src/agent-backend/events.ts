// Roadie's agent events: what the session runtime needs to hear from an agent
// backend, in Roadie's own terms. Each backend translates its native stream
// into these (OpenCode: ./opencode-events.ts).
//
// Derived from what the runtime and event-stream-state actually read today.
// Add a field only when a consumer needs it.
//
// How each event maps to a Pi RPC backend (earendil-works/pi, docs/rpc.md),
// checked on paper so gaps show up before a Pi backend exists (#51):
//
//   session.created/updated   new_session / set_session_name responses, get_state
//   message                   message_start / message_end (role, usage on end)
//   part (text, reasoning)    message_update text/thinking deltas, closed at message_end
//   part (tool)               tool_execution_start / _update / _end
//   part (step-finish)        turn_end (usage per turn)
//   part.delta                message_update assistantMessageEvent text_delta
//   status busy/idle          agent_start / agent_end
//   status retry              auto_retry_start / auto_retry_end
//   idle                      agent_end
//   error                     agent_end with error, extension_error
//   permission.asked/replied  Roadie-owned policy (#50) via the tool_call hook;
//                             Pi has no permission events of its own
//   question.asked/replied    extension_ui_request select / extension_ui_response
//   notice                    extension_ui_request notify
//   session.diff              no Pi equivalent; optional
//
// Gaps: Pi has no session-tree "parent session" for forks the way OpenCode
// task sessions do, and no server-side diff summary. Both are optional here.

export type AgentUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** Provider-reported total when it differs from the sum. */
  total?: number
}

export type AgentModelRef = {
  providerId: string
  modelId: string
  variant?: string
}

export type AgentError = {
  /** Backend error class, e.g. "MessageAbortedError", "APIError". */
  name: string
  message: string
  statusCode?: number
  retryable?: boolean
}

export type AgentSession = {
  id: string
  title: string
  parentId?: string
  agent?: string
  model?: AgentModelRef
  cost?: number
  usage?: AgentUsage
}

export type AgentMessage = {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  createdAt: number
  completedAt?: number
  /** For assistant messages: the user message this answers. */
  parentId?: string
  agent?: string
  model?: AgentModelRef
  cost?: number
  usage?: AgentUsage
  error?: AgentError
  /** Compaction summary message. */
  summary?: boolean
  finish?: string
  /** Per-message system prompt, user messages only. */
  system?: string
  /** Ids and types of the message's parts, when the backend reports them inline. */
  partsSummary?: Array<{ id: string; type: string }>
}

export type AgentToolStatus = 'pending' | 'running' | 'completed' | 'error'

type PartBase = {
  id: string
  sessionId: string
  messageId: string
}

export type AgentPart = PartBase & (
  | {
      kind: 'text'
      text: string
      /** Injected by the harness, not typed by a person or the model. */
      synthetic?: boolean
      /** Kept in history but not sent to the model. */
      ignored?: boolean
      metadata?: Record<string, unknown>
      startedAt?: number
      endedAt?: number
    }
  | { kind: 'reasoning'; text: string; startedAt?: number; endedAt?: number }
  | {
      kind: 'tool'
      callId: string
      tool: string
      status: AgentToolStatus
      input: Record<string, unknown>
      title?: string
      output?: string
      error?: string
      metadata?: Record<string, unknown>
      startedAt?: number
      endedAt?: number
      /** When the backend pruned this tool's output from the model context. */
      compactedAt?: number
    }
  | { kind: 'step-start' }
  | { kind: 'step-finish'; reason: string; cost: number; usage: AgentUsage }
  | { kind: 'file'; mime: string; url: string; filename?: string }
  /** A part type Roadie does not render. Kept so ordering stays intact. */
  | { kind: 'other'; type: string }
)

export type AgentStatus =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'retry'; attempt: number; message: string; nextAt: number }

export type AgentPermissionRequest = {
  id: string
  sessionId: string
  /** The permission being asked for, e.g. "bash", "edit", "external_directory". */
  permission: string
  patterns: string[]
  /** Patterns an "always allow" answer would add. */
  always: string[]
  metadata: Record<string, unknown>
  toolCall?: { messageId: string; callId: string }
}

export type AgentQuestion = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiple?: boolean
  /** Whether a free-text answer is allowed. */
  custom?: boolean
}

export type AgentQuestionRequest = {
  id: string
  sessionId: string
  questions: AgentQuestion[]
  toolCall?: { messageId: string; callId: string }
}

export type AgentEvent =
  | { type: 'session.created' | 'session.updated' | 'session.deleted'; session: AgentSession }
  | { type: 'message'; message: AgentMessage }
  | { type: 'message.removed'; sessionId: string; messageId: string }
  | { type: 'part'; part: AgentPart }
  | { type: 'part.removed'; sessionId: string; messageId: string; partId: string }
  | {
      type: 'part.delta'
      sessionId: string
      messageId: string
      partId: string
      /** Which text field grows, e.g. "text". */
      field: string
      delta: string
    }
  | { type: 'status'; sessionId: string; status: AgentStatus }
  | { type: 'idle'; sessionId: string }
  | { type: 'error'; sessionId?: string; error?: AgentError }
  | { type: 'session.diff'; sessionId: string }
  | { type: 'permission.asked'; request: AgentPermissionRequest }
  | { type: 'permission.replied'; sessionId: string; requestId: string; reply: 'once' | 'always' | 'reject' }
  | { type: 'question.asked'; request: AgentQuestionRequest }
  | { type: 'question.replied'; sessionId: string; requestId: string; answers: string[][] }
  | { type: 'question.rejected'; sessionId: string; requestId: string }
  /** A transient message for the user, not tied to a session. */
  | { type: 'notice'; title?: string; message: string; level: 'info' | 'success' | 'warning' | 'error' }

export type AgentEventType = AgentEvent['type']

/** The session an event belongs to, if any. */
export function agentEventSessionId(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return event.session.id
    case 'message':
      return event.message.sessionId
    case 'part':
      return event.part.sessionId
    case 'permission.asked':
    case 'question.asked':
      return event.request.sessionId
    case 'error':
      return event.sessionId
    case 'notice':
      return undefined
    default:
      return event.sessionId
  }
}
