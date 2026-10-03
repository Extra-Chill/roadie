// Pure event-stream derivation functions for session lifecycle state.
// These functions derive lifecycle decisions from an event buffer array of
// Roadie agent events (../agent-backend/events.ts), independent of which
// agent backend produced them.
// Zero imports from thread-session-runtime.ts, store.ts, or state.ts.

import {
  agentEventSessionId,
  type AgentEvent,
  type AgentMessage,
  type AgentPart,
  type AgentUsage,
} from '../agent-backend/events.js'

/** Buffer-only marker: a queued prompt was handed to a pending question. */
export type QueueQuestionHandoffStartedEvent = {
  type: 'queue.question-handoff-started'
  sessionId: string
}

export type EventBufferEvent = AgentEvent | QueueQuestionHandoffStartedEvent

export type EventBufferEntry = {
  event: EventBufferEvent
  timestamp: number
  eventIndex?: number
}

export function getEventBufferSessionId(event: EventBufferEvent): string | undefined {
  if (event.type === 'queue.question-handoff-started') {
    return event.sessionId
  }
  return agentEventSessionId(event)
}

type AssistantMessage = AgentMessage & { role: 'assistant' }
type UserMessage = AgentMessage & { role: 'user' }

function isCompactionContinuePart(part: AgentPart): boolean {
  if (part.kind !== 'text') {
    return false
  }
  return part.synthetic === true && part.metadata?.compaction_continue === true
}

function isInternalOpenCodeUserMessageId({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  let sawPart = false
  let hasUserTurnInput = false
  let hasIgnoredNotice = false
  for (let i = 0; i <= end; i++) {
    const event = events[i]?.event
    if (event?.type !== 'part') {
      continue
    }
    const part = event.part
    if (part.sessionId !== sessionId || part.messageId !== messageId) {
      continue
    }
    sawPart = true
    if (part.kind === 'other' && part.type === 'compaction') {
      return true
    }
    if (isCompactionContinuePart(part)) {
      return true
    }
    if (part.kind === 'text') {
      if (part.synthetic === true) {
        continue
      }
      if (part.ignored === true) {
        hasIgnoredNotice = true
        continue
      }
      if (part.text?.trim()) {
        hasUserTurnInput = true
      }
      continue
    }
    hasUserTurnInput = true
  }
  return sawPart && hasIgnoredNotice && !hasUserTurnInput
}

function isUserFacingAssistantMessage(message: AgentMessage): boolean {
  return message.summary !== true
}

export type AssistantMessageKind = 'user-facing' | 'summary' | 'unknown'

export function getAssistantMessageKind({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): AssistantMessageKind {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (event?.type !== 'message') {
      continue
    }
    const info = event.message
    if (info.sessionId !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
      continue
    }
    return info.summary === true ? 'summary' : 'user-facing'
  }
  return 'unknown'
}

function getTaskChildSessionId({
  part,
}: {
  part: Extract<AgentPart, { kind: 'tool' }>
}): string | undefined {
  // Event-shape reference:
  // - cli/src/session-handler/event-stream-fixtures/real-session-task-three-parallel-sleeps.jsonl
  // - In real task events, state.metadata.sessionId appears on running/completed
  //   tool updates and is the canonical child-session identifier.
  // We intentionally do not parse state.output because it is user-facing text
  // and can change format across providers/versions.
  const metadataValue = part.metadata
  const metadataSessionId =
    metadataValue && typeof metadataValue === 'object'
      ? (metadataValue as { sessionId?: unknown }).sessionId
      : undefined
  if (typeof metadataSessionId === 'string' && metadataSessionId.length > 0) {
    return metadataSessionId
  }
  return undefined
}

function getTaskCandidateFromEvent({
  event,
  mainSessionId,
}: {
  event: EventBufferEvent
  mainSessionId: string
}): {
  assistantMessageId: string
  childSessionId: string
  subagentType?: string
  description?: string
} | undefined {
  if (event.type !== 'part') {
    return undefined
  }

  const part = event.part
  if (part.sessionId !== mainSessionId) {
    return undefined
  }
  if (part.kind !== 'tool' || part.tool !== 'task' || part.status === 'pending') {
    return undefined
  }

  const childSessionId = getTaskChildSessionId({ part })
  if (!childSessionId) {
    return undefined
  }

  const subagentType = part.input?.subagent_type
  const description = part.input?.description
  return {
    assistantMessageId: part.messageId,
    childSessionId,
    subagentType: typeof subagentType === 'string' ? subagentType : undefined,
    description: typeof description === 'string' ? description : undefined,
  }
}

export type DerivedSubagentSession = {
  childSessionId: string
  subagentType?: string
  description?: string
  timestamp: number
}

function getTaskPartStatus(
  event: EventBufferEvent,
  sessionId: string,
): { callID: string; status: string } | undefined {
  if (event.type !== 'part') {
    return undefined
  }
  const part = event.part
  if (part.sessionId !== sessionId || part.kind !== 'tool' || part.tool !== 'task') {
    return undefined
  }
  const callID = part.callId || part.id
  if (!callID) {
    return undefined
  }
  return { callID, status: part.status }
}

// Scans backward for most recent session-scoped lifecycle event.
// Returns true if the latest lifecycle event for sessionId is session.status busy.
// If status/idle were evicted from the bounded buffer, a still-running task
// tool on that session also counts as busy. That stops `. queue` from draining
// (and the 3s interrupt plugin from aborting) while a subagent is in flight.
export function isSessionBusy({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  const latestTaskStatusByCallId = new Map<string, string>()
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    const eid = getEventBufferSessionId(e)
    if (eid !== sessionId) {
      continue
    }
    if (e.type === 'idle') {
      return false
    }
    if (e.type === 'status') {
      return e.status.state === 'busy'
    }
    const taskPart = getTaskPartStatus(e, sessionId)
    if (taskPart && !latestTaskStatusByCallId.has(taskPart.callID)) {
      latestTaskStatusByCallId.set(taskPart.callID, taskPart.status)
    }
  }
  return [...latestTaskStatusByCallId.values()].some((status) => {
    return status === 'running' || status === 'pending'
  })
}

export function didQuestionQueueHandoffSinceLatestQuestionAsked({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    const eventSessionId = getEventBufferSessionId(event)
    if (eventSessionId !== sessionId) {
      continue
    }
    if (event.type === 'queue.question-handoff-started') {
      return true
    }
    if (event.type === 'question.asked') {
      return false
    }
  }
  return false
}

export type DerivedUnansweredQuestion = {
  id: string
  questions: Array<{
    question: string
    header: string
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean
  }>
  tool?: {
    messageID: string
    callID: string
  }
}

// OpenCode emits question.asked when the tool starts, often before the
// preceding text part gets time.end. Discord must wait for that end event
// or the question UI posts first and the text dumps later.
export function isAssistantTextReadyForQuestion({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || event.type !== 'part') {
      continue
    }
    const part = event.part
    if (part.sessionId !== sessionId) {
      continue
    }
    if (part.messageId !== messageId) {
      continue
    }
    if (part.kind !== 'text') {
      continue
    }
    return Boolean(part.endedAt)
  }
  return true
}

export function deriveLatestUnansweredQuestion({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): DerivedUnansweredQuestion | undefined {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (getEventBufferSessionId(event) !== sessionId) {
      continue
    }
    if (event.type === 'question.replied' || event.type === 'question.rejected') {
      return undefined
    }
    if (event.type === 'part') {
      const part = event.part
      if (
        part.kind === 'tool'
        && part.tool === 'question'
        && (part.status === 'error' || part.status === 'completed')
      ) {
        return undefined
      }
    }
    if (event.type === 'question.asked') {
      const messageId = event.request.toolCall?.messageId
      const latestUserMessage = getLatestUserMessage({
        events,
        sessionId,
        upToIndex: end,
      })
      if (
        messageId
        && latestUserMessage
        && !isAssistantMessageInLatestUserTurn({
          events,
          sessionId,
          messageId,
          upToIndex: end,
        })
      ) {
        return undefined
      }
      const { request } = event
      return {
        id: request.id,
        questions: request.questions,
        ...(request.toolCall && {
          tool: { messageID: request.toolCall.messageId, callID: request.toolCall.callId },
        }),
      }
    }
  }
  return undefined
}

export function derivePendingPermissionRequests({
  events,
  sessionId,
}: {
  events: EventBufferEntry[]
  sessionId: string
}): string[] {
  const permissions = new Set<string>()

  for (const entry of events) {
    const event = entry.event
    const eventSessionId = getEventBufferSessionId(event)
    if (eventSessionId !== sessionId) {
      continue
    }

    if (event.type === 'permission.asked') {
      permissions.add(event.request.id)
      continue
    }

    if (event.type === 'permission.replied') {
      permissions.delete(event.requestId)
    }
  }

  return [...permissions]
}

export function isAssistantMessageNaturalCompletion({
  message,
}: {
  message: AgentMessage
}): boolean {
  if (!isUserFacingAssistantMessage(message)) {
    return false
  }
  if (typeof message.completedAt !== 'number') {
    return false
  }
  if (message.error) {
    return false
  }
  // finish="tool-calls" means the model's last step was tool execution.
  // Mid-turn tool-call steps don't get footers — the footer comes from the
  // final text response (finish="stop") that follows. If the turn ends with
  // only tool-calls and no text follow-up, no footer is emitted. This is
  // acceptable since models almost always follow up with text after tools.
  return message.finish !== 'tool-calls'
}

export function hasAssistantMessageCompletedBefore({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message') {
      continue
    }
    const info = event.message
    if (info.sessionId !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
      continue
    }
    if (typeof info.completedAt === 'number') {
      return true
    }
  }
  return false
}

export function getLatestUserMessage({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): UserMessage | undefined {
  const end = upToIndex ?? events.length - 1
  let latestUserMessage: UserMessage | undefined
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message') {
      continue
    }
    const info = event.message
    if (info.sessionId !== sessionId || info.role !== 'user') {
      continue
    }
    if (isInternalOpenCodeUserMessageId({
      events,
      sessionId,
      messageId: info.id,
      upToIndex: end,
    })) {
      continue
    }
    if (!latestUserMessage) {
      latestUserMessage = info as UserMessage
      continue
    }
    if (info.createdAt > latestUserMessage.createdAt) {
      latestUserMessage = info as UserMessage
    }
  }
  return latestUserMessage
}

export function getCurrentTurnStartTime({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): number | undefined {
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  return latestUserMessage?.createdAt
}

// Token total helper — sum of input + output + reasoning + cache read + cache write
function getTokenTotal(usage: AgentUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

export type TurnTokenUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  model: string | undefined
  providerID: string | undefined
  assistantMessageCount: number
  userMessageId: string | undefined
}

function emptyTurnTokenUsage(): TurnTokenUsage {
  return {
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
    userMessageId: undefined,
  }
}

function addAssistantTokens({
  usage,
  message,
}: {
  usage: TurnTokenUsage
  message: AssistantMessage
}): void {
  if (message.usage) {
    usage.input += message.usage.input
    usage.output += message.usage.output
    usage.reasoning += message.usage.reasoning
    usage.cacheRead += message.usage.cacheRead
    usage.cacheWrite += message.usage.cacheWrite
    usage.total += message.usage.total ?? getTokenTotal(message.usage)
  }
  usage.cost += message.cost ?? 0
  usage.model = message.model?.modelId
  usage.providerID = message.model?.providerId
}

function sumAssistantMessages({
  messages,
  userMessageId,
}: {
  messages: Map<string, AssistantMessage>
  userMessageId?: string
}): TurnTokenUsage {
  if (messages.size === 0) {
    return {
      ...emptyTurnTokenUsage(),
      userMessageId,
    }
  }
  const usage = emptyTurnTokenUsage()
  usage.userMessageId = userMessageId
  usage.assistantMessageCount = messages.size
  for (const message of messages.values()) {
    addAssistantTokens({ usage, message })
  }
  return usage
}

function collectAssistantMessages({
  events,
  sessionId,
  upToIndex,
  parentID,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex: number
  parentID?: string
}): Map<string, AssistantMessage> {
  const latestByMessageId = new Map<string, AssistantMessage>()
  for (let i = 0; i <= upToIndex; i++) {
    const event = events[i]?.event
    if (event?.type !== 'message') {
      continue
    }
    const info = event.message
    if (info.sessionId !== sessionId || info.role !== 'assistant') {
      continue
    }
    if (parentID && info.parentId !== parentID) {
      continue
    }
    latestByMessageId.set(info.id, info as AssistantMessage)
  }
  return latestByMessageId
}

function getSessionInfoTokenUsage({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex: number
}): TurnTokenUsage | undefined {
  for (let i = upToIndex; i >= 0; i--) {
    const event = events[i]?.event
    if (event?.type !== 'session.updated' && event?.type !== 'session.created') {
      continue
    }
    const info = event.session
    if (info.id !== sessionId) {
      continue
    }
    if (!info.usage) {
      continue
    }
    const usage = emptyTurnTokenUsage()
    usage.input = info.usage.input
    usage.output = info.usage.output
    usage.reasoning = info.usage.reasoning
    usage.cacheRead = info.usage.cacheRead
    usage.cacheWrite = info.usage.cacheWrite
    usage.total = getTokenTotal(info.usage)
    usage.cost = info.cost ?? 0
    usage.model = info.model?.modelId
    usage.providerID = info.model?.providerId
    return usage.total > 0 || usage.cost > 0 ? usage : undefined
  }
  return undefined
}

// Latest billed token snapshot for the current user turn.
// Sums the last message.updated tokens per assistant message id so streaming
// updates are not double-counted. Scoped to sessionId so subagent idles
// report their own usage. Child task sessions often have no user message in
// the buffer; fall back to all assistant messages, then Session.tokens on
// session.updated (OpenCode projects per-session usage there).
export function getLatestTurnTokenUsage({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): TurnTokenUsage {
  const end = upToIndex ?? events.length - 1
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  if (latestUserMessage) {
    return sumAssistantMessages({
      messages: collectAssistantMessages({
        events,
        sessionId,
        upToIndex: end,
        parentID: latestUserMessage.id,
      }),
      userMessageId: latestUserMessage.id,
    })
  }

  const sessionAssistants = sumAssistantMessages({
    messages: collectAssistantMessages({
      events,
      sessionId,
      upToIndex: end,
    }),
  })
  if (sessionAssistants.total > 0 || sessionAssistants.assistantMessageCount > 0) {
    return sessionAssistants
  }

  return getSessionInfoTokenUsage({
    events,
    sessionId,
    upToIndex: end,
  }) ?? emptyTurnTokenUsage()
}

function findFirstUserMessageIndex({
  events,
  userMessageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  userMessageId: string
  upToIndex: number
}): number | undefined {
  for (let i = 0; i <= upToIndex; i++) {
    const event = events[i]?.event
    if (event?.type !== 'message') {
      continue
    }
    if (event.message.id === userMessageId) {
      return i
    }
  }
  return undefined
}

function findPreviousIdleIndexInTurn({
  events,
  sessionId,
  firstUserMessageIndex,
  beforeIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  firstUserMessageIndex: number
  beforeIndex: number
}): number | undefined {
  for (let i = beforeIndex - 1; i > firstUserMessageIndex; i--) {
    const event = events[i]?.event
    if (event?.type === 'idle' && event.sessionId === sessionId) {
      return i
    }
  }
  return undefined
}

function subtractTokenUsage({
  current,
  previous,
}: {
  current: TurnTokenUsage
  previous: TurnTokenUsage
}): TurnTokenUsage {
  return {
    input: current.input - previous.input,
    output: current.output - previous.output,
    reasoning: current.reasoning - previous.reasoning,
    cacheRead: current.cacheRead - previous.cacheRead,
    cacheWrite: current.cacheWrite - previous.cacheWrite,
    total: current.total - previous.total,
    cost: current.cost - previous.cost,
    model: current.model,
    providerID: current.providerID,
    assistantMessageCount: current.assistantMessageCount,
    userMessageId: current.userMessageId,
  }
}

function findFirstSessionEventIndex({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex: number
}): number {
  for (let i = 0; i <= upToIndex; i++) {
    const event = events[i]?.event
    if (!event) {
      continue
    }
    if (getEventBufferSessionId(event) === sessionId) {
      return i
    }
  }
  return 0
}

// Tokens billed since the previous session.idle in this user turn.
// Survives process restart because both idles stay in the event buffer.
// Child task sessions may have no user message.updated; scope from the first
// event for that sessionId instead so their tokens still emit.
export function getIdleTokenUsageDelta({
  events,
  sessionId,
  idleEventIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  idleEventIndex: number
}): TurnTokenUsage | undefined {
  const current = getLatestTurnTokenUsage({
    events,
    sessionId,
    upToIndex: idleEventIndex,
  })
  if (current.total <= 0) {
    return undefined
  }
  const firstUserMessageIndex = current.userMessageId
    ? findFirstUserMessageIndex({
      events,
      userMessageId: current.userMessageId,
      upToIndex: idleEventIndex,
    })
    : findFirstSessionEventIndex({
      events,
      sessionId,
      upToIndex: idleEventIndex,
    })
  if (firstUserMessageIndex === undefined) {
    return current
  }
  const previousIdleIndex = findPreviousIdleIndexInTurn({
    events,
    sessionId,
    firstUserMessageIndex,
    beforeIndex: idleEventIndex,
  })
  if (previousIdleIndex === undefined) {
    return current
  }
  const previous = getLatestTurnTokenUsage({
    events,
    sessionId,
    upToIndex: previousIdleIndex,
  })
  const delta = subtractTokenUsage({ current, previous })
  if (delta.total <= 0) {
    return undefined
  }
  return delta
}

const MIN_PROMPT_CACHE_READ_TO_TRACK = 1024
const PROMPT_CACHE_DROP_RATIO = 0.5

export type PromptCacheClear = {
  // Tokens that should have been read from cache: the smaller of the previous cached prefix and the current prompt.
  expectedCacheRead: number
  currentCacheRead: number
  previousMessageId: string
  currentMessageId: string
  minutesSincePreviousMessage: number
}

function hasPruneBetween({
  events,
  sessionId,
  fromIndex,
  toIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  fromIndex: number
  toIndex: number
}): boolean {
  for (let i = fromIndex + 1; i <= toIndex; i++) {
    const event = events[i]?.event
    if (event?.type !== 'part') {
      continue
    }
    const part = event.part
    if (part.sessionId !== sessionId || part.kind !== 'tool') {
      continue
    }
    if (part.status !== 'completed') {
      continue
    }
    if (typeof part.compactedAt === 'number') {
      return true
    }
  }
  return false
}

function getCompletedAssistantAt({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex: number
}): AssistantMessage | undefined {
  for (let i = upToIndex; i >= 0; i--) {
    const event = events[i]?.event
    if (event?.type !== 'message') {
      continue
    }
    const info = event.message
    if (info.sessionId !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
      continue
    }
    if (typeof info.completedAt !== 'number') {
      return undefined
    }
    return info as AssistantMessage
  }
  return undefined
}

function isComparableCacheAssistant(message: AssistantMessage): boolean {
  if (!isUserFacingAssistantMessage(message)) {
    return false
  }
  if (message.error) {
    return false
  }
  if (!message.usage || !message.model?.modelId || !message.model.providerId) {
    return false
  }
  return true
}

// Same-model cache drop vs the previous completed assistant. Aborted/errored replies are skipped,
// compaction summaries and pruned tool output block the pair since they rewrite the prompt.
export function getPromptCacheClear({
  events,
  sessionId,
  currentMessageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  currentMessageId: string
  upToIndex?: number
}): PromptCacheClear | undefined {
  const end = upToIndex ?? events.length - 1
  const current = getCompletedAssistantAt({
    events,
    sessionId,
    messageId: currentMessageId,
    upToIndex: end,
  })
  if (!current || !isComparableCacheAssistant(current) || !current.usage) {
    return undefined
  }
  const currentUsage = current.usage

  const seen = new Set<string>([currentMessageId])
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (event?.type !== 'message') {
      continue
    }
    const info = event.message
    if (info.sessionId !== sessionId || info.role !== 'assistant') {
      continue
    }
    if (seen.has(info.id) || info.parentId === current.parentId) {
      continue
    }
    if (typeof info.completedAt !== 'number') {
      continue
    }
    seen.add(info.id)
    if (!isUserFacingAssistantMessage(info as AssistantMessage)) {
      return undefined
    }
    if (!isComparableCacheAssistant(info as AssistantMessage) || !info.usage) {
      continue
    }
    if (info.model?.modelId !== current.model?.modelId || info.model?.providerId !== current.model?.providerId) {
      return undefined
    }
    if (hasPruneBetween({
      events,
      sessionId,
      fromIndex: i,
      toIndex: end,
    })) {
      return undefined
    }
    // Anthropic reports a fresh cache as write only, so read alone misses the turn after a miss.
    const previousCached = info.usage.cacheRead + info.usage.cacheWrite
    const currentPrompt = currentUsage.input + currentUsage.cacheRead + currentUsage.cacheWrite
    // A reverted (shorter) prompt can only reuse its own length from cache.
    const expectedCacheRead = Math.min(previousCached, currentPrompt)
    if (expectedCacheRead < MIN_PROMPT_CACHE_READ_TO_TRACK) {
      return undefined
    }
    if (currentUsage.cacheRead > expectedCacheRead * PROMPT_CACHE_DROP_RATIO) {
      return undefined
    }
    return {
      expectedCacheRead,
      currentCacheRead: currentUsage.cacheRead,
      previousMessageId: info.id,
      currentMessageId: current.id,
      minutesSincePreviousMessage: Math.max(0, Math.round(
        (current.createdAt - info.completedAt) / 60_000,
      )),
    }
  }
  return undefined
}

export function formatCompactTokenCount(count: number): string {
  if (count >= 1000) {
    const thousands = count / 1000
    const rounded = thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)
    return `${rounded.replace(/\.0$/, '')}k`
  }
  return String(count)
}

export function formatPromptCacheClearMessage(
  clear: PromptCacheClear,
  systemDiff?: { additions: number; deletions: number },
): string {
  const tokens = `prompt cache missed (${formatCompactTokenCount(clear.expectedCacheRead)} → ${formatCompactTokenCount(clear.currentCacheRead)}) (${clear.minutesSincePreviousMessage} mins passed)`
  if (!systemDiff || (systemDiff.additions === 0 && systemDiff.deletions === 0)) {
    return tokens
  }
  return `${tokens}, system +${systemDiff.additions} -${systemDiff.deletions}`
}

// Scans backward for most recent message.updated with role=assistant for sessionId.
// Extracts model, providerID, agent, tokensUsed.
export function getLatestRunInfo({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): {
  model: string | undefined
  providerID: string | undefined
  agent: string | undefined
  tokensUsed: number
} {
  const result = {
    model: undefined as string | undefined,
    providerID: undefined as string | undefined,
    agent: undefined as string | undefined,
    tokensUsed: 0,
  }
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    if (e.type !== 'message') {
      continue
    }
    const msg = e.message
    if (msg.sessionId !== sessionId || msg.role !== 'assistant') {
      continue
    }
    if (!isUserFacingAssistantMessage(msg as AssistantMessage)) {
      continue
    }
    return {
      model: msg.model?.modelId,
      providerID: msg.model?.providerId,
      agent: msg.agent,
      tokensUsed: msg.usage
        ? getTokenTotal(msg.usage)
        : 0,
    }
  }
  return result
}

export function getAssistantMessageIdsForLatestUserTurn({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): Set<string> {
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  if (!latestUserMessage) {
    return new Set<string>()
  }
  const end = upToIndex === undefined ? events.length : upToIndex + 1
  const firstUserMessageIndexes = new Map<string, number>()
  for (let i = 0; i < end; i++) {
    const event = events[i]?.event
    if (event?.type !== 'message') {
      continue
    }
    const message = event.message
    if (
      message.sessionId === sessionId
      && message.role === 'user'
      && !firstUserMessageIndexes.has(message.id)
    ) {
      firstUserMessageIndexes.set(message.id, i)
    }
  }

  const latestUserMessageIndex = firstUserMessageIndexes.get(latestUserMessage.id)
  const turnParentMessageIds = new Set([latestUserMessage.id])
  if (latestUserMessageIndex !== undefined) {
    for (const [messageId, messageIndex] of firstUserMessageIndexes) {
      if (messageIndex < latestUserMessageIndex) {
        continue
      }
      if (isInternalOpenCodeUserMessageId({
        events,
        sessionId,
        messageId,
        upToIndex,
      })) {
        turnParentMessageIds.add(messageId)
      }
    }
  }

  const assistantMessageIds = new Set<string>()
  for (let i = 0; i < end; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    if (e.type !== 'message') {
      continue
    }
    const msg = e.message
    if (msg.sessionId !== sessionId || msg.role !== 'assistant') {
      continue
    }
    if (!isUserFacingAssistantMessage(msg as AssistantMessage)) {
      continue
    }
    if (msg.parentId && turnParentMessageIds.has(msg.parentId)) {
      assistantMessageIds.add(msg.id)
    }
  }
  return assistantMessageIds
}

export function didLatestUserTurnUseSleepTool({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const assistantMessageIds = getAssistantMessageIdsForLatestUserTurn({
    events,
    sessionId,
    upToIndex,
  })
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (event?.type !== 'part') continue
    const part = event.part
    if (part.sessionId !== sessionId || part.kind !== 'tool') continue
    if (part.tool === 'roadie_sleep' && assistantMessageIds.has(part.messageId)) {
      return true
    }
  }
  return false
}

export function getLatestAssistantMessageIdForLatestUserTurn({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): string | undefined {
  const assistantMessageIds = getAssistantMessageIdsForLatestUserTurn({
    events,
    sessionId,
    upToIndex,
  })
  if (assistantMessageIds.size === 0) {
    return undefined
  }
  const end = upToIndex ?? events.length - 1
  let latestAssistantMessage: AgentMessage | undefined
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message') {
      continue
    }
    const info = event.message
    if (info.sessionId !== sessionId || info.role !== 'assistant') {
      continue
    }
    if (!isUserFacingAssistantMessage(info as AssistantMessage)) {
      continue
    }
    if (!assistantMessageIds.has(info.id)) {
      continue
    }
    if (!latestAssistantMessage) {
      latestAssistantMessage = info
      continue
    }
    if (info.createdAt > latestAssistantMessage.createdAt) {
      latestAssistantMessage = info
    }
  }
  return latestAssistantMessage?.id
}

function hasRenderablePartSummary(message: AgentMessage): boolean {
  if (!Array.isArray(message.partsSummary)) {
    return false
  }
  return message.partsSummary.some((part) => {
    return part.type === 'text' || part.type === 'tool'
  })
}

function hasAssistantPartEvidence({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type === 'message') {
      const info = event.message
      if (info.sessionId !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
        continue
      }
      if (hasRenderablePartSummary(info)) {
        return true
      }
      continue
    }
    if (event.type !== 'part') {
      continue
    }
    const { part } = event
    if (part.messageId !== messageId) {
      continue
    }
    if (part.kind === 'text' || part.kind === 'tool') {
      return true
    }
  }
  return false
}

function hasAssistantStepFinished({
  events,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry || entry.event.type !== 'part') {
      continue
    }
    const { part } = entry.event
    if (part.messageId !== messageId) {
      continue
    }
    if (part.kind === 'step-finish') {
      return true
    }
  }
  return false
}

export function doesLatestUserTurnHaveNaturalCompletion({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
    upToIndex,
  })
  if (!latestAssistantMessageId) {
    return false
  }

  const end = upToIndex ?? events.length - 1
  let latestAssistantMessage: AssistantMessage | undefined
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message') {
      continue
    }
    const info = event.message
    if (info.sessionId !== sessionId || info.role !== 'assistant') {
      continue
    }
    if (info.id !== latestAssistantMessageId) {
      continue
    }
    latestAssistantMessage = info as AssistantMessage
    if (isAssistantMessageNaturalCompletion({ message: latestAssistantMessage })) {
      return true
    }
    break
  }

  if (!latestAssistantMessage) {
    return false
  }
  if (latestAssistantMessage.error) {
    return false
  }
  if (latestAssistantMessage.finish === 'tool-calls') {
    return false
  }
  return hasAssistantStepFinished({
    events,
    messageId: latestAssistantMessageId,
    upToIndex,
  }) && hasAssistantPartEvidence({
    events,
    sessionId,
    messageId: latestAssistantMessageId,
    upToIndex,
  })
}

export function isAssistantMessageInLatestUserTurn({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const assistantMessageIds = getAssistantMessageIdsForLatestUserTurn({
    events,
    sessionId,
    upToIndex,
  })
  return assistantMessageIds.has(messageId)
}

export function isSummaryAssistantMessage({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  return getAssistantMessageKind({
    events,
    sessionId,
    messageId,
    upToIndex,
  }) === 'summary'
}

// Returns a stable 1-based subtask index for candidateSessionId.
// Indexing scope is the parent assistant message that spawned the task tool calls,
// so numbering restarts at 1 for each assistant message.
export function getDerivedSubtaskIndex({
  events,
  mainSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): number | undefined {
  const end = upToIndex ?? events.length - 1
  let parentAssistantMessageId: string | undefined

  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      mainSessionId,
    })
    if (!candidate) {
      continue
    }
    if (candidate.childSessionId !== candidateSessionId) {
      continue
    }
    parentAssistantMessageId = candidate.assistantMessageId
    break
  }

  if (!parentAssistantMessageId) {
    return undefined
  }

  const indexByChildSessionId = new Map<string, number>()
  for (let i = 0; i <= end; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      mainSessionId,
    })
    if (!candidate || candidate.assistantMessageId !== parentAssistantMessageId) {
      continue
    }
    if (!indexByChildSessionId.has(candidate.childSessionId)) {
      indexByChildSessionId.set(
        candidate.childSessionId,
        indexByChildSessionId.size + 1,
      )
    }
  }

  return indexByChildSessionId.get(candidateSessionId)
}

// Returns the subagent_type (e.g. "explore", "general") for a given child session.
// Used to build labels like "explore-1" instead of generic "task-1".
export function getDerivedSubtaskAgentType({
  events,
  mainSessionId,
  candidateSessionId,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
}): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      mainSessionId,
    })
    if (!candidate || candidate.childSessionId !== candidateSessionId || !candidate.subagentType) {
      continue
    }
    return candidate.subagentType
  }
  return undefined
}

export function getDerivedSubtaskLabel({
  events,
  mainSessionId,
  candidateSessionId,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
}): string | undefined {
  const index = getDerivedSubtaskIndex({ events, mainSessionId, candidateSessionId })
  if (!index) return undefined
  const agent = getDerivedSubtaskAgentType({ events, mainSessionId, candidateSessionId })
  return `${agent || 'task'}-${index}`
}

export function getDerivedSubagentSessions({
  events,
  mainSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  upToIndex?: number
}): DerivedSubagentSession[] {
  const end = upToIndex ?? events.length - 1
  const seenChildSessionIds = new Set<string>()
  const sessions: DerivedSubagentSession[] = []

  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      mainSessionId,
    })
    if (!candidate || seenChildSessionIds.has(candidate.childSessionId)) {
      continue
    }

    seenChildSessionIds.add(candidate.childSessionId)
    sessions.push({
      childSessionId: candidate.childSessionId,
      subagentType: candidate.subagentType,
      description: candidate.description,
      timestamp: entry.timestamp,
    })
  }

  return sessions
}

function getParentIdFromSessionEvent(event: EventBufferEvent): {
  sessionId: string
  parentID: string
} | undefined {
  if (event.type !== 'session.created' && event.type !== 'session.updated') {
    return undefined
  }
  const parentID = event.session.parentId
  if (typeof parentID !== 'string' || parentID.length === 0) {
    return undefined
  }
  return {
    sessionId: event.session.id,
    parentID,
  }
}

// Global SSE is broadcast to every thread. Buffer only this thread's session
// plus its task/subagent children. /fork clones history onto a new
// sessionId; those events must not evict the parent's latest-turn buffer.
export function shouldBufferSessionEvent({
  event,
  mainSessionId,
  isKnownChildSession,
}: {
  event: EventBufferEvent
  mainSessionId?: string
  isKnownChildSession: (sessionId: string) => boolean
}): boolean {
  if (event.type === 'session.diff' || event.type === 'part.delta') {
    return false
  }
  if (event.type === 'notice') {
    return true
  }

  const eventSessionId = getEventBufferSessionId(event)
  if (!eventSessionId) {
    return true
  }
  // A new fork thread registers the SSE listener before ensureSession.
  // Until the child session id is bound, drop every scoped event so the
  // parent clone flood cannot fill this buffer first.
  if (!mainSessionId) {
    return false
  }
  if (eventSessionId === mainSessionId) {
    return true
  }
  if (isKnownChildSession(eventSessionId)) {
    return true
  }

  const parented = getParentIdFromSessionEvent(event)
  if (!parented) {
    return false
  }
  return parented.parentID === mainSessionId || isKnownChildSession(parented.parentID)
}

// Child task sessions emit thousands of message.part.updated events. Those are
// still handled live for Discord display, but they must not occupy the bounded
// buffer or they evict parent session.status busy and `. queue` drains early.
// That is what aborted ses_f3c07efdbffeHwbaQhsE7fIz5z: live buffer mixed in
// child parts, persist dropped them, export still looked busy, drain fired.
// Keep child session/message lifecycle so token tracking and subtask identity
// still derive after the part flood.
export function shouldRetainSessionEvent({
  event,
  mainSessionId,
  isKnownChildSession,
}: {
  event: EventBufferEvent
  mainSessionId?: string
  isKnownChildSession: (sessionId: string) => boolean
}): boolean {
  if (!shouldBufferSessionEvent({ event, mainSessionId, isKnownChildSession })) {
    return false
  }
  const eventSessionId = getEventBufferSessionId(event)
  if (!eventSessionId || eventSessionId === mainSessionId) {
    return true
  }
  return event.type !== 'part'
}

export function trimEventBuffer({
  events,
  mainSessionId,
  max,
  isKnownChildSession,
}: {
  events: EventBufferEntry[]
  mainSessionId?: string
  max: number
  isKnownChildSession: (sessionId: string) => boolean
}): EventBufferEntry[] {
  const retained = events.filter((entry) => {
    return shouldRetainSessionEvent({
      event: entry.event,
      mainSessionId,
      isKnownChildSession,
    })
  })
  if (retained.length <= max) {
    return retained
  }
  return retained.slice(-max)
}

// Child sessions of the main thread: task tool metadata.sessionId, plus
// session.created/updated parentID (available before task metadata lands).
export function getDerivedChildSessionIds({
  events,
  mainSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  upToIndex?: number
}): Set<string> {
  const end = upToIndex ?? events.length - 1
  const ids = new Set<string>()
  for (const session of getDerivedSubagentSessions({
    events,
    mainSessionId,
    upToIndex,
  })) {
    ids.add(session.childSessionId)
  }

  let grew = true
  while (grew) {
    grew = false
    for (let i = 0; i <= end; i++) {
      const event = events[i]?.event
      if (!event) {
        continue
      }
      const parented = getParentIdFromSessionEvent(event)
      if (!parented || ids.has(parented.sessionId)) {
        continue
      }
      if (parented.parentID !== mainSessionId && !ids.has(parented.parentID)) {
        continue
      }
      ids.add(parented.sessionId)
      grew = true
    }
  }
  return ids
}

export function isDerivedChildSession({
  events,
  mainSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): boolean {
  if (candidateSessionId === mainSessionId) {
    return false
  }
  return getDerivedChildSessionIds({
    events,
    mainSessionId,
    upToIndex,
  }).has(candidateSessionId)
}

export function getTokenUsageSessionIdsForIdle({
  events,
  mainSessionId,
  idleSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  idleSessionId: string
  upToIndex?: number
}): string[] {
  if (idleSessionId !== mainSessionId) {
    return [idleSessionId]
  }
  return [
    mainSessionId,
    ...getDerivedChildSessionIds({
      events,
      mainSessionId,
      upToIndex,
    }),
  ]
}
