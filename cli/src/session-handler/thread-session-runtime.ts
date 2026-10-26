// ThreadSessionRuntime — one per active thread.
// Owns resource handles (listener controller, typing timers, part buffer).
// Delegates all state to the global store via thread-runtime-state.ts transitions.
//
// This is the sole session orchestrator. Discord handlers and slash commands
// call runtime APIs (enqueueIncoming, abortActiveRun, etc.) without inspecting
// run internals.

import { resolveSessionPermissionRules } from '../permission-policy.js'
import { markPendingSessionTitle, sessionTitlePrompt, schedulePendingSessionTitle } from '../session-title.js'
import { doAction } from '../hooks.js'
import { parsePersistedEvents } from './persisted-events.js'
import {
  RESTART_CONTINUATION_FAILED_NOTICE,
  RESTART_CONTINUATION_MAX_ATTEMPTS,
} from '../service-lifecycle.js'
import type { ThreadChannel } from 'discord.js'
import type { ChatThread } from '../chat-platform/types.js'
import { createDiscordChatThread } from '../chat-platform/discord.js'
import {
  agentEventSessionId,
  type AgentChildSessionEvent,
  type AgentError,
  type AgentEvent,
  type AgentMessage,
  type AgentPart,
  type AgentStatus,
} from '../agent-backend/events.js'
import { AgentRequestError, type AgentPromptPart } from '../agent-backend/types.js'
import path from 'node:path'
import prettyMilliseconds from 'pretty-ms'
import * as threadState from './thread-runtime-state.js'
import type { QueuedMessage } from './thread-runtime-state.js'
import type { AgentBackend, AgentBackendEvent, AgentBackendGetter } from '../agent-backend/types.js'
import type { AgentFormRequest } from '../agent-backend/events.js'
import { agentBackendLabel, getAgentBackendProvider, isRetiredSession } from '../agent-backend/registry.js'
import { seedFromRetiredSession } from './retired-session-seed.js'
import { registerSpeakerMcpServers } from '../person-mcp.js'
import { applicationDirectory } from '../channel-policy.js'
import { writeInjectionGuardConfig } from '../injection-guard-config.js'
import { isAbortError } from '../utils.js'
import {
  registerEventListener,
  unregisterEventListener,
  waitForGlobalEventListener,
} from './global-event-listener.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  raceDiscordRename,
  DISCORD_THREAD_RENAME_TIMEOUT_MS,
  resolveThreadFooterMentionUserId,
} from '../discord-utils.js'
import type { SessionPartKind } from '../message-formatting.js'
import {
  asDiscordQuote,
  asSubtext,
  formatPart,
  formatTaskToolTitle,
  planAssistantTurnFlush,
  sessionPartContent,
  sessionPartKind,
  shouldLeadWithBlankLine,
  shouldQuoteIntermediateTextPart,
  toolKeepsLeadInTextPlain,
  leadInTextPartBefore,
  STATUS_PREFIX,
  type AssistantTurnFlushMode,
} from '../message-formatting.js'
import {
  setSessionTurnAttribution,
  getSessionTurnAttribution,
  recordCredentialOwner,
  recordCredentialPayerNotice,
  getChannelVerbosity,
  getPartMessageIds,
  getDb,
  setPartMessage,
  getThreadSession,
  setThreadSession,
  getThreadLastSyncedName,
  getThreadParentSessionId,
  setThreadParentSessionId,
  getSessionForkOrigin,
  getThreadWorkingDirectory,
  setSessionAgent,
  setSessionModel,
  clearSessionModel,
  getVariantCascade,
  setSessionStartSource,
  completeScheduledTaskRunsForSession,
  failScheduledTaskRunsForSession,
  startScheduledTaskRunSession,
  appendSessionEventsSinceLastTimestamp,
  getSessionEventSnapshot,
  cancelSessionSleepForThread,
} from '../database.js'
import * as orm from 'drizzle-orm'
import * as schema from '../schema.js'
import { resolvePersonBillingPool } from '../credentials/person-pool.js'
import {
  showPermissionButtons,
  addPermissionRequestToContext,
} from '../commands/permissions.js'
import {
  showAskUserQuestionDropdowns,
  pendingQuestionContexts,
} from '../commands/ask-question.js'
import {
  cancelPendingMcpFormsForRequest,
} from '../commands/mcp-form.js'
import {
  showActionButtons,
  waitForQueuedActionButtonsRequest,
  pendingActionButtonContexts,
} from '../commands/action-buttons.js'
import {
  pendingFileUploadContexts,
} from '../commands/file-upload.js'
import {
  getCurrentModelInfo,
  ensureSessionPreferencesSnapshot,
} from '../commands/model.js'
import {
  displayedModelLabel,
  resolveDisplayedModelName,
  validateModelId,
} from './model-utils.js'
import {
  getPromptContext,
  systemPromptNamesOtherSession,
  systemPromptHasParentSession,
  type AgentInfo,
  type WorkingDirectoryInfo,
  type ScheduledTaskSystemContext,
} from '../system-message.js'
import { countSystemPromptDiffLines } from '../cache-rewrite.js'
import { store } from '../store.js'
import { resolveValidatedAgentPreference } from './agent-utils.js'
import {
  appendSessionEventLog,
  isSessionEventLogEnabled,
} from './session-event-log.js'
import {
  doesLatestUserTurnHaveNaturalCompletion,
  getContinuationTurnOutcome,
  didLatestUserTurnUseSleepTool,
  getAssistantMessageIdsForLatestUserTurn,
  getCurrentTurnStartTime,
  isSessionBusy,
  resolveActionParentSessionId,
  getLatestRunInfo,
  getPromptCacheClear,
  formatPromptCacheClearMessage,
  getIdleTokenUsageDelta,
  getDerivedSubtaskLabel,
  getTokenUsageSessionIdsForIdle,
  isDerivedChildSession,
  getLatestAssistantMessageIdForLatestUserTurn,
  getAssistantMessageKind,
  hasAssistantMessageCompletedBefore,
  isAssistantMessageInLatestUserTurn,
  isAssistantMessageNaturalCompletion,
  getEventBufferSessionId,
  shouldBufferSessionEvent,
  shouldRetainSessionEvent,
  trimEventBuffer,
  type EventBufferEvent,
  type EventBufferEntry,
} from './event-stream-state.js'

import {
  getThinkingValuesForModel,
  matchThinkingValue,
} from '../thinking-utils.js'
import { execAsync } from '../git-utils.js'
import {
  DiscordOperationError,
  AgentBackendError,
  FilesystemOperationError,
} from '../errors.js'

import { notifyError } from '../sentry.js'
import { createDebouncedProcessFlush } from '../debounced-process-flush.js'
import { TypingKeepalive } from './typing-keepalive.js'
import { InteractiveUi } from './interactive-ui.js'
import { MessageQueue } from './message-queue.js'
import { resolveTurnContext, resolveTurnSystemPrompt } from './turn-context.js'
import { releaseCurrentThreadIngress, waitForCurrentThreadIngress } from './thread-ingress.js'
import type { RuntimeOptions } from './runtime-registry.js'
import {
  applyChannelPolicyToIngress,
  applyPersonToIngress,
  maybeConvertLeadingCommand,
  type EnqueueResult,
  type IngressInput,
} from './ingress-input.js'
import { cleanupPendingUiForThread, pendingPermissions } from './pending-ui.js'
import { isEssentialToolPart } from './essential-tools.js'
import { resolveAutoThreadRename } from './thread-name.js'
import {
  delay,
  extractToastSessionId,
  formatSessionErrorFromProps,
  getFallbackContextLimit,
  getTimestampFromSnowflake,
  getTokenTotal,
  getWorkingDirectoryPromptKey,
  stripToastSessionId,
  toPromptFilePart,
  truncateSessionErrorMessage,
} from './runtime-helpers.js'

const logger = createLogger(LogPrefix.SESSION)
const discordLogger = createLogger(LogPrefix.DISCORD)

const shouldLogSessionEvents =
  process.env['ROADIE_LOG_SESSION_EVENTS'] === '1' ||
  process.env['ROADIE_VITEST'] === '1'

type AbortRunOutcome = {
  abortId: string
  reason: string
  apiAbortPromise: Promise<void> | undefined
}

// ── Runtime class ────────────────────────────────────────────────

export class ThreadSessionRuntime {
  readonly threadId: string
  readonly projectDirectory: string
  readonly sdkDirectory: string
  readonly channelId: string | undefined
  readonly appId: string | undefined
  readonly thread: ThreadChannel | ChatThread
  /** Platform-neutral view of `thread`; prefer it for conversation operations. */
  readonly chat: ChatThread

  // ── Resource handles (mechanisms, not domain state) ──

  // Set to true by dispose(). Guards against queued work running after cleanup.
  private disposed = false

  // Typing indicator scheduler (keepalive loop + repulse debounce).
  private readonly typing: TypingKeepalive
  // Permission and question prompts (question deferral + shown-request dedupe).
  private readonly interactiveUi: InteractiveUi
  // Local per-thread message queue (persistence, drain, question handoff).
  private readonly messageQueue: MessageQueue

  // Notification throttles for retry/context notices.
  private lastDisplayedContextPercentage = 0
  private lastRateLimitDisplayTime = 0
  private userSystemByMessageId = new Map<string, string>()

  // Last agent session title we applied to Discord. Dedupes session.updated
  // so we only call setName once per distinct title. The applied name itself is
  // persisted in thread_sessions.last_synced_name (Discord only) so the dedupe
  // and manual-rename detection survive restarts; this field does not.
  private appliedSessionTitle: string | undefined

  // Part output buffering (write-side cache, not domain state)
  private partBuffer = new Map<string, Map<string, AgentPart>>()

  // Derivable cache (perf optimization for provider.list API call)
  private modelContextLimit: number | undefined
  private modelContextLimitKey: string | undefined
  private lastPromptWorkingDirectoryKey: string | null | undefined
  private lastSentPartKind: SessionPartKind | undefined

  // Bounded buffer of recent SSE events with timestamps.
  // Used by waitForEvent() to scan for specific events that arrived
  // after a given point in time (e.g. wait for session.idle after abort).
  // Generic: any future "wait for X event" can reuse this buffer.
  private static EVENT_BUFFER_MAX = 1000
  private static EVENT_BUFFER_DB_FLUSH_MS = 2_000
  private static EVENT_BUFFER_TEXT_MAX_CHARS = 512
  private eventBuffer: EventBufferEntry[] = []
  private nextEventIndex = 0
  private persistEventBufferDebounced: ReturnType<
    typeof createDebouncedProcessFlush
  >
  private readonly sentPartIdsBootstrap: Promise<void>

  // Serialized action queue for per-thread runtime transitions.
  // Ingress and event handling both flow through this queue to keep ordering
  // deterministic and avoid interleaving shared mutable structures.
  private actionQueue: Array<() => Promise<void>> = []
  private processingAction = false

  // Lightweight promise chain for serializing preprocess callbacks.
  // Runs OUTSIDE dispatchAction so heavy work (context
  // fetch, attachment download) doesn't block SSE event handling, permission
  // UI, or queue drain. Only preprocess ordering is serialized here; the
  // resolved input is then routed through the normal enqueue paths which
  // use dispatchAction internally.
  private preprocessChain: Promise<void> = Promise.resolve()
  // Chat messages sent while the session was busy, oldest first. Each carries
  // a pending marker until the agent picks it up at a step boundary.
  private pendingDeliveryMessageIds: string[] = []
  private seenUserMessageIds = new Set<string>()
  // A restart continuation prompt still waiting for a reply. Watched on idle
  // so a turn the backend aborts before producing anything is re-sent once
  // instead of leaving the thread silent.
  private restartContinuation:
    | { input: IngressInput; attempt: number; priorUserMessageIds: Set<string> }
    | undefined
  // Set while a Roadie-initiated abort is settling, so an abort Roadie did not
  // request can be logged as coming from the agent backend.
  private roadieAbortPending = false

  constructor(opts: RuntimeOptions) {
    this.threadId = opts.threadId
    this.projectDirectory = applicationDirectory() ?? opts.projectDirectory
    this.sdkDirectory = applicationDirectory() ?? opts.sdkDirectory
    this.channelId = opts.channelId
    this.appId = opts.appId
    this.thread = opts.thread ?? opts.chat
    this.chat = opts.chat ?? createDiscordChatThread(opts.thread)
    this.sentPartIdsBootstrap = this.bootstrapSentPartIds().catch((error) => {
      logger.warn(
        `[PART BOOTSTRAP] Failed to load sent part ids for thread ${this.threadId}:`,
        error,
      )
    })
    // Register with the single global SSE listener. Events for this
    // directory are demuxed and dispatched through our action queue.
    registerEventListener(this.threadId, (event) => {
      if (this.disposed) return
      void this.dispatchAction(async () => {
        await this.sentPartIdsBootstrap
        await this.handleEvent(event)
      })
    })
    this.persistEventBufferDebounced = createDebouncedProcessFlush({
      waitMs: ThreadSessionRuntime.EVENT_BUFFER_DB_FLUSH_MS,
      callback: async () => {
        await this.persistSessionEventsToDatabase()
      },
      onError: (error) => {
        logger.error(
          `[SESSION EVENT DB] Debounced persistence failed for thread ${this.threadId}:`,
          error,
        )
      },
    })
    this.typing = new TypingKeepalive({
      supportsTyping: () => this.chat.capabilities.typing,
      isDisposed: () => this.disposed,
      hasPendingInteractiveUi: () => this.hasPendingInteractiveUi(),
      getSessionId: () => this.state?.sessionId,
      isSessionBusy: (sessionId) => isSessionBusy({ events: this.eventBuffer, sessionId }),
      sendTyping: () => this.chat.sendTyping(),
    })
    this.messageQueue = new MessageQueue({
      threadId: this.threadId,
      chat: this.chat,
      isBusy: () => this.isBusy(),
      getEventBuffer: () => this.eventBuffer,
      dispatchAction: (action) => this.dispatchAction(action),
      markQueueDispatchBusy: (sessionId) => this.markQueueDispatchBusy(sessionId),
      markQueueDispatchIdle: (sessionId) => this.markQueueDispatchIdle(sessionId),
      dispatchPrompt: (input) => this.dispatchPrompt(input),
    })
    this.interactiveUi = new InteractiveUi({
      threadId: this.thread.id,
      sdkDirectory: this.sdkDirectory,
      chat: this.chat,
      isDisposed: () => this.disposed,
      getSessionId: () => this.state?.sessionId,
      getEventBuffer: () => this.eventBuffer,
      getBufferedParts: (messageID) => this.getBufferedParts(messageID),
      getSubtaskInfoForSession: (sessionId) => this.getSubtaskInfoForSession(sessionId),
      getQueueLength: () => this.getQueueLength(),
      stopTyping: () => this.typing.stopTyping(),
      flushCurrentTurnParts: (opts) => this.flushCurrentTurnParts(opts),
      dispatchAction: (action) => this.dispatchAction(action),
    })
  }

  private consumeWorkingDirectoryPromptChange(
    dir: WorkingDirectoryInfo | undefined,
  ): boolean {
    const nextKey = getWorkingDirectoryPromptKey(dir)
    const changed = this.lastPromptWorkingDirectoryKey !== nextKey
    this.lastPromptWorkingDirectoryKey = nextKey
    return changed
  }

  // Read own state from global store
  get state(): threadState.ThreadRunState | undefined {
    return threadState.getThreadState(this.threadId)
  }

  getDerivedPhase(): 'idle' | 'running' {
    return this.isBusy() ? 'running' : 'idle'
  }

  private getLastRuntimeActivityTimestamp({
    nowMs: _nowMs,
  }: {
    nowMs: number
  }): number {
    const lastEvent = this.eventBuffer[this.eventBuffer.length - 1]
    const lastEventTimestamp = lastEvent?.timestamp
    if (typeof lastEventTimestamp === 'number' && Number.isFinite(lastEventTimestamp)) {
      return lastEventTimestamp
    }
    const threadCreatedTimestamp = this.chat.createdAt
    if (
      typeof threadCreatedTimestamp === 'number'
      && Number.isFinite(threadCreatedTimestamp)
      && threadCreatedTimestamp > 0
    ) {
      return threadCreatedTimestamp
    }
    const snowflakeTimestamp = getTimestampFromSnowflake(this.thread.id)
    if (snowflakeTimestamp) {
      return snowflakeTimestamp
    }
    return 0
  }

  private isIdleCandidateForInactivityCheck(): boolean {
    if (this.isBusy()) {
      return false
    }
    if ((this.state?.queueItems.length ?? 0) > 0) {
      return false
    }
    if (this.hasPendingInteractiveUi()) {
      return false
    }
    if (this.processingAction || this.actionQueue.length > 0) {
      return false
    }
    return true
  }

  getInactivitySnapshot({
    nowMs,
  }: {
    nowMs: number
  }): {
    idleCandidate: boolean
    inactiveForMs: number
  } {
    const lastActivityTimestamp = this.getLastRuntimeActivityTimestamp({ nowMs })
    return {
      idleCandidate: this.isIdleCandidateForInactivityCheck(),
      inactiveForMs: Math.max(0, nowMs - lastActivityTimestamp),
    }
  }

  isIdleForInactivityTimeout({
    idleMs,
    nowMs,
  }: {
    idleMs: number
    nowMs: number
  }): boolean {
    const snapshot = this.getInactivitySnapshot({ nowMs })
    if (!snapshot.idleCandidate) {
      return false
    }
    return snapshot.inactiveForMs >= idleMs
  }

  private async hydrateSessionEventsFromDatabase({
    sessionId,
  }: {
    sessionId: string
  }): Promise<void> {
    if (this.eventBuffer.length > 0) {
      return
    }

    const rows = await getSessionEventSnapshot({ sessionId })
    if (rows.length === 0) {
      return
    }

    const hydratedEvents: EventBufferEntry[] = rows.flatMap((row) => {
      const eventResult = parsePersistedEvents(row.event_json)
      if (eventResult instanceof Error) {
        logger.warn(
          `[SESSION EVENT DB] Skipping invalid persisted event row for session ${sessionId}: ${eventResult.message}`,
        )
        return []
      }
      return eventResult.map((event) => ({
          event,
          timestamp: Number(row.timestamp),
          eventIndex: Number(row.event_index),
        }))
    })

    this.eventBuffer = trimEventBuffer({
      events: hydratedEvents,
      mainSessionId: sessionId,
      max: ThreadSessionRuntime.EVENT_BUFFER_MAX,
      isKnownChildSession: (candidateSessionId) => {
        return isDerivedChildSession({
          events: hydratedEvents,
          mainSessionId: sessionId,
          candidateSessionId,
        })
      },
    })
    const lastHydratedEvent = this.eventBuffer[this.eventBuffer.length - 1]
    this.nextEventIndex = lastHydratedEvent
      ? Number(lastHydratedEvent.eventIndex || 0) + 1
      : 0
    logger.log(
      `[SESSION EVENT DB] Hydrated ${this.eventBuffer.length} events for session ${sessionId}`,
    )
  }

  private async persistSessionEventsToDatabase(): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return
    }

    const events = this.eventBuffer.flatMap((entry) => {
      const eventSessionId = getEventBufferSessionId(entry.event)
      if (eventSessionId !== sessionId) {
        return []
      }
      return [
        {
          session_id: sessionId,
          thread_id: this.threadId,
          timestamp: entry.timestamp,
          event_index: entry.eventIndex || 0,
          event_json: JSON.stringify(entry.event),
        },
      ]
    })

    await appendSessionEventsSinceLastTimestamp({
      sessionId,
      events,
    })
  }

  private nextAbortId(reason: string): string {
    return `${reason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  private formatRunStateForLog(): string {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return 'none'
    }
    const latestAssistant = this.getLatestAssistantMessageIdForCurrentTurn({
      sessionId,
    }) || 'none'
    const assistantCount = this.getAssistantMessageIdsForCurrentTurn({
      sessionId,
    }).size
    const phase = this.getDerivedPhase()
    return `phase=${phase},assistant=${latestAssistant},assistantCount=${assistantCount}`
  }

  /** Whether the main session currently has an active run (derived from events). */
  isBusy(): boolean {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return false
    }
    return isSessionBusy({ events: this.eventBuffer, sessionId })
  }

  private async persistIngressVariant({
    sessionId,
    channelId,
    appId,
    agentPreference,
    getClient,
    variant,
  }: {
    sessionId: string
    channelId?: string
    appId?: string
    agentPreference?: string
    getClient: Error | AgentBackendGetter
    variant?: string
  }) {
    if (!variant) return
    if (getClient instanceof Error) return
    const variantModelInfo = await getCurrentModelInfo({
      sessionId,
      channelId,
      appId,
      agentPreference,
      getClient,
      directory: this.sdkDirectory,
    })
    if (variantModelInfo.type === 'none') return
    const catalog = await getClient().catalog.providers({ directory: this.sdkDirectory })
    if (catalog instanceof Error) return
    const matchedVariant = matchThinkingValue({
      requestedValue: variant,
      availableValues: getThinkingValuesForModel({
        providers: catalog.providers,
        providerId: variantModelInfo.providerID,
        modelId: variantModelInfo.modelID,
      }),
    })
    if (!matchedVariant) return
    await setSessionModel({
      sessionId,
      modelId: variantModelInfo.model,
      variant: matchedVariant,
    })
  }

  private getAssistantMessageIdsForCurrentTurn({
    sessionId,
    upToIndex,
  }: {
    sessionId: string
    upToIndex?: number
  }): Set<string> {
    const normalizedIndex = upToIndex === undefined ? undefined : upToIndex - 1
    return getAssistantMessageIdsForLatestUserTurn({
      events: this.eventBuffer,
      sessionId,
      upToIndex: normalizedIndex,
    })
  }

  private getLatestAssistantMessageIdForCurrentTurn({
    sessionId,
    upToIndex,
  }: {
    sessionId: string
    upToIndex?: number
  }): string | undefined {
    const normalizedIndex = upToIndex === undefined ? undefined : upToIndex - 1
    return getLatestAssistantMessageIdForLatestUserTurn({
      events: this.eventBuffer,
      sessionId,
      upToIndex: normalizedIndex,
    })
  }

  private getSubtaskInfoForSession(
    candidateSessionId: string,
  ): { label: string; assistantMessageId?: string } | undefined {
    const mainSessionId = this.state?.sessionId
    if (!mainSessionId || candidateSessionId === mainSessionId) {
      return undefined
    }
    if (!isDerivedChildSession({
      events: this.eventBuffer,
      mainSessionId,
      candidateSessionId,
    })) {
      return undefined
    }

    const label = getDerivedSubtaskLabel({
      events: this.eventBuffer,
      mainSessionId,
      candidateSessionId,
    })
    if (!label) return undefined
    const assistantMessageId = this.getLatestAssistantMessageIdForCurrentTurn({
      sessionId: candidateSessionId,
    })
    return { label, assistantMessageId }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  abortDeletedDiscordResource(): void {
    if (this.getDerivedPhase() === 'running') {
      void this.abortActiveRunInternal({
        reason: 'discord-resource-deleted',
      }).apiAbortPromise
    }
  }

  dispose(): void {
    this.disposed = true
    unregisterEventListener(this.threadId)
    void this.persistEventBufferDebounced.dispose()
    this.interactiveUi.dispose()
    this.typing.stopTyping()

    // Release large internal buffers so GC can reclaim memory immediately
    // instead of waiting for the runtime object itself to become unreachable.
    this.eventBuffer = []
    this.nextEventIndex = 0
    this.partBuffer.clear()
    this.preprocessChain = Promise.resolve()

    // Don't clear actionQueue here — queued closures own resolve/reject for
    // dispatchAction() promises. Dropping them would leave awaiting callers
    // hanging forever. Instead, drain them: each closure checks this.disposed
    // and resolves early without executing real work.
    void this.processActionQueue()

    // Clean up all pending UI state for this thread (permissions, questions,
    // action buttons, file uploads, html actions).
    cleanupPendingUiForThread(this.thread.id)
    this.chat.interactions.dispose()
  }

  private compactTextForEventBuffer(text: string): string {
    if (text.length <= ThreadSessionRuntime.EVENT_BUFFER_TEXT_MAX_CHARS) {
      return text
    }
    return `${text.slice(0, ThreadSessionRuntime.EVENT_BUFFER_TEXT_MAX_CHARS)}…`
  }

  private isDefinedEventBufferValue<T>(value: T | undefined): value is T {
    return value !== undefined
  }

  private pruneLargeStringsForEventBuffer(
    value: unknown,
    seen: WeakSet<object>,
  ): void {
    if (typeof value !== 'object' || value === null) {
      return
    }
    if (seen.has(value)) {
      return
    }
    seen.add(value)

    if (Array.isArray(value)) {
      const compactedItems = value
        .map((item) => {
          if (typeof item === 'string') {
            if (item.length > ThreadSessionRuntime.EVENT_BUFFER_TEXT_MAX_CHARS) {
              return undefined
            }
            return item
          }
          this.pruneLargeStringsForEventBuffer(item, seen)
          return item
        })
        .filter((item) => {
          return this.isDefinedEventBufferValue(item)
        })
      value.splice(0, value.length, ...compactedItems)
      return
    }

    const objectValue = value as Record<string, unknown>
    for (const [key, nestedValue] of Object.entries(objectValue)) {
      if (typeof nestedValue === 'string') {
        if (nestedValue.length > ThreadSessionRuntime.EVENT_BUFFER_TEXT_MAX_CHARS) {
          delete objectValue[key]
        }
        continue
      }
      this.pruneLargeStringsForEventBuffer(nestedValue, seen)
    }
  }

  private finalizeCompactedEventForEventBuffer(
    event: EventBufferEvent,
  ): EventBufferEvent {
    this.pruneLargeStringsForEventBuffer(event, new WeakSet<object>())
    return event
  }

  private compactEventForEventBuffer(
    event: EventBufferEvent,
  ): EventBufferEvent | undefined {
    if (event.type === 'session.diff') {
      return undefined
    }

    const compacted = structuredClone(event)

    if (compacted.type === 'message') {
      // Strip heavy fields. Derivation only needs lightweight metadata (ids,
      // role, parent, time, finish, error, model, usage, partsSummary). The
      // per-message system prompt is kept aside for prompt-cache diffs.
      const info = compacted.message
      if (info.role === 'user' && info.system) {
        this.userSystemByMessageId.set(info.id, info.system)
      }
      delete info.system
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (compacted.type !== 'part') {
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    const part = compacted.part

    if (part.kind === 'text' || part.kind === 'reasoning') {
      part.text = this.compactTextForEventBuffer(part.text)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (part.kind !== 'tool') {
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    // Subagent identity lives on part.subagent and child_session_* events,
    // which survive compaction; the delegation inputs do not.
    part.input = {}
    if (part.output !== undefined) {
      part.output = this.compactTextForEventBuffer(part.output)
    }
    if (part.error !== undefined) {
      part.error = this.compactTextForEventBuffer(part.error)
    }
    return this.finalizeCompactedEventForEventBuffer(compacted)
  }

  private appendEventToBuffer(event: EventBufferEvent): void {
    const compactedEvent = this.compactEventForEventBuffer(event)
    if (!compactedEvent) {
      return
    }
    if (!shouldRetainSessionEvent({
      event: compactedEvent,
      mainSessionId: this.state?.sessionId,
      isKnownChildSession: (candidateSessionId) => {
        return Boolean(this.getSubtaskInfoForSession(candidateSessionId))
      },
    })) {
      return
    }

    const timestamp = Date.now()
    const eventIndex = this.nextEventIndex
    this.nextEventIndex += 1
    this.eventBuffer.push({
      event: compactedEvent,
      timestamp,
      eventIndex,
    })
    this.eventBuffer = trimEventBuffer({
      events: this.eventBuffer,
      mainSessionId: this.state?.sessionId,
      max: ThreadSessionRuntime.EVENT_BUFFER_MAX,
      isKnownChildSession: (candidateSessionId) => {
        return Boolean(this.getSubtaskInfoForSession(candidateSessionId))
      },
    })
    this.persistEventBufferDebounced.trigger()
  }

  seedForkPromptCacheBaseline(message: AgentMessage): void {
    if (message.role !== 'assistant') return
    if (message.sessionId !== this.state?.sessionId || this.eventBuffer.length > 0) return
    this.appendEventToBuffer({ type: 'message', message })
  }

  // Queue-dispatch lifecycle markers are synthetic buffer-only events.
  // They are not fed into handleEvent(), so they do not emit Discord messages;
  // they only stabilize event-derived busy/idle gating for local queue drains.
  private markQueueDispatchBusy(sessionId: string): void {
    this.appendEventToBuffer({ type: 'status', sessionId, status: { state: 'busy' } })
  }

  private markQueueDispatchIdle(sessionId: string): void {
    this.appendEventToBuffer({ type: 'idle', sessionId })
  }

  /**
   * Generic event waiter: polls the event buffer until a matching event
   * appears (with timestamp >= sinceTimestamp), or timeout/abort.
   *
   * Unlike the old idleWaiter (a promise wired into handleSessionIdle),
   * this has zero coupling to specific event handlers — it just scans
   * the buffer that handleEvent() fills. Works for any event type.
   */
  private async waitForEvent(opts: {
    predicate: (event: EventBufferEvent) => boolean
    sinceTimestamp: number
    timeoutMs: number
    pollMs?: number
  }): Promise<EventBufferEvent | undefined> {
    const { predicate, sinceTimestamp, timeoutMs, pollMs = 50 } = opts
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.disposed) {
        return undefined
      }
      const match = this.eventBuffer.find((entry) => {
        return entry.timestamp >= sinceTimestamp && predicate(entry.event)
      })
      if (match) {
        return match.event
      }
      await delay(pollMs)
    }

    logger.warn(
      `[WAIT EVENT] Timeout after ${timeoutMs}ms for thread ${this.threadId}, proceeding`,
    )
    return undefined
  }

  // Seed sentPartIds from DB to avoid re-sending parts that were
  // already sent in a previous runtime or before a reconnect.
  private async bootstrapSentPartIds(): Promise<void> {
    const existingPartIds = await getPartMessageIds(this.thread.id)
    if (existingPartIds.length === 0) {
      return
    }
    threadState.updateThread(this.threadId, (t) => {
      const newIds = new Set(t.sentPartIds)
      for (const id of existingPartIds) {
        newIds.add(id)
      }
      return { ...t, sentPartIds: newIds }
    })
  }

  // ── Session Demux Guard ─────────────────────────────────────
  // Events scoped to a session must match the current session.
  // Global events (tui.toast.show) bypass the guard.
  // Subtask sessions also bypass — they're tracked in subtaskSessions.

  private async handleEvent(event: AgentBackendEvent): Promise<void> {
    // One backend event can imply several Roadie agent events (a task tool
    // part update also carries child-session lifecycle); the backend already
    // translated them. Each runs the full pipeline: buffer check, append, log,
    // and its own switch case. The raw backend payload is logged once, with
    // the first implied agent event.
    const agentEvents = event.events
    for (let i = 0; i < agentEvents.length; i++) {
      await this.handleAgentEvent({
        agentEvent: agentEvents[i]!,
        ...(i === 0 && { rawBackendEvent: event.raw, backend: event.backend }),
      })
    }
  }

  private async handleAgentEvent({
    agentEvent,
    rawBackendEvent,
    backend,
  }: {
    agentEvent: AgentEvent
    /** Present on the first agent event derived from one backend event; the opt-in jsonl log writes it. */
    rawBackendEvent?: unknown
    /** Which backend produced `rawBackendEvent`; the log tags the record with it. */
    backend?: string
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!shouldBufferSessionEvent({
      event: agentEvent,
      mainSessionId: sessionId,
      isKnownChildSession: (candidateSessionId) => {
        return Boolean(this.getSubtaskInfoForSession(candidateSessionId))
      },
    })) {
      return
    }

    // Skip part deltas from the event buffer — no derivation function
    // (isSessionBusy, doesLatestUserTurnHaveNaturalCompletion, waitForEvent,
    // etc.) uses them. During long streaming responses they flood the 1000-slot
    // buffer, evicting busy status events that isSessionBusy needs,
    // causing tryDrainQueue to drain the local queue while the session is
    // actually still busy. This was the root cause of "? queue" messages
    // interrupting instead of queuing.
    // Child task part floods are also dropped at retain time for the same reason.
    // Duplicate delegation starts are detected before this append lands.
    const isDuplicateChildSessionStart = agentEvent.type === 'child_session_started'
      && this.eventBuffer.some((entry) => {
        return entry.event.type === 'child_session_started'
          && entry.event.parentSessionId === agentEvent.parentSessionId
          && entry.event.childSessionId === agentEvent.childSessionId
      })
    if (agentEvent.type !== 'part.delta') {
      this.appendEventToBuffer(agentEvent)
    }

    const eventSessionId = agentEventSessionId(agentEvent)
    const toastSessionId = agentEvent.type === 'notice'
      ? extractToastSessionId({ message: agentEvent.message })
      : undefined

    if (shouldLogSessionEvents) {
      const eventDetails = (() => {
        if (agentEvent.type === 'error') {
          return ` error=${agentEvent.error?.name || 'unknown'}`
        }
        if (agentEvent.type === 'status') {
          return ` status=${agentEvent.status.state}`
        }
        if (agentEvent.type === 'message') {
          return ` role=${agentEvent.message.role} messageID=${agentEvent.message.id}`
        }
        if (agentEvent.type === 'part') {
          const { part } = agentEvent
          const toolSuffix = part.kind === 'tool'
            ? ` tool=${part.tool} status=${part.status}`
            : ''
          return ` part=${part.kind} partID=${part.id} messageID=${part.messageId}${toolSuffix}`
        }
        return ''
      })()
      logger.log(
        `[EVENT] type=${agentEvent.type} eventSessionId=${eventSessionId || 'none'} activeSessionId=${sessionId || 'none'} ${this.formatRunStateForLog()}${eventDetails}`,
      )
    }

    const isGlobalEvent = agentEvent.type === 'notice'
    const isScopedToastEvent = Boolean(toastSessionId)

    // Drop events that don't match current session (stale events from
    // previous sessions), unless it's a global event or a subtask session.
    if (!isGlobalEvent && eventSessionId && eventSessionId !== sessionId) {
      if (!this.getSubtaskInfoForSession(eventSessionId)) {
        return // stale event from previous session
      }
    }
    if (isScopedToastEvent && toastSessionId !== sessionId) {
      if (!this.getSubtaskInfoForSession(toastSessionId!)) {
        return
      }
    }

    if (rawBackendEvent !== undefined && isSessionEventLogEnabled()) {
      const eventLogResult = await appendSessionEventLog({
        threadId: this.threadId,
        projectDirectory: this.projectDirectory,
        backend,
        sessionId: eventSessionId,
        event: rawBackendEvent,
      })
      if (eventLogResult instanceof Error) {
        logger.error(
          '[SESSION EVENT JSONL] Failed to write session event log:',
          eventLogResult,
        )
      }
    }

    switch (agentEvent.type) {
      case 'message':
        await this.handleMessageUpdated(agentEvent.message)
        break
      case 'part':
        await this.handlePartUpdated(agentEvent.part)
        break
      case 'idle': {
        await completeScheduledTaskRunsForSession(agentEvent.sessionId)
        await this.handleSessionIdle(agentEvent.sessionId)
        // Not awaited: plugins never hold up the event stream.
        const idleParentSessionId = this.getActionParentSessionId(agentEvent.sessionId)
        void doAction('session_idle', {
          sessionId: agentEvent.sessionId,
          threadId: this.threadId,
          ...(idleParentSessionId && { parentSessionId: idleParentSessionId }),
        })
        break
      }
      case 'error': {
        if (agentEvent.sessionId) {
          await failScheduledTaskRunsForSession({
            sessionId: agentEvent.sessionId,
            error: agentEvent.error?.message || 'Session failed',
          })
        }
        await this.handleSessionError(agentEvent)
        if (agentEvent.error?.name !== 'MessageAbortedError') {
          const errorParentSessionId = this.getActionParentSessionId(agentEvent.sessionId)
          void doAction('session_error', {
            ...(agentEvent.sessionId && { sessionId: agentEvent.sessionId }),
            ...(errorParentSessionId && { parentSessionId: errorParentSessionId }),
            threadId: this.threadId,
            message: agentEvent.error?.message || 'Session failed',
          })
        }
        break
      }
      case 'child_session_started':
      case 'child_session_finished':
        if (agentEvent.type === 'child_session_started' && isDuplicateChildSessionStart) {
          break
        }
        this.handleChildSessionEvent(agentEvent)
        break
      case 'permission.asked':
        await this.interactiveUi.handlePermissionAsked(agentEvent.request)
        break
      case 'permission.replied':
        this.handlePermissionReplied(agentEvent)
        break
      case 'question.asked':
        await this.interactiveUi.handleQuestionAsked(agentEvent.request)
        break
      case 'question.replied':
        this.handleQuestionReplied(agentEvent)
        break
      case 'form.asked':
        await this.handleFormAsked(agentEvent.request)
        break
      case 'form.replied':
        this.handleFormReplied(agentEvent)
        break
      case 'status':
        await this.handleSessionStatus(agentEvent)
        break
      case 'session.updated':
        await this.handleSessionUpdated(agentEvent.session)
        break
      case 'notice':
        await this.handleTuiToast(agentEvent)
        break
      default:
        break
    }
  }

  private getActionParentSessionId(eventSessionId: string | undefined): string | undefined {
    return resolveActionParentSessionId({
      eventSessionId,
      mainSessionId: this.state?.sessionId,
      threadParentSessionId: this.state?.parentSessionId,
      isChildSession: (candidate) => Boolean(this.getSubtaskInfoForSession(candidate)),
    })
  }

  // Delegation lifecycle surfaced to plugins. Duplicate started events were
  // detected before the event entered the buffer, so only the first fires.
  private handleChildSessionEvent(event: AgentChildSessionEvent): void {
    void doAction(event.type, {
      parentSessionId: event.parentSessionId,
      childSessionId: event.childSessionId,
      ...(event.agent && { agent: event.agent }),
      ...(event.description && { description: event.description }),
      ...(event.status && { status: event.status }),
      threadId: this.threadId,
    })
  }


  // ── Serialized Action Queue (§7.4) ──────────────────────────
  // Serializes event handling + local-queue state mutations.

  async dispatchAction(action: () => Promise<void>): Promise<void> {
    if (this.disposed) {
      return
    }
    return new Promise<void>((resolve, reject) => {
      this.actionQueue.push(async () => {
        if (this.disposed) {
          resolve()
          return
        }
        const result = await action().catch((e) => new AgentBackendError({ operation: 'dispatchAction', cause: e }))
        if (result instanceof Error) {
          reject(result)
          return
        }
        resolve()
      })
      void this.processActionQueue()
    })
  }

  // Process serialized action queue. Uses try/finally to guarantee
  // processingAction is always reset — if we didn't, a thrown action
  // would leave the flag true and deadlock all future actions.
  private async processActionQueue(): Promise<void> {
    if (this.processingAction) {
      return
    }
    this.processingAction = true
    try {
      while (this.actionQueue.length > 0) {
        const next = this.actionQueue.shift()
        if (!next) {
          continue
        }
        // Each queued action already wraps itself with .catch()
        // and calls resolve/reject, so this should not throw. But if it
        // does, the try/finally ensures we don't deadlock.
        const result = await next().catch((e) => new AgentBackendError({ operation: 'processAction', cause: e }))
        if (result instanceof Error) {
          logger.error('[ACTION QUEUE] Unexpected action failure:', result)
        }
      }
    } finally {
      this.processingAction = false
    }
  }

  // ── Typing Indicator Management ─────────────────────────────

  private hasPendingQuestionUi(): boolean {
    return this.chat.interactions.hasQuestion()
  }

  private hasPendingInteractiveUi(): boolean {
    if (this.chat.interactions.hasPending()) return true
    if (this.hasPendingQuestionUi()) {
      return true
    }
    const hasPendingActionButtons = [...pendingActionButtonContexts.values()].some(
      (ctx) => {
        return ctx.thread.id === this.thread.id
      },
    )
    if (hasPendingActionButtons) {
      return true
    }
    const hasPendingFileUpload = [...pendingFileUploadContexts.values()].some(
      (ctx) => {
        return ctx.thread.id === this.thread.id
      },
    )
    if (hasPendingFileUpload) {
      return true
    }
    return (pendingPermissions.get(this.thread.id)?.size ?? 0) > 0
  }

  onInteractiveUiStateChanged(): void {
    this.typing.ensureTypingNow()
    void this.dispatchAction(() => {
      return this.messageQueue.tryDrainQueue({ showIndicator: true })
    })
  }

  // ── Part Buffering & Output ─────────────────────────────────

  private getVerbosityChannelId(): string {
    return this.channelId || this.chat.parentId || this.chat.id
  }

  private async getVerbosity() {
    return getChannelVerbosity(this.getVerbosityChannelId())
  }

  private storePart(part: AgentPart): void {
    const messageParts =
      this.partBuffer.get(part.messageId) || new Map<string, AgentPart>()
    messageParts.set(part.id, part)
    this.partBuffer.set(part.messageId, messageParts)
  }

  /**
   * A backend can learn only after streaming that a reasoning part was
   * user-facing text (Pi narration, #288); the update reuses the part id.
   */
  private isReasoningPromotedToText(part: AgentPart): boolean {
    if (part.kind !== 'text') return false
    return this.partBuffer.get(part.messageId)?.get(part.id)?.kind === 'reasoning'
  }

  /**
   * If the reasoning line for a promoted part was already posted, rewrite that
   * message as the text. When there is no message to edit, the part is
   * unmarked so the normal flush posts it.
   */
  private async replaceSentReasoningWithText(part: AgentPart): Promise<void> {
    if (part.kind !== 'text' || !this.state?.sentPartIds.has(part.id)) return
    const unmark = () => {
      threadState.updateThread(this.threadId, (t) => {
        const newIds = new Set(t.sentPartIds)
        newIds.delete(part.id)
        return { ...t, sentPartIds: newIds }
      })
    }
    const db = await getDb()
    const row = await db.query.part_messages.findFirst({
      where: { part_id: part.id },
      columns: { message_id: true },
    }).catch((e) => new DiscordOperationError({ operation: 'getPartMessage', cause: e }))
    const messageId = row instanceof Error ? undefined : row?.message_id
    if (!messageId) {
      unmark()
      return
    }
    const edited = await this.chat.editMessageText(
      messageId,
      sessionPartContent({ content: formatPart(part), leadWithBlankLine: false }),
    )
    if (edited instanceof Error) {
      discordLogger.error(`ERROR: Failed to replace reasoning with text ${part.id}:`, edited)
      unmark()
    }
  }

  private getBufferedParts(messageID: string): AgentPart[] {
    return Array.from(this.partBuffer.get(messageID)?.values() ?? [])
  }

  private clearBufferedPartsForMessages(messageIDs: ReadonlyArray<string>): void {
    const uniqueMessageIDs = new Set(messageIDs)
    uniqueMessageIDs.forEach((messageID) => {
      this.partBuffer.delete(messageID)
    })
  }

  private hasBufferedStepFinish(messageID: string): boolean {
    return this.getBufferedParts(messageID).some((part) => {
      return part.kind === 'step-finish'
    })
  }

  private shouldSendPlannedPart({
    part,
    mode,
  }: {
    part: AgentPart
    mode: AssistantTurnFlushMode
  }): boolean {
    if (part.kind === 'step-start' || part.kind === 'step-finish') {
      return false
    }
    if (part.kind === 'tool' && part.status === 'pending') {
      return false
    }
    if (part.kind === 'text' && !part.endedAt && mode === 'progress') {
      return false
    }
    if (part.kind === 'text' && part.synthetic === true) {
      return false
    }
    return true
  }

  private getCurrentTurnParts(): AgentPart[] {
    const sessionId = this.state?.sessionId
    const messageIds = sessionId
      ? [...this.getAssistantMessageIdsForCurrentTurn({ sessionId })]
      : []
    if (messageIds.length > 0) {
      return messageIds.flatMap((id) => this.getBufferedParts(id))
    }
    return []
  }

  private async unquoteFinalTextPart(): Promise<void> {
    const parts = this.getCurrentTurnParts()
    const finalPart = parts.findLast((part) => part.kind === 'text' || part.kind === 'tool')
    if (!finalPart || finalPart.kind !== 'text') return
    await this.unquoteTextPart(finalPart)
  }

  /**
   * Text ahead of a question, sleep or action buttons stays plain. A backend
   * that ends the text block before the tool call is known (Pi) gets it sent
   * as quoted narration first, so it is unquoted once the tool shows up.
   */
  private async unquoteLeadInTextForTool(part: AgentPart): Promise<void> {
    if (part.kind !== 'tool' || !toolKeepsLeadInTextPlain(part.tool)) return
    const leadIn = leadInTextPartBefore({ parts: this.getCurrentTurnParts(), toolPartId: part.id })
    if (!leadIn || leadIn.kind !== 'text' || !this.state?.sentPartIds.has(leadIn.id)) return
    await this.unquoteTextPart(leadIn)
  }

  private async unquoteTextPart(last: Extract<AgentPart, { kind: 'text' }>): Promise<void> {
    const db = await getDb()
    const row = await db.query.part_messages.findFirst({
      where: { part_id: last.id },
      columns: { message_id: true },
    }).catch((e) => new DiscordOperationError({ operation: 'getPartMessage', cause: e }))
    if (row instanceof Error) {
      discordLogger.error(`Failed to find Discord message for ${last.id}:`, row)
      return
    }
    const messageId = row?.message_id
    if (!messageId) return
    const messageText = await this.chat.readMessageText(messageId)
    if (messageText instanceof Error) {
      discordLogger.error(`Failed to fetch Discord message for ${last.id}:`, messageText)
      return
    }
    const formatted = formatPart(last)
    const leadWithBlankLine = messageText.startsWith('\n')
    const quoted = sessionPartContent({
      content: asDiscordQuote(formatted),
      leadWithBlankLine,
    })
    if (messageText !== quoted) return
    const plain = sessionPartContent({
      content: formatted,
      leadWithBlankLine,
    })
    const edited = await this.chat.editMessageText(messageId, plain)
    if (edited instanceof Error) {
      discordLogger.error(`ERROR: Failed to unquote final text ${last.id}:`, edited)
    }
  }

  private async flushCurrentTurnParts({
    mode,
    throughPartId,
    skipPartId,
    repulseTyping = true,
  }: {
    mode: AssistantTurnFlushMode
    throughPartId?: string
    skipPartId?: string
    repulseTyping?: boolean
  }): Promise<void> {
    const parts = this.getCurrentTurnParts()
    const planned = planAssistantTurnFlush({
      parts,
      mode,
      throughPartId,
    })
    for (const { part, quoteText } of planned.sendParts) {
      if (this.state?.sentPartIds.has(part.id)) {
        continue
      }
      if (skipPartId && part.id === skipPartId) {
        continue
      }
      if (!this.shouldSendPlannedPart({ part, mode })) {
        continue
      }
      // Delegation parts render through the dedicated subtask display in
      // handleMainPart, never as generic tool lines.
      if (part.kind === 'tool' && part.subagent) {
        continue
      }
      const pulseTyping =
        part.kind === 'text' && part.ignored === true
          ? false
          : repulseTyping
      await this.sendPartMessage({
        part,
        quoteText,
        repulseTyping: pulseTyping,
      })
    }
  }

  private async sendPartMessage({
    part,
    repulseTyping = true,
    quoteText = false,
  }: {
    part: AgentPart
    repulseTyping?: boolean
    quoteText?: boolean
  }): Promise<void> {
    const verbosity = await this.getVerbosity()
    if (verbosity === 'text_only' && part.kind !== 'text') {
      return
    }
    if (verbosity === 'text_and_essential_tools') {
      if (part.kind !== 'text' && !(part.kind === 'tool' && isEssentialToolPart(part))) {
        return
      }
    }

    const formatted = formatPart(part)
    const quote =
      quoteText
      && shouldQuoteIntermediateTextPart({
        part,
        isLastInTurn: false,
      })
    const content = quote ? asDiscordQuote(formatted) : formatted
    if (!content.trim() || content.length === 0) {
      return
    }
    if (this.state?.sentPartIds.has(part.id)) {
      return
    }
    // Mark as sent BEFORE the async send to prevent concurrent flushes
    // from sending the same part while this await is in-flight.
    threadState.updateThread(this.threadId, (t) => {
      const newIds = new Set(t.sentPartIds)
      newIds.add(part.id)
      return { ...t, sentPartIds: newIds }
    })

    const kind = sessionPartKind(part)
    const sendResult = await this.chat.sendPart(content, {
      leadWithBlankLine: shouldLeadWithBlankLine({
        previousKind: this.lastSentPartKind,
        nextKind: kind,
      }),
    })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (sendResult instanceof Error) {
      threadState.updateThread(this.threadId, (t) => {
        const newIds = new Set(t.sentPartIds)
        newIds.delete(part.id)
        return { ...t, sentPartIds: newIds }
      })
      discordLogger.error(
        `ERROR: Failed to send part ${part.id}:`,
        sendResult,
      )
      return
    }
    this.lastSentPartKind = kind
    await setPartMessage({ partId: part.id, messageId: sendResult.id, threadId: this.thread.id })
    if (repulseTyping) {
      this.typing.requestTypingRepulse()
    }
  }

  private async ensureModelContextLimit({
    providerID,
    modelID,
  }: {
    providerID: string
    modelID: string
  }): Promise<void> {
    const key = `${providerID}/${modelID}`
    if (this.modelContextLimit && this.modelContextLimitKey === key) {
      return
    }
    const client = getAgentBackendProvider().getBackend(this.sdkDirectory)
    if (!client) {
      return
    }
    const catalog = await client.catalog.providers({ directory: this.sdkDirectory })
    if (catalog instanceof Error) {
      logger.error(
        'Failed to fetch provider info for context limit:',
        catalog,
      )
      return
    }
    const provider = catalog.providers.find((p) => p.id === providerID)
    const model = provider?.models[modelID]
    const contextLimit = model?.contextLimit || getFallbackContextLimit({
      providerID,
    })
    if (!contextLimit) {
      return
    }
    this.modelContextLimit = contextLimit
    this.modelContextLimitKey = key
  }

  // ── Event Handlers ──────────────────────────────────────────
  // Extracted from session-handler.ts eventHandler closure.
  // These operate on runtime instance state + global store transitions.

  private markPendingDelivery(messageId: string): void {
    this.pendingDeliveryMessageIds.push(messageId)
    void this.setPendingReaction(messageId, true)
  }

  /** The agent took the oldest pending message into the conversation. */
  private resolveOldestPendingDelivery(): void {
    const messageId = this.pendingDeliveryMessageIds.shift()
    if (messageId) {
      // What the agent says next answers this message.
      this.chat.setReplyAnchor?.(messageId)
      void this.setPendingReaction(messageId, false)
    }
  }

  private clearPendingDeliveries(): void {
    const messageIds = this.pendingDeliveryMessageIds
    this.pendingDeliveryMessageIds = []
    for (const messageId of messageIds) {
      void this.setPendingReaction(messageId, false)
    }
  }

  private async setPendingReaction(messageId: string, on: boolean): Promise<void> {
    const result = await this.chat.setPendingMarker(messageId, on)
    if (result instanceof Error) {
      logger.warn(
        `[PENDING] Failed to ${on ? 'add' : 'remove'} pending marker on ${messageId} in thread ${this.threadId}: ${result.message}`,
      )
    }
  }

  private async handleMessageUpdated(msg: AgentMessage): Promise<void> {
    const sessionId = this.state?.sessionId

    // A user message appearing in the main session while messages are pending
    // means the backend promoted the oldest one at a step boundary.
    if (
      msg.role === 'user' &&
      msg.sessionId === sessionId &&
      !this.seenUserMessageIds.has(msg.id)
    ) {
      this.seenUserMessageIds.add(msg.id)
      if (this.pendingDeliveryMessageIds.length > 0) {
        this.resolveOldestPendingDelivery()
      }
    }

    if (msg.role !== 'assistant') {
      return
    }
    if (msg.summary === true) {
      this.clearBufferedPartsForMessages([msg.id])
      logger.info(`[SKIP] message.updated for compaction summary ${msg.id}`)
      return
    }
    if (msg.sessionId !== sessionId) {
      const subtaskInfo = this.getSubtaskInfoForSession(msg.sessionId)
      if (subtaskInfo) {
        for (const part of this.getBufferedParts(msg.id)) {
          await this.handleSubtaskPart(part, subtaskInfo)
        }
      }
      return
    }
    if (!sessionId) {
      return
    }
    if (!isAssistantMessageInLatestUserTurn({
      events: this.eventBuffer,
      sessionId,
      messageId: msg.id,
    })) {
      this.clearBufferedPartsForMessages([msg.id])
      logger.info(`[SKIP] message.updated for old assistant message ${msg.id}, not in latest user turn`)
      return
    }

    const knownMessage = this.partBuffer.has(msg.id)

    // promptAsync paths can deliver complete parts via message.updated even when
    // message.part.updated events are sparse or absent. Seed the part buffer
    // from message.parts when we have not seen per-part events for this message.
    if (!knownMessage) {
      const messageParts = msg.parts ?? []
      messageParts.forEach((part) => {
        this.storePart(part)
      })
    }

    await this.flushCurrentTurnParts({
      mode: 'progress',
    })

    const wasAlreadyCompleted = hasAssistantMessageCompletedBefore({
      events: this.eventBuffer,
      sessionId,
      messageId: msg.id,
      upToIndex: this.eventBuffer.length - 2,
    })
    const completedAt = msg.completedAt
    if (!wasAlreadyCompleted && typeof completedAt === 'number') {
      if (isAssistantMessageNaturalCompletion({ message: msg })) {
        await this.handleNaturalAssistantCompletion({
          completedMessageId: msg.id,
          completedAt,
        })
        return
      }
      await this.maybeNotifyPromptCacheClear({ sessionId, messageId: msg.id })
    }

    // Context usage notice. Only while a run is in progress: once the run has
    // ended, its footer already reports the final context percentage, and a
    // late message update would post the same number again under it.
    if (!this.isBusy()) {
      return
    }
    // Skip the final assistant update for a run: by the time the last
    // message.updated arrives, the final text part has already ended and the
    // buffered parts usually include step-finish, so a notice here would land
    // immediately above the footer and add noise.
    if (this.hasBufferedStepFinish(msg.id)) {
      return
    }
    const latestRunInfo = getLatestRunInfo({
      events: this.eventBuffer,
      sessionId,
    })
    if (
      latestRunInfo.tokensUsed === 0
      || !latestRunInfo.providerID
      || !latestRunInfo.model
    ) {
      return
    }
    await this.ensureModelContextLimit({
      providerID: latestRunInfo.providerID,
      modelID: latestRunInfo.model,
    })
    if (!this.modelContextLimit) {
      return
    }
    const currentPercentage = Math.floor(
      (latestRunInfo.tokensUsed / this.modelContextLimit) * 100,
    )
    const thresholdCrossed = Math.floor(currentPercentage / 10) * 10
    if (
      thresholdCrossed <= this.lastDisplayedContextPercentage ||
      thresholdCrossed < 10
    ) {
      return
    }
    this.lastDisplayedContextPercentage = thresholdCrossed
    const chunk = asSubtext(`context usage ${currentPercentage}%`)
    const sendResult = await this.chat.sendNotice(chunk)
    if (sendResult instanceof Error) {
      discordLogger.error('Failed to send context usage notice:', sendResult)
    }
  }

  private async handlePartUpdated(part: AgentPart): Promise<void> {
    const sessionId = this.state?.sessionId
    const messageKind = getAssistantMessageKind({
      events: this.eventBuffer,
      sessionId: part.sessionId,
      messageId: part.messageId,
    })

    if (messageKind === 'summary') {
      this.clearBufferedPartsForMessages([part.messageId])
      logger.info(`[SKIP] message.part.updated for compaction summary ${part.messageId}`)
      return
    }

    if (part.kind === 'text' && part.synthetic === true) {
      return
    }

    if (part.kind === 'text' && part.ignored === true) {
      await this.sendPartMessage({ part, repulseTyping: false })
      return
    }

    const promoted = this.isReasoningPromotedToText(part)
    this.storePart(part)
    if (promoted) {
      await this.replaceSentReasoningWithText(part)
    }

    if (messageKind === 'unknown') {
      return
    }

    const subtaskInfo = this.getSubtaskInfoForSession(part.sessionId)
    const isSubtaskEvent = Boolean(subtaskInfo)

    if (part.sessionId !== sessionId && !isSubtaskEvent) {
      return
    }

    if (isSubtaskEvent && subtaskInfo) {
      await this.handleSubtaskPart(part, subtaskInfo)
      return
    }

    await this.handleMainPart(part)
  }

  private async handleMainPart(part: AgentPart): Promise<void> {
    const sessionId = this.state?.sessionId

    if (part.kind === 'step-start') {
      this.typing.ensureTypingNow()
      return
    }

    if (part.kind === 'tool') {
      await this.unquoteLeadInTextForTool(part)
    }

    if (part.kind === 'tool' && part.status === 'running') {
      await this.flushCurrentTurnParts({
        mode: 'progress',
      })
      const held = planAssistantTurnFlush({
        parts: this.getCurrentTurnParts(),
        mode: 'progress',
      }).hold.some((entry) => entry.id === part.id)
      if (held) {
        return
      }
      if (!this.state?.sentPartIds.has(part.id) && !part.subagent) {
        await this.sendPartMessage({ part })
      }

      if (part.subagent && !this.state?.sentPartIds.has(part.id)) {
        const taskDisplay = formatTaskToolTitle(part)
        if (taskDisplay && (await this.getVerbosity()) !== 'text_only') {
          threadState.updateThread(this.threadId, (t) => {
            const newIds = new Set(t.sentPartIds)
            newIds.add(part.id)
            return { ...t, sentPartIds: newIds }
          })
          const sendResult = await this.chat.sendPart(taskDisplay, {
            leadWithBlankLine: shouldLeadWithBlankLine({
              previousKind: this.lastSentPartKind,
              nextKind: 'tool',
            }),
          })
            .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
          if (sendResult instanceof Error) {
            threadState.updateThread(this.threadId, (t) => {
              const newIds = new Set(t.sentPartIds)
              newIds.delete(part.id)
              return { ...t, sentPartIds: newIds }
            })
            discordLogger.error(
              `ERROR: Failed to send task part ${part.id}:`,
              sendResult,
            )
            return
          }
          this.lastSentPartKind = 'tool'
          await setPartMessage({ partId: part.id, messageId: sendResult.id, threadId: this.thread.id })
        }
      }
      return
    }

    // Action buttons tool handler
    if (
      part.kind === 'tool' &&
      part.status === 'completed' &&
      part.tool.endsWith('roadie_action_buttons')
    ) {
      const sessionId = this.state?.sessionId
      await this.interactiveUi.showInteractiveUi({
        skipPartId: part.id,
        flushMessageId: part.messageId,
        show: async () => {
          if (!sessionId) {
            return
          }
          const request = await waitForQueuedActionButtonsRequest({
            sessionId,
            timeoutMs: 1500,
          })
          if (!request) {
            logger.warn(
              `[ACTION] No queued action-buttons request found for session ${sessionId}`,
            )
            return
          }
          if (request.threadId !== this.thread.id) {
            logger.warn(
              `[ACTION] Ignoring queued action-buttons for different thread`,
            )
            return
          }
          const showResult = await this.chat.interactions.actions({
            sessionId: request.sessionId,
            directory: request.directory,
            buttons: request.buttons,
            silent: this.getQueueLength() > 0,
          }).catch((e) => new DiscordOperationError({ operation: 'showActionButtons', cause: e }))
          if (showResult instanceof Error) {
            logger.error(
              '[ACTION] Failed to show action buttons:',
              showResult,
            )
            await this.chat.sendMessage(`Failed to show action buttons: ${showResult.message}`, { notify: true })
          }
        },
      })
      return
    }

    // Large output notification for completed tools
    if (part.kind === 'tool' && part.status === 'completed') {
      const sessionId = this.state?.sessionId
      if (sessionId) {
        const isCurrentRunMessage = isAssistantMessageInLatestUserTurn({
          events: this.eventBuffer,
          sessionId,
          messageId: part.messageId,
        })
        if (!isCurrentRunMessage) {
          logger.info(`[SKIP] tool part ${part.id} for old assistant message ${part.messageId}, not in latest user turn`)
          return
        }
      }
      const showLargeOutput = await (async () => {
        const verbosity = await this.getVerbosity()
        if (verbosity === 'text_only') {
          return false
        }
        if (verbosity === 'text_and_essential_tools') {
          return isEssentialToolPart(part)
        }
        return true
      })()
      if (showLargeOutput) {
        const output = part.output || ''
        const outputTokens = Math.ceil(output.length / 4)
        const largeOutputThreshold = 3000
        if (outputTokens >= largeOutputThreshold) {
          if (sessionId) {
            const latestRunInfo = getLatestRunInfo({
              events: this.eventBuffer,
              sessionId,
            })
            if (latestRunInfo.providerID && latestRunInfo.model) {
              await this.ensureModelContextLimit({
                providerID: latestRunInfo.providerID,
                modelID: latestRunInfo.model,
              })
            }
          }
          const formattedTokens =
            outputTokens >= 1000
              ? `${(outputTokens / 1000).toFixed(1)}k`
              : String(outputTokens)
          const percentageSuffix = (() => {
            if (!this.modelContextLimit) {
              return ''
            }
            const pct = (outputTokens / this.modelContextLimit) * 100
            if (pct < 1) {
              return ''
            }
            return ` (${pct.toFixed(1)}%)`
          })()
          const chunk = asSubtext(`${STATUS_PREFIX}${part.tool} returned ${formattedTokens} tokens${percentageSuffix}`)
          const largeOutputResult = await this.chat.sendNotice(chunk)
          if (largeOutputResult instanceof Error) {
            discordLogger.error('Failed to send large output notice:', largeOutputResult)
          }
        }
      }
    }

    if (part.kind === 'reasoning') {
      await this.flushCurrentTurnParts({ mode: 'progress' })
      return
    }

    if (part.kind === 'text') {
      await this.flushCurrentTurnParts({ mode: 'progress' })
      if (part.endedAt) {
        await this.interactiveUi.tryShowPendingQuestion()
      }
      return
    }

    if (part.kind === 'step-finish') {
      this.typing.ensureTypingKeepalive()
    }
  }

  private async handleSubtaskPart(
    part: AgentPart,
    subtaskInfo: { label: string; assistantMessageId?: string },
  ): Promise<void> {
    const verbosity = await this.getVerbosity()
    if (verbosity === 'text_only') {
      return
    }
    if (verbosity === 'text_and_essential_tools') {
      if (!isEssentialToolPart(part)) {
        return
      }
    }
    if (part.kind === 'step-start' || part.kind === 'step-finish') {
      return
    }
    if (part.kind === 'tool' && part.status === 'pending') {
      return
    }
    if (part.kind === 'text') {
      return
    }
    if (
      !subtaskInfo.assistantMessageId ||
      part.messageId !== subtaskInfo.assistantMessageId
    ) {
      return
    }

    const content = formatPart(part, subtaskInfo.label)
    if (!content.trim() || this.state?.sentPartIds.has(part.id)) {
      return
    }
    const kind = sessionPartKind(part)
    const sendResult = await this.chat.sendPart(content, {
      leadWithBlankLine: shouldLeadWithBlankLine({
        previousKind: this.lastSentPartKind,
        nextKind: kind,
      }),
    })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (sendResult instanceof Error) {
      discordLogger.error(
        `ERROR: Failed to send subtask part ${part.id}:`,
        sendResult,
      )
      return
    }
    this.lastSentPartKind = kind
    threadState.updateThread(this.threadId, (t) => {
      const newIds = new Set(t.sentPartIds)
      newIds.add(part.id)
      return { ...t, sentPartIds: newIds }
    })
    await setPartMessage({ partId: part.id, messageId: sendResult.id, threadId: this.thread.id })
    this.typing.requestTypingRepulse()
  }

  private async handleSessionIdle(idleSessionId: string): Promise<void> {
    const sessionId = this.state?.sessionId

    // ── Subtask idle ──────────────────────────────────────────
    const subtask = this.getSubtaskInfoForSession(idleSessionId)
    if (subtask) {
      logger.log(
        `[SUBTASK IDLE] Subtask "${subtask?.label}" completed`,
      )
      return
    }

    // ── Main session idle ─────────────────────────────────────
    // The event is also pushed into the event buffer by handleEvent(),
    // so waitForEvent() consumers (abort settlement) will see it too.
    if (idleSessionId === sessionId) {
      // The run ended; anything still marked pending was taken or dropped.
      this.clearPendingDeliveries()
      const shouldDrainQueuedMessages = doesLatestUserTurnHaveNaturalCompletion({
        events: this.eventBuffer,
        sessionId: idleSessionId,
      })

      logger.log(
        `[SESSION IDLE] session became idle sessionId=${sessionId} drainQueue=${shouldDrainQueuedMessages} ${this.formatRunStateForLog()}`,
      )
      await this.persistEventBufferDebounced.flush()
      this.roadieAbortPending = false
      await this.settleRestartContinuation(idleSessionId)

      if (!shouldDrainQueuedMessages) {
        return
      }
      // Drain any local-queue items that arrived while the session was busy
      // (e.g. slow preprocessing with a forced queue completing
      // during or just before idle). Same pattern as handleSessionError.
      await this.messageQueue.tryDrainQueue({ showIndicator: true })
      return
    }
  }

  /** Send the restart continuation prompt and watch its turn until it replies. */
  async resumeAfterRestart(input: IngressInput): Promise<EnqueueResult> {
    const continuation = { ...input, isRestartContinuation: true }
    this.restartContinuation = { input: continuation, attempt: 1, priorUserMessageIds: this.currentUserMessageIds() }
    return this.enqueueIncoming(continuation)
  }

  private currentUserMessageIds(): Set<string> {
    const ids = new Set<string>()
    for (const entry of this.eventBuffer) {
      if (entry.event.type === 'message' && entry.event.message.role === 'user') {
        ids.add(entry.event.message.id)
      }
    }
    return ids
  }

  private async settleRestartContinuation(sessionId: string): Promise<void> {
    const watch = this.restartContinuation
    if (!watch) {
      return
    }
    const outcome = getContinuationTurnOutcome({
      events: this.eventBuffer,
      sessionId,
      promptText: watch.input.prompt,
      priorUserMessageIds: watch.priorUserMessageIds,
    })
    logger.log(
      `[RESTART CONTINUATION] idle outcome=${outcome} attempt=${watch.attempt} sessionId=${sessionId} threadId=${this.threadId}`,
    )
    if (outcome === 'pending') {
      return
    }
    if (outcome !== 'aborted-empty') {
      this.restartContinuation = undefined
      return
    }
    if (watch.attempt < RESTART_CONTINUATION_MAX_ATTEMPTS) {
      watch.attempt += 1
      // A duplicate idle for the aborted attempt can arrive before the re-sent
      // prompt shows up; treating the aborted one as prior keeps that pending.
      watch.priorUserMessageIds = this.currentUserMessageIds()
      logger.warn(
        `[RESTART CONTINUATION] turn ended aborted with no output, re-sending (attempt ${watch.attempt}/${RESTART_CONTINUATION_MAX_ATTEMPTS}) sessionId=${sessionId} threadId=${this.threadId}`,
      )
      // Called from the action queue, so the re-send must not be awaited here.
      void this.enqueueIncoming(watch.input).catch((error: unknown) => {
        logger.warn(
          `[RESTART CONTINUATION] re-send failed threadId=${this.threadId}: ${error instanceof Error ? error.message : String(error)}`,
        )
        this.restartContinuation = undefined
        void this.chat.sendNotice(asSubtext(RESTART_CONTINUATION_FAILED_NOTICE))
      })
      return
    }
    this.restartContinuation = undefined
    logger.warn(
      `[RESTART CONTINUATION] turn ended aborted with no output after ${watch.attempt} attempts, giving up sessionId=${sessionId} threadId=${this.threadId}`,
    )
    await this.chat.sendNotice(asSubtext(RESTART_CONTINUATION_FAILED_NOTICE))
  }

  private async handleNaturalAssistantCompletion({
    completedMessageId,
    completedAt,
  }: {
    completedMessageId: string
    completedAt: number
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return
    }

    const assistantMessageIds = [
      ...this.getAssistantMessageIdsForCurrentTurn({ sessionId }),
    ]
    if (assistantMessageIds.length === 0) {
      return
    }

    await this.flushCurrentTurnParts({
      mode: 'final',
      repulseTyping: false,
    })
    await this.unquoteFinalTextPart()

    await this.maybeNotifyPromptCacheClear({
      sessionId,
      messageId: completedMessageId,
    })

    // Skip footer if model produced no visible output (no text, no tool calls,
    // just step-start/step-finish lifecycle parts). This happens when the model
    // decides not to respond.
    const hasVisibleOutput = assistantMessageIds.some((msgId) => {
      const parts = this.getBufferedParts(msgId)
      return parts.some(
        (part) => part.kind !== 'step-start' && part.kind !== 'step-finish',
      )
    })
    if (!hasVisibleOutput) {
      this.typing.stopTyping()
      this.resetPerRunState()
      this.clearBufferedPartsForMessages(assistantMessageIds)
      logger.log(
        `[ASSISTANT COMPLETED] no visible output, skipping footer for message ${completedMessageId} sessionId=${sessionId}`,
      )
      return
    }

    this.typing.stopTyping()

    const turnStartTime = getCurrentTurnStartTime({
      events: this.eventBuffer,
      sessionId,
    })
    if (turnStartTime !== undefined) {
      await this.emitFooter({
        completedAt,
        runStartTime: turnStartTime,
      })
    }

    this.resetPerRunState()
    this.clearBufferedPartsForMessages(assistantMessageIds)
    logger.log(
      `[ASSISTANT COMPLETED] footer emitted for message ${completedMessageId} sessionId=${sessionId} ${this.formatRunStateForLog()}`,
    )
  }

  private async handleSessionError(event: {
    sessionId?: string
    error?: AgentError
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!event.sessionId || event.sessionId !== sessionId) {
      logger.log(
        `Ignoring error for different session (expected: ${sessionId}, got: ${event.sessionId})`,
      )
      return
    }

    // Skip abort errors — they are expected when operations are cancelled
    if (event.error?.name === 'MessageAbortedError') {
      if (this.roadieAbortPending) {
        logger.log(
          `[SESSION ERROR] Operation aborted (expected) sessionId=${sessionId} ${this.formatRunStateForLog()}`,
        )
      } else {
        logger.warn(
          `[SESSION ERROR] Run aborted by the agent backend, not by Roadie sessionId=${sessionId} ${this.formatRunStateForLog()}`,
        )
      }
      await this.persistEventBufferDebounced.flush()
      return
    }

    const errorMessage = truncateSessionErrorMessage(
      formatSessionErrorFromProps(event.error),
    )
    logger.error(`Sending error to thread: ${errorMessage}`)
    await this.chat.sendMessage(`✗ session error: ${errorMessage}`, { notify: true })
    await this.persistEventBufferDebounced.flush()

    // Inject synthetic idle so isSessionBusy() returns false and queued
    // messages can drain. Without this, a session error leaves the event
    // buffer in a "busy" state forever (no session.idle follows the error),
    // causing local-queue items to be stuck indefinitely. See #74.
    this.markQueueDispatchIdle(sessionId)
    await this.messageQueue.tryDrainQueue({ showIndicator: true })
  }

  private handlePermissionReplied(properties: {
    requestId: string
    reply: string
    sessionId: string
  }): void {
    const sessionId = this.state?.sessionId
    const subtaskInfo = this.getSubtaskInfoForSession(properties.sessionId)
    const isMainSession = properties.sessionId === sessionId
    const isSubtaskSession = Boolean(subtaskInfo)

    if (!isMainSession && !isSubtaskSession) {
      return
    }

    logger.log(
      `Permission ${properties.requestId} replied with: ${properties.reply}`,
    )

    const threadPermissions = pendingPermissions.get(this.thread.id)
    if (!threadPermissions) {
      return
    }
    const pending = threadPermissions.get(properties.requestId)
    if (!pending) {
      return
    }
    this.chat.interactions.clearPermission(pending.contextHash)
    threadPermissions.delete(properties.requestId)
    if (threadPermissions.size === 0) {
      pendingPermissions.delete(this.thread.id)
    }
    this.onInteractiveUiStateChanged()
  }

  private handleQuestionReplied(properties: { sessionId: string }): void {
    const sessionId = this.state?.sessionId
    if (properties.sessionId !== sessionId) {
      return
    }
    this.interactiveUi.clearDeferredQuestionShow()
    this.onInteractiveUiStateChanged()
  }

  /**
   * An MCP form elicitation: show the server's message with Accept / Decline /
   * Cancel. Platforms without a form UI get the form answered cancel, so a
   * server never runs an operation nobody could approve. Forms are main-
   * session only: a task child's rules deny person MCP anyway.
   */
  private async handleFormAsked(request: AgentFormRequest): Promise<void> {
    const sessionId = this.state?.sessionId
    if (request.sessionId !== sessionId) {
      logger.log(
        `[FORM IGNORED] Form for different session (expected: ${sessionId}, got: ${request.sessionId})`,
      )
      return
    }
    const show = this.chat.interactions.form
    if (!show) {
      logger.log(`[FORM] No form UI on ${this.chat.platform}; cancelling form ${request.id}`)
      await this.answerFormCancel(request.id)
      return
    }
    logger.log(`Form requested: id=${request.id}, server=${request.server}, tool=${request.tool}`)
    try {
      await this.interactiveUi.showInteractiveUi({
        show: async () => {
          await show({
            sessionId,
            directory: this.sdkDirectory,
            requestId: request.id,
            request,
            silent: this.getQueueLength() > 0,
          })
        },
      })
    } catch (error) {
      logger.error('Failed to show MCP form dialog:', error)
      await this.answerFormCancel(request.id)
    }
  }

  /**
   * Answer a form cancel without a person (no form UI on this platform, or
   * the dialog could not be shown): the backend settles it, the server runs
   * nothing, and the tool result explains the cancel.
   */
  private async answerFormCancel(requestId: string): Promise<void> {
    const client = getAgentBackendProvider().getBackend(this.sdkDirectory)
    await client?.sessions.replyForm?.({ requestId, directory: this.sdkDirectory, action: 'cancel' })
  }

  /** The backend answered a form on its own (timeout, abort) or through a click: retire the dialog. */
  private handleFormReplied(event: { sessionId: string; requestId: string; action: 'accept' | 'decline' | 'cancel' }): void {
    if (event.sessionId !== this.state?.sessionId) {
      return
    }
    void cancelPendingMcpFormsForRequest({
      threadId: this.thread.id,
      requestId: event.requestId,
      action: event.action,
    }).catch((error: unknown) => logger.warn('Could not retire MCP form dialog:', error))
  }

  private async handleSessionStatus(event: {
    sessionId: string
    status: AgentStatus
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (event.sessionId !== sessionId) {
      return
    }

    if (event.status.state === 'idle') {
      this.typing.stopTyping()
      return
    }

    if (event.status.state === 'busy') {
      this.typing.ensureTypingNow()
      return
    }

    if (event.status.state === 'compacting' || event.status.state === 'compaction-failed') {
      this.typing.ensureTypingNow()
      const notice = event.status.state === 'compacting'
        ? `compacting context (${event.status.reason})…`
        : `compaction failed: ${event.status.message}`
      const result = await this.chat.sendNotice(asSubtext(notice))
      if (result instanceof Error) discordLogger.error('Failed to send compaction notice:', result)
      return
    }

    if (event.status.state !== 'retry') {
      return
    }

    // Throttle to once per 10 seconds
    const now = Date.now()
    if (now - this.lastRateLimitDisplayTime < 10_000) {
      return
    }
    this.lastRateLimitDisplayTime = now

    const { attempt, message, nextAt: next } = event.status
    const remainingMs = Math.max(0, next - now)
    const remainingSec = Math.ceil(remainingMs / 1000)
    const duration = (() => {
      if (remainingSec < 60) {
        return `${remainingSec}s`
      }
      const mins = Math.floor(remainingSec / 60)
      const secs = remainingSec % 60
      return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
    })()

    const chunk = asSubtext(`${message} - retrying in ${duration} (attempt #${attempt})`)
    const retryResult = await this.chat.sendNotice(chunk)
    if (retryResult instanceof Error) {
      discordLogger.error('Failed to send retry notice:', retryResult)
    }
  }

  // Rename the Discord thread to match the generated session title.
  //
  // Discord rate-limits channel/thread renames heavily — reported as ~2 per
  // 10 minutes per thread (discord/discord-api-docs#1900, discordjs/discord.js#6651)
  // and discord.js setName() can block silently on the 3rd attempt. We therefore:
  // - rename at most once per distinct title (deduped via appliedSessionTitle
  //   in-process, thread_sessions.last_synced_name across restarts)
  // - leave the name alone once a person has renamed the thread by hand
  //   (detected against last_synced_name, ignoring preserved prefixes)
  // - race setName() against an AbortSignal.timeout() so a throttled call never
  //   blocks the event loop
  // - fail soft (log + continue) on timeout, 429, or any other error
  private async handleSessionUpdated(info: {
    id: string
    title: string
  }): Promise<void> {
    // Only act on the main session for this thread
    if (info.id !== this.state?.sessionId) {
      return
    }
    const normalizedTitle = info.title.trim()
    if (this.appliedSessionTitle === normalizedTitle) {
      return
    }
    if (!this.chat.capabilities.rename) {
      await (await getDb()).update(schema.thread_sessions).set({ last_synced_name: normalizedTitle }).where(orm.eq(schema.thread_sessions.thread_id, this.threadId))
      const synced = await this.chat.syncTitle?.(normalizedTitle)
      if (synced instanceof Error) logger.warn('Could not synchronize native chat title:', synced)
      this.appliedSessionTitle = normalizedTitle
      return
    }
    const lastSyncedName = await getThreadLastSyncedName(this.threadId)
    const desiredName = resolveAutoThreadRename({
      sessionTitle: info.title,
      currentName: this.chat.name,
      lastSyncedName,
    })
    // Mark before setName so concurrent session.updated events don't stack
    // renames. Keep the mark on failure — retry is almost always a rate limit.
    this.appliedSessionTitle = normalizedTitle
    if (!desiredName) {
      return
    }

    const renameResult = await raceDiscordRename({
      rename: this.chat.rename(desiredName)
        .catch((e) =>
          new Error('Failed to rename thread from session title', {
            cause: e,
          }),
        ),
    })

    if (renameResult === 'timeout') {
      logger.warn(
        `[TITLE] setName timed out after ${DISCORD_THREAD_RENAME_TIMEOUT_MS}ms for thread ${this.threadId} (likely rate-limited)`,
      )
      return
    }
    if (renameResult instanceof Error) {
      logger.warn(
        `[TITLE] Could not rename thread ${this.threadId}: ${renameResult.message}`,
      )
      return
    }
    // Record the name we applied so restarts dedupe against it and manual
    // renames can be detected. Fail soft: the rename itself already succeeded.
    try {
      await (await getDb()).update(schema.thread_sessions)
        .set({ last_synced_name: desiredName })
        .where(orm.eq(schema.thread_sessions.thread_id, this.threadId))
    } catch (error) {
      logger.warn(
        `[TITLE] Could not record applied name for thread ${this.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    logger.log(
      `[TITLE] Renamed thread ${this.threadId} to "${desiredName}" from agent session title`,
    )
  }

  private async handleTuiToast(properties: {
    title?: string
    message: string
    level: 'info' | 'success' | 'warning' | 'error'
  }): Promise<void> {
    if (properties.level === 'warning') {
      return
    }
    const toastSessionId = extractToastSessionId({ message: properties.message })
    if (!toastSessionId) {
      return
    }
    const toastMessage = stripToastSessionId({ message: properties.message }).trim()
    if (!toastMessage) {
      return
    }
    const titlePrefix = properties.title
      ? `${properties.title.trim()}: `
      : ''
    const chunk = asSubtext(`${properties.level}: ${titlePrefix}${toastMessage}`)
    const toastResult = await this.chat.sendNotice(chunk)
    if (toastResult instanceof Error) {
      discordLogger.error('Failed to send toast notice:', toastResult)
    }
  }

  // ── Ingress API ─────────────────────────────────────────────

  /**
   * Submit a user turn directly to Pi, steering a running turn when permitted.
   * This is the default path for normal Discord messages.
   *
   * Mirrors dispatchPrompt's preference resolution, abort handling, and error
   * recovery so that promptAsync receives the same agent/model/variant/system
   * fields that the local-queue path provides.
   */
  /**
   * Record the current turn's speaker for this session before dispatching it,
   * so tool processes (via the plugin's shell.env hook) see who is speaking.
   * A turn without a userId clears the actor. Failures are logged, never fatal.
   *
   * With credential pools enabled this also resolves the speaker's billing
   * pool (person id, else `<platform>:<actorId>`, with the person filter's
   * `credential_pool` override) onto the attribution row, and claims session
   * ownership for the first human speaker (insert-or-ignore).
   *
   * In `speaker` billing (per-person modes only) it also detects the turn
   * where the payer first changes — the previous turn's pool differs from
   * this turn's — and posts the thread's one-time payer-change notice.
   */
  private async recordTurnAttribution({
    sessionId,
    input,
  }: {
    sessionId: string
    input: Pick<IngressInput, 'userId' | 'username' | 'actorVia' | 'personId' | 'credentialPool'>
  }): Promise<void> {
    const { credentialPoolsEnabled, credentialsMode, threadBilling } = store.getState()
    const billing = input.userId
      ? resolvePersonBillingPool({
          person: {
            personId: input.personId,
            credentialPool: input.credentialPool,
          },
          platform: this.chat.platform,
          actorId: input.userId,
        })
      : undefined
    // Speaker billing: read the previous turn's payer before this turn's
    // attribution overwrites the row. Global mode never changes payer (the
    // shared pool bills everything), and neither does owner billing.
    const speakerBilling =
      credentialPoolsEnabled &&
      credentialsMode !== 'global' &&
      threadBilling === 'speaker' &&
      billing !== undefined
    const previousAttribution = speakerBilling
      ? await getSessionTurnAttribution(sessionId).catch((e) => {
          logger.warn(`[ACTOR] Failed to read the previous turn's payer for session ${sessionId}: ${String(e)}`)
          return undefined
        })
      : undefined
    const result = await setSessionTurnAttribution({
      sessionId,
      threadId: this.thread.id,
      channelId: this.channelId,
      ...(input.userId
        ? {
            actor: {
              platform: this.chat.platform,
              id: input.userId,
              ...(input.username ? { name: input.username } : {}),
              via: input.actorVia ?? 'chat',
            },
            ...(input.personId ? { personId: input.personId } : {}),
            ...(credentialPoolsEnabled && billing ? { credentialPool: billing.poolId } : {}),
          }
        : {}),
    }).catch((e) => new Error('Failed to record session turn attribution', { cause: e }))
    if (result instanceof Error) {
      logger.warn(`[ACTOR] ${result.message} for session ${sessionId}: ${String(result.cause)}`)
    } else if (
      speakerBilling &&
      billing &&
      previousAttribution?.credentialPool &&
      previousAttribution.credentialPool !== billing.poolId
    ) {
      // Only on a successful attribution write: the notice compares the
      // previous row's pool, which this write has just replaced.
      await this.postPayerChangeNoticeOnce({
        sessionId,
        previousPoolId: previousAttribution.credentialPool,
        poolId: billing.poolId,
        username: input.username,
      })
    }
    if (credentialPoolsEnabled && billing) {
      // First human speaker owns the session; insert-or-ignore keeps later
      // speakers from moving it. Sessions with no actor stay ownerless and
      // bill to the shared pool.
      await recordCredentialOwner({
        sessionId,
        poolId: billing.poolId,
        personKey: billing.personKey,
      }).catch((e) =>
        logger.warn(`[ACTOR] Failed to record credential owner for session ${sessionId}: ${String(e)}`),
      )
    }
  }

  /**
   * The thread's one-time speaker-billing notice: when the payer first
   * changes, say that earlier messages in the thread go to the new payer's
   * provider account (its provider sees the whole earlier conversation,
   * including other people's messages). The claim is recorded in sqlite
   * (credential_payer_notices) before posting, so the notice posts at most
   * once per session — never again on later turns or after a restart.
   * Best-effort: failures are logged, never fatal.
   */
  private async postPayerChangeNoticeOnce({
    sessionId,
    previousPoolId,
    poolId,
    username,
  }: {
    sessionId: string
    previousPoolId: string
    poolId: string
    username: string
  }): Promise<void> {
    try {
      const claimed = await recordCredentialPayerNotice({
        sessionId,
        previousPoolId,
        poolId,
      }).catch((e) => {
        logger.warn(`[ACTOR] Failed to record the payer-change notice for session ${sessionId}: ${String(e)}`)
        return false
      })
      if (!claimed) return
      const notice = asSubtext(
        `Speaker billing: this thread now bills through ${username}'s credential pool (${poolId}). Earlier messages in this thread are sent to that pool's provider account.`,
      )
      const sent = await this.chat.sendNotice(notice)
      if (sent instanceof Error) {
        discordLogger.error('Failed to send the speaker-billing payer-change notice:', sent)
      }
    } catch (e) {
      logger.warn(`[ACTOR] Failed to post the payer-change notice for session ${sessionId}: ${String(e)}`)
    }
  }

  // Speaker whose permissions the session's Pi turns run under; set by the
  // last prompt that applied them.
  private permissionOwner: string | undefined

  private async submitToSession(input: IngressInput): Promise<EnqueueResult> {
    await this.supersedePendingSleep(input)
    let skippedBySessionGuard = false
    let deferPiTurn = false

    await this.dispatchAction(async () => {
      if (
        input.expectedSessionId &&
        this.state?.sessionId !== input.expectedSessionId
      ) {
        logger.log(
          `[ENQUEUE] Skipping stale promptAsync enqueue for thread ${this.threadId}: expected session ${input.expectedSessionId}, current session ${this.state?.sessionId || 'none'}`,
        )
        skippedBySessionGuard = true
        return
      }

      // Pi steering shares the running model turn, so it stays with that
      // turn's speaker. Another speaker's message waits for the turn to
      // settle, keeping each speaker's permissions (including person-MCP).
      if (
        !input.noReply && this.isBusy() &&
        (input.personId ?? input.userId) !== this.permissionOwner
      ) {
        deferPiTurn = true
        return
      }

      // Context-only messages (noReply) should not create a new session.
      // If there is no existing session, silently skip.
      if (input.noReply) {
        const existingSessionId = this.state?.sessionId || await getThreadSession(this.thread.id) || undefined
        if (!existingSessionId) {
          logger.log(
            `[INGRESS] Skipping noReply message for thread ${this.threadId}: no existing session`,
          )
          return
        }
        // A retired session (one the backend does not own) takes no context:
        // the next real prompt moves the thread, and its seed reads this
        // message from the chat.
        if (isRetiredSession(existingSessionId)) {
          logger.log(`[INGRESS] Skipping noReply message for thread ${this.threadId}: session ${existingSessionId} is retired`)
          return
        }
        if (input.contextOnly) {
          const backend = await getAgentBackendProvider().initializeForDirectory(this.sdkDirectory, { channelId: this.channelId })
          if (backend instanceof Error) {
            logger.warn(`[CONTEXT] Cannot record message: ${backend.message}`)
            return
          }
          const history = await backend().sessions.messages({ sessionId: existingSessionId, directory: this.sdkDirectory })
          if (history instanceof Error) {
            logger.warn(`[CONTEXT] Cannot resolve existing preferences: ${history.message}`)
            return
          }
          const previous = history.findLast((entry) => entry.message.role === 'user')?.message
          const context = getPromptContext({
            platform: this.chat.platform, sessionId: existingSessionId, backend: agentBackendLabel(), threadId: this.threadId,
            username: input.username, userId: input.userId, sourceMessageId: input.sourceMessageId,
            sourceThreadId: input.sourceThreadId, threadName: this.chat.name || undefined,
            repliedMessage: input.repliedMessage,
          })
          const parts: AgentPromptPart[] = [
            { kind: 'text', text: input.prompt }, { kind: 'text', text: context, synthetic: true },
            ...(input.images ?? []).map((file): AgentPromptPart => ({ kind: 'file', mime: file.mime, url: file.url, filename: file.filename })),
          ]
          const recorded = await backend().sessions.prompt({
            sessionId: existingSessionId, directory: this.sdkDirectory, parts, noReply: true,
            agent: previous?.agent, model: previous?.model, system: previous?.system,
          })
          if (recorded instanceof Error) logger.warn(`[CONTEXT] Cannot record message: ${recorded.message}`)
          return
        }
      }

      // Helper: stop typing and drain queued local messages on error.
      const cleanupOnError = async (errorMessage: string) => {
        this.typing.stopTyping()
        await this.chat.sendMessage(errorMessage, { notify: true })
        await this.messageQueue.tryDrainQueue({ showIndicator: true })
      }

      // ── Ensure session ──────────────────────────────────────
      const sessionResult = await this.ensureSession({
        prompt: input.prompt,
        agent: input.agent,
        permissions: input.permissions,
        injectionGuardPatterns: input.injectionGuardPatterns,
        sourceMessageId: input.sourceMessageId,
        sessionStartScheduleKind: input.sessionStartSource?.scheduleKind,
        sessionStartScheduledTaskId: input.sessionStartSource?.scheduledTaskId,
      })
      if (sessionResult instanceof Error) {
        await cleanupOnError(`✗ ${sessionResult.message}`)
        return
      }

      const { session, getClient, createdNewSession } = sessionResult
      schedulePendingSessionTitle({ session, prompt: sessionTitlePrompt(input), backend: getClient(), directory: this.sdkDirectory })

      await registerSpeakerMcpServers(getClient(), this.chat.platform, this.sdkDirectory, input)
      const updatePermissionsResult = await this.updateExistingSessionPermissions({
        client: getClient(),
        sessionId: session.id,
        permissions: input.permissions,
        noReply: input.noReply,
        owner: input.personId ?? input.userId,
      })
      if (updatePermissionsResult instanceof Error) {
        await cleanupOnError(`Failed to update session permissions: ${updatePermissionsResult.message}`)
        return
      }

      // ── Resolve model + agent preferences (mirrors dispatchPrompt) ──
      const channelId = this.channelId
      const resolvedAppId = input.appId

      // Explicit agent prompts (for example /plan-agent <prompt>) must update
      // the session preference before dispatch. Otherwise the model can resolve
      // from the requested agent while Pi keeps running the old agent.
      if (input.agent) {
        await setSessionAgent(session.id, input.agent)
        await clearSessionModel(session.id)
      }

      if (input.model) {
        const validatedModel = await validateModelId({
          model: input.model,
          getClient,
          directory: this.sdkDirectory,
        })
        if (validatedModel instanceof Error) {
          await cleanupOnError(`Failed to resolve model: ${validatedModel.message}`)
          return
        }
      }

      await ensureSessionPreferencesSnapshot({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
        getClient,
        directory: this.sdkDirectory,
        agentOverride: input.agent,
        modelOverride: input.model,
        force: createdNewSession,
      })

      const agentResult = await resolveValidatedAgentPreference({
        agent: input.agent,
        sessionId: session.id,
        channelId,
        getClient,
        directory: this.sdkDirectory,
      }).catch((e) => new AgentBackendError({ operation: 'resolveAgent', cause: e }))
      if (agentResult instanceof Error) {
        await cleanupOnError(`Failed to resolve agent: ${agentResult.message}`)
        return
      }
      const resolvedAgent = agentResult.agentPreference
      const availableAgents = agentResult.agents
      releaseCurrentThreadIngress()

      await this.persistIngressVariant({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
        agentPreference: resolvedAgent,
        getClient,
        variant: input.variant,
      })

      const [modelResult, preferredVariant] = await Promise.all([
        (async () => {
          if (input.model) {
            return validateModelId({
              model: input.model,
              getClient,
              directory: this.sdkDirectory,
            })
          }
          const modelInfo = await getCurrentModelInfo({
            sessionId: session.id,
            channelId,
            appId: resolvedAppId,
            agentPreference: resolvedAgent,
            getClient,
            directory: this.sdkDirectory,
          })
          if (modelInfo.type === 'none') {
            return undefined
          }
          return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
        })().catch((e) => new AgentBackendError({ operation: 'resolveModelPreference', cause: e })),
        getVariantCascade({
          sessionId: session.id,
          channelId,
          appId: resolvedAppId,
        }),
      ])
      if (modelResult instanceof Error) {
        await cleanupOnError(`Failed to resolve model: ${modelResult.message}`)
        return
      }
      const modelField = modelResult
      if (!modelField) {
        await cleanupOnError(
          'No model account available. Add an account to the credential pool with `/credentials add`.',
        )
        return
      }

      // Resolve thinking variant
      const thinkingValue = await (async (): Promise<string | undefined> => {
        if (!preferredVariant) {
          return undefined
        }
        const catalog = await getClient().catalog.providers({ directory: this.sdkDirectory })
        if (catalog instanceof Error) {
          return undefined
        }
        const availableValues = getThinkingValuesForModel({
          providers: catalog.providers,
          providerId: modelField.providerID,
          modelId: modelField.modelID,
        })
        if (availableValues.length === 0) {
          return undefined
        }
        return matchThinkingValue({
          requestedValue: preferredVariant,
          availableValues,
        }) || undefined
      })()

      const variantField = thinkingValue
        ? { variant: thinkingValue }
        : {}

      await this.sendNewSessionModelInfo({
        createdNewSession,
        model: modelField,
        agent: resolvedAgent,
      })

      // ── Build prompt parts ──────────────────────────────────
      const images = input.images || []
      const promptWithImagePaths = (() => {
        if (images.length === 0) {
          return input.prompt
        }
        const imageList = images
          .map((img) => {
            return `- ${img.sourceUrl || img.filename}`
          })
          .join('\n')
        return `${input.prompt}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${imageList}`
      })()

      // ── Working directory + channel topic for per-turn prompt context ──
      const workingDirectory = applicationDirectory() ? undefined : await getThreadWorkingDirectory(this.thread.id)

      const channelTopic = await this.chat.channelTopic(channelId)
      const system = await this.resolveTurnSystemPrompt({
        sessionId: session.id,
        channelTopic,
        agents: availableAgents,
        input,
      })
      if (system instanceof Error) {
        await cleanupOnError(`✗ Failed to prepare system prompt: ${system.message}`)
        return
      }
      const workingDirectoryChanged = this.consumeWorkingDirectoryPromptChange(workingDirectory)
      const syntheticContext = getPromptContext({
        platform: this.chat.platform,
        sessionId: session.id,
        backend: agentBackendLabel(),
        threadId: this.thread.id,
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: input.sourceThreadId || this.thread.id,
        threadName: this.chat.name || undefined,
        repliedMessage: input.repliedMessage,
        workingDirectory,
        currentAgent: resolvedAgent,
        workingDirectoryChanged,
        systemPromptFromSourceSession: systemPromptNamesOtherSession({ system, sessionId: session.id }),
        forkOrigin: await getSessionForkOrigin(session.id),
        parentSessionId: this.getParentSessionIdMissingFromSystem({ system, input }),
      })
      const turnContext = await this.resolveTurnContext({
        sessionId: session.id,
        input,
        isFirstTurn: createdNewSession,
      })
      const parts: AgentPromptPart[] = [
        { kind: 'text', text: promptWithImagePaths },
        { kind: 'text', text: syntheticContext, synthetic: true },
        ...(turnContext ? [{ kind: 'text' as const, text: turnContext, synthetic: true }] : []),
        ...images.map(toPromptFilePart),
      ]

      await this.recordTurnAttribution({ sessionId: session.id, input })
      await waitForGlobalEventListener()
      // Disposed while preparing (thread deleted, backend restarting or
      // shutting down): the backend may no longer own this session, so the
      // prompt must not be sent anywhere.
      if (this.disposed) {
        logger.log(`[DISPATCH] Runtime disposed before prompt was sent sessionId=${session.id}`)
        return
      }
      // A busy session takes this prompt at its next step boundary; the
      // running step is never aborted. Only /abort stops a run.
      // Marked before sending so a fast pickup event can't arrive first.
      const pendingMessageId = this.isBusy() && !input.noReply ? input.sourceMessageId : undefined
      if (pendingMessageId) {
        this.markPendingDelivery(pendingMessageId)
      } else if (!input.noReply && input.sourceMessageId && input.sourceChannelId === this.threadId) {
        // A new turn: its first reply answers the message that started it.
        // Only inline channel conversations implement anchoring.
        this.chat.setReplyAnchor?.(input.sourceMessageId)
      }
      const promptResult = await getClient().sessions.prompt({
        sessionId: session.id,
        directory: this.sdkDirectory,
        parts,
        system,
        ...(resolvedAgent ? { agent: resolvedAgent } : {}),
        ...(modelField ? { model: { providerId: modelField.providerID, modelId: modelField.modelID } } : {}),
        ...(variantField.variant ? { variant: variantField.variant } : {}),
        ...(input.noReply ? { noReply: true } : {}),
      })
      if (promptResult instanceof Error) {
        if (pendingMessageId) {
          this.pendingDeliveryMessageIds = this.pendingDeliveryMessageIds.filter((id) => id !== pendingMessageId)
          void this.setPendingReaction(pendingMessageId, false)
        }
        void notifyError(promptResult, 'promptAsync failed in submitToSession')
        await cleanupOnError(`✗ Agent error: ${promptResult.message}`)
        return
      }

      if (input.sessionStartSource?.scheduledTaskRunId) {
        await startScheduledTaskRunSession({
          runId: input.sessionStartSource.scheduledTaskRunId,
          sessionId: session.id,
          projectDirectory: this.sdkDirectory,
        })
      }

      logger.log(
        `[INGRESS] promptAsync accepted by ${getAgentBackendProvider().id} queue sessionId=${session.id} threadId=${this.threadId}`,
      )

      // noReply messages don't trigger the agent loop, so don't mark as busy
      if (!input.noReply) {
        this.markQueueDispatchBusy(session.id)
      }
    })

    if (deferPiTurn) return this.enqueueViaLocalQueue(input)
    if (skippedBySessionGuard) {
      return { queued: false }
    }
    return { queued: false }
  }

  /**
   * A new turn supersedes a pending sleep.
   *
   * Called from the two terminal routers rather than from the top of
   * enqueueIncoming: arrival order is only fixed once a message reaches the
   * preprocessChain link, so awaiting anything before that lets two rapid
   * messages swap places. By here the order is already committed.
   *
   * Awaited rather than fire-and-forget so it cannot race the task runner and
   * let a stale wake land after the user took the conversation back.
   */
  private async supersedePendingSleep(input: IngressInput): Promise<void> {
    if (input.isSleepWake || input.contextOnly) return
    await cancelSessionSleepForThread({ threadId: this.threadId }).catch(
      (error) => {
        logger.error('[SLEEP] failed to cancel pending sleep:', error)
      },
    )
  }

  private async enqueueViaLocalQueue(input: IngressInput): Promise<EnqueueResult> {
    await this.supersedePendingSleep(input)
    return this.messageQueue.enqueueViaLocalQueue(input)
  }

  /**
   * Ingress API for Discord handlers and commands.
   * Defaults to direct session submission; local queue mode is explicit.
   *
   * When input.preprocess is set, the preprocessor runs inside dispatchAction
   * (serialized) to resolve prompt/images/mode before routing. This replaces
   * the threadIngressQueue that previously serialized pre-enqueue work in
   * discord-bot.ts.
   */
  async enqueueIncoming(input: IngressInput): Promise<EnqueueResult> {
    await waitForCurrentThreadIngress()
    if (input.contextOnly) input = { ...input, noReply: true }
    input = applyPersonToIngress({ ...input, actorPlatform: this.chat.platform })
    input = applyChannelPolicyToIngress({ input: { ...input, actorPlatform: this.chat.platform }, channelId: this.channelId || this.chat.parentId || this.threadId })
    if (!input.contextOnly) threadState.setSessionUsername(this.threadId, input.username)
    const botUserId = this.chat.botUserId
    if (!input.contextOnly && input.userId && input.userId !== botUserId) {
      threadState.setSessionUserId(this.threadId, input.userId)
    }
    await this.ensureParentSessionId({
      parentSessionId: input.parentSessionId,
    })

    // When a preprocessor is provided, we must resolve it inside
    // dispatchAction before we know the final mode for routing.
    if (input.preprocess) {
      return this.enqueueWithPreprocess(input)
    }
    // If the prompt starts with `/cmdname ...` (and no explicit command is
    // already set), rewrite it into a command invocation so it goes through
    // the session command API instead of being sent to the model as
    // plain text. Covers Discord chat messages, /new-session, CLI
    // `roadie send --prompt`, and scheduled tasks — all funnel through here.
    if (!input.contextOnly) input = maybeConvertLeadingCommand(input)
    if (input.mode === 'local-queue') {
      return this.enqueueViaLocalQueue(input)
    }
    if (input.command) {
      // Commands wait in the local queue until the current run finishes.
      return this.enqueueViaLocalQueue(input)
    }
    return this.submitToSession(input)
  }

  /**
   * Resolve parent session ID for child system prompts.
   * Prefer in-memory state, then SQLite, then the ingress marker.
   * Persist once so multi-turn child sessions keep the parent after restart.
   */
  private async ensureParentSessionId({
    parentSessionId,
  }: {
    parentSessionId?: string
  }) {
    if (this.state?.parentSessionId) {
      return
    }

    const storedParentSessionId = await getThreadParentSessionId(this.threadId)
    if (storedParentSessionId) {
      threadState.setParentSessionId(this.threadId, storedParentSessionId)
      return
    }

    if (!parentSessionId) {
      return
    }

    threadState.setParentSessionId(this.threadId, parentSessionId)
    // Row may not exist yet on first ingress before ensureSession creates it.
    // Best-effort write; ensureSession path also persists after setThreadSession.
    await setThreadParentSessionId({
      threadId: this.threadId,
      parentSessionId,
    }).catch((error) => {
      logger.warn(
        `[PARENT SESSION] Failed to persist parent session for thread ${this.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /**
   * Serialize the preprocess callback via a lightweight promise chain, then
   * route the resolved input through the normal enqueue paths.
   *
   * The preprocess chain is separate from dispatchAction so heavy work
   * (context fetch, attachment download) doesn't
   * block SSE event handling, permission UI, or queue drain. Only the
   * preprocessing order is serialized here — the enqueue itself goes
   * through dispatchAction as usual.
   */
  private async enqueueWithPreprocess(input: IngressInput): Promise<EnqueueResult> {
    // Deferred result: the chain link resolves/rejects this promise.
    let resolveOuter!: (value: EnqueueResult | PromiseLike<EnqueueResult>) => void
    let rejectOuter!: (reason: unknown) => void
    const resultPromise = new Promise<EnqueueResult>((resolve, reject) => {
      resolveOuter = resolve
      rejectOuter = reject
    })

    // Chain preprocess + enqueue calls so they run in arrival order but
    // outside dispatchAction. The chain awaits the full enqueue (including
    // ensureSession / setThreadSession) before releasing to the next
    // message, so session-creation races on fresh threads are avoided.
    // The chain itself never rejects (catch + resolve via rejectOuter)
    // so the next link always runs.
    this.preprocessChain = this.preprocessChain.then(async () => {
      try {
        const result = await input.preprocess!()
        if (result.skip) {
          resolveOuter({ queued: false })
          return
        }
        const resolvedInput: IngressInput = maybeConvertLeadingCommand({
          ...input,
          prompt: result.prompt,
          images: result.images,
          mode: result.mode,
          // Preprocessing may request an agent — apply it only if no
          // explicit agent was already set (CLI --agent flag wins).
          agent: input.agent || result.agent,
          repliedMessage: result.repliedMessage,
          preprocess: undefined,
        })

        const hasPromptText = resolvedInput.prompt.trim().length > 0
        const hasImages = (resolvedInput.images?.length || 0) > 0
        if (!hasPromptText && !hasImages && !resolvedInput.command) {
          logger.warn(
            `[INGRESS] Skipping empty preprocessed input threadId=${this.threadId}`,
          )
          resolveOuter({ queued: false })
          return
        }

        // Route with the resolved mode through normal paths.
        // Await the enqueue so session state (ensureSession, setThreadSession)
        // is persisted before the next message's preprocessing reads it.
        // noReply messages always go through direct submission so the flag
        // reaches promptAsync; local queue doesn't support noReply.
        const enqueueResult = resolvedInput.noReply
          ? await this.submitToSession({
              ...resolvedInput,
              mode: 'direct',
              command: undefined,
            })
          : (resolvedInput.mode === 'local-queue' || resolvedInput.command)
            ? await this.enqueueViaLocalQueue(resolvedInput)
            : await this.submitToSession(resolvedInput)
        resolveOuter(enqueueResult)
      } catch (err) {
        rejectOuter(err)
      }
    })

    return resultPromise
  }

  /**
   * Abort the currently active run. Does NOT kill the listener.
   * Calls session.abort best-effort and lets event-stream idle settle the run.
   */
  private async abortSessionViaApi({
    abortId,
    reason,
    sessionId,
  }: {
    abortId: string
    reason: string
    sessionId: string
  }): Promise<void> {
    const client = getAgentBackendProvider().getBackend(this.sdkDirectory)
    if (!client) {
      logger.log(
        `[ABORT API] id=${abortId} reason=${reason} sessionId=${sessionId} skipped=no-client`,
      )
      return
    }

    const startedAt = Date.now()
    logger.log(
      `[ABORT API] id=${abortId} reason=${reason} sessionId=${sessionId} start`,
    )
    const abortResult = await client.sessions.abort({
      sessionId,
      directory: this.sdkDirectory,
    })
    if (!(abortResult instanceof Error)) {
      logger.log(
        `[ABORT API] id=${abortId} reason=${reason} sessionId=${sessionId} success durationMs=${Date.now() - startedAt}`,
      )
      return
    }
    logger.log(
      `[ABORT API] id=${abortId} reason=${reason} sessionId=${sessionId} failed durationMs=${Date.now() - startedAt} message=${abortResult.message}`,
    )
  }

  private abortActiveRunInternal({
    reason,
  }: {
    reason: string
  }): AbortRunOutcome {
    const abortId = this.nextAbortId(reason)
    const state = this.state
    if (!state) {
      logger.log(
        `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} skipped=no-state`,
      )
      return {
        abortId,
        reason,
        apiAbortPromise: undefined,
      }
    }

    const sessionId = state.sessionId
    const sessionIsBusy = this.isBusy()
    this.restartContinuation = undefined
    this.roadieAbortPending = true

    logger.log(
      `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} sessionId=${sessionId || 'none'} queueLength=${state.queueItems.length} ${this.formatRunStateForLog()} sessionBusy=${sessionIsBusy}`,
    )

    this.typing.stopTyping()
    this.interactiveUi.clearDeferredQuestionShow()

    // The aborted run owns the question request, so the dropdown dies with it.
    // Questions have no TTL, so this is the only thing that clears them here.
    void this.chat.interactions.cancelQuestion()

    const apiAbortPromise = sessionId
      ? this.abortSessionViaApi({ abortId, reason, sessionId })
      : undefined

    logger.log(
      `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} apiAbort=${Boolean(sessionId)} ${this.formatRunStateForLog()}`,
    )

    return {
      abortId,
      reason,
      apiAbortPromise,
    }
  }

  /** Explicit user abort: stops the run and drops all queued messages. Returns the removed items. */
  async abortActiveRun(reason: string): Promise<threadState.QueuedMessage[]> {
    const outcome = this.abortActiveRunInternal({
      reason,
    })
    if (outcome.apiAbortPromise) {
      void outcome.apiAbortPromise
    }
    // Enqueued synchronously, so it runs before the abort's session.idle can drain the queue.
    let cleared: threadState.QueuedMessage[] = []
    await this.dispatchAction(async () => {
      cleared = await this.messageQueue.clearQueueNow()
    })
    return cleared
  }

  async abortActiveRunAndWait({
    reason,
    timeoutMs = 2_000,
  }: {
    reason: string
    timeoutMs?: number
  }): Promise<void> {
    const state = this.state
    const sessionId = state?.sessionId
    if (!sessionId) {
      return
    }

    let needsIdleWait = false
    const waitSinceTimestamp = Date.now()
    const abortResult = await this.dispatchAction(async () => {
      needsIdleWait = this.isBusy()
      const outcome = this.abortActiveRunInternal({ reason })
      if (outcome.apiAbortPromise) {
        void outcome.apiAbortPromise
      }
    }).catch((e) => new AgentBackendError({ operation: 'abortSession', cause: e }))
    if (abortResult instanceof Error) {
      logger.error(`[ABORT WAIT] Failed to abort active run: ${abortResult.message}`)
      return
    }
    if (!needsIdleWait) {
      return
    }
    await this.waitForEvent({
      predicate: (event) => {
        return event.type === 'idle' && event.sessionId === sessionId
      },
      sinceTimestamp: waitSinceTimestamp,
      timeoutMs,
    })
  }

  /** Number of messages waiting in the queue. */
  getQueueLength(): number {
    return this.messageQueue.getQueueLength()
  }

  /** Clear all queued messages. Returns the removed items. */
  async clearQueue(): Promise<threadState.QueuedMessage[]> {
    return this.messageQueue.clearQueue()
  }

  /** Remove a queued message by its 1-based position. */
  async removeQueuePosition(position: number): Promise<threadState.QueuedMessage | undefined> {
    return this.messageQueue.removeQueuePosition(position)
  }

  /** Remove a queued message by stable queue id. */
  async removeQueueItemById(queueId: string): Promise<threadState.QueuedMessage | undefined> {
    return this.messageQueue.removeQueueItemById(queueId)
  }

  /**
   * Update a queued message identified by its Discord source message ID.
   * If newPrompt is empty, the item is removed from the queue.
   * Returns { found: true, removed } if the item was in the queue,
   * or { found: false } if it was already dispatched or never queued.
   */
  async updateQueuedMessage(input: {
    sourceMessageId: string
    newPrompt: string
  }): Promise<{ found: boolean; removed: boolean }> {
    return this.messageQueue.updateQueuedMessage(input)
  }

  /** Remove a queued message identified by its Discord source message ID. */
  async removeQueuedMessage(
    sourceMessageId: string,
  ): Promise<threadState.QueuedMessage | undefined> {
    return this.messageQueue.removeQueuedMessage(sourceMessageId)
  }

  async mergeRestoredQueueAndDrain(items: QueuedMessage[]): Promise<void> {
    const current = this.state?.queueItems ?? []
    const currentIds = new Set(current.flatMap((item) => item.queueId ? [item.queueId] : []))
    threadState.replaceQueueItems(this.threadId, [
      ...items.filter((item) => item.queueId && !currentIds.has(item.queueId)),
      ...current,
    ])
    const liveStatus = await this.hydrateLiveSessionStatus()
    if (liveStatus === 'unavailable') {
      return
    }
    await this.messageQueue.tryDrainQueue({ showIndicator: true })
  }

  private async hydrateLiveSessionStatus(): Promise<'idle' | 'busy' | 'unavailable'> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return 'idle'
    }
    await this.hydrateSessionEventsFromDatabase({ sessionId })
    const getClient = await getAgentBackendProvider().initializeForDirectory(this.sdkDirectory, { channelId: this.channelId })
    if (getClient instanceof Error) {
      logger.warn(
        `[QUEUE] Pi unavailable while restoring queue for ${this.threadId}: ${getClient.message}`,
      )
      return 'unavailable'
    }
    const statuses = await getClient().sessions.status({
      directory: this.sdkDirectory,
    })
    if (statuses instanceof Error) {
      logger.warn(
        `[QUEUE] Failed to read session status while restoring queue for ${this.threadId}: ${statuses.message}`,
      )
      return 'unavailable'
    }
    const sessionStatus = statuses[sessionId]
    if (!sessionStatus || sessionStatus.state === 'idle') {
      this.markQueueDispatchIdle(sessionId)
      return 'idle'
    }
    this.markQueueDispatchBusy(sessionId)
    return 'busy'
  }

  // ── Prompt Dispatch ─────────────────────────────────────────
  // Resolve session, build system message, submit to Pi.
  // The listener is already running, so this only handles
  // session ensure + model/agent + SDK call + state.

  private async dispatchPrompt(input: QueuedMessage): Promise<boolean> {
    this.lastDisplayedContextPercentage = 0
    this.lastRateLimitDisplayTime = 0
    this.lastSentPartKind = undefined

    // ── Ensure session ────────────────────────────────────────
    const sessionResult = await this.ensureSession({
      prompt: input.prompt,
      agent: input.agent,
      permissions: input.permissions,
      injectionGuardPatterns: input.injectionGuardPatterns,
      sourceMessageId: input.sourceMessageId,
      sessionStartScheduleKind: input.sessionStartScheduleKind,
      sessionStartScheduledTaskId: input.sessionStartScheduledTaskId,
    })
    if (sessionResult instanceof Error) {
      this.typing.stopTyping()
      await this.chat.sendMessage(`✗ ${sessionResult.message}`, { notify: true })
      // Show indicator: this dispatch failed, so the next queued message
      // has been waiting — the user needs to see which one is starting.
      return false
    }
    const { session, getClient, createdNewSession } = sessionResult
    schedulePendingSessionTitle({ session, prompt: sessionTitlePrompt(input), backend: getClient(), directory: this.sdkDirectory })

    await registerSpeakerMcpServers(getClient(), this.chat.platform, this.sdkDirectory, input)
    const updatePermissionsResult = await this.updateExistingSessionPermissions({
      client: getClient(),
      sessionId: session.id,
      permissions: input.permissions,
      owner: input.personId ?? input.userId,
    })
    if (updatePermissionsResult instanceof Error) {
      this.typing.stopTyping()
      await this.chat.sendMessage(`Failed to update session permissions: ${updatePermissionsResult.message}`, { notify: true })
      return false
    }

    // ── Resolve model + agent preferences ─────────────────────
    const channelId = this.channelId
    const resolvedAppId = input.appId

    // Explicit agent prompts (for example /plan-agent <prompt>) must update
    // the session preference before dispatch. Otherwise the model can resolve
    // from the requested agent while Pi keeps running the old agent.
    if (input.agent) {
      await setSessionAgent(session.id, input.agent)
      await clearSessionModel(session.id)
    }

    if (input.model) {
      const validatedModel = await validateModelId({
        model: input.model,
        getClient,
        directory: this.sdkDirectory,
      })
      if (validatedModel instanceof Error) {
        this.typing.stopTyping()
        await this.chat.sendMessage(`Failed to resolve model: ${validatedModel.message}`, { notify: true })
        return false
      }
    }

    await ensureSessionPreferencesSnapshot({
      sessionId: session.id,
      channelId,
      appId: resolvedAppId,
      getClient,
      directory: this.sdkDirectory,
      agentOverride: input.agent,
      modelOverride: input.model,
      force: createdNewSession,
    })

    const earlyAgentResult = await resolveValidatedAgentPreference({
      agent: input.agent,
      sessionId: session.id,
      channelId,
      getClient,
      directory: this.sdkDirectory,
    }).catch((e) => new AgentBackendError({ operation: 'resolveAgent', cause: e }))
    if (earlyAgentResult instanceof Error) {
      this.typing.stopTyping()
      await this.chat.sendMessage(`Failed to resolve agent: ${earlyAgentResult.message}`, { notify: true })
      return false
    }
    const earlyAgentPreference = earlyAgentResult.agentPreference
    const earlyAvailableAgents = earlyAgentResult.agents

    await this.persistIngressVariant({
      sessionId: session.id,
      channelId,
      appId: resolvedAppId,
      agentPreference: earlyAgentPreference,
      getClient,
      variant: input.variant,
    })

    const [earlyModelResult, preferredVariant] = await Promise.all([
      (async () => {
        if (input.model) {
          return validateModelId({
            model: input.model,
            getClient,
            directory: this.sdkDirectory,
          })
        }
        const modelInfo = await getCurrentModelInfo({
          sessionId: session.id,
          channelId,
          appId: resolvedAppId,
          agentPreference: earlyAgentPreference,
          getClient,
          directory: this.sdkDirectory,
        })
        if (modelInfo.type === 'none') {
          return undefined
        }
        return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
      })().catch((e) => new AgentBackendError({ operation: 'resolveModelPreference', cause: e })),
      getVariantCascade({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
      }),
    ])
    if (earlyModelResult instanceof Error) {
      this.typing.stopTyping()
      await this.chat.sendMessage(`Failed to resolve model: ${earlyModelResult.message}`, { notify: true })
      return false
    }
    const earlyModelParam = earlyModelResult
    if (!earlyModelParam) {
      this.typing.stopTyping()
      await this.chat.sendMessage('No model account available. Add an account to the credential pool with `/credentials add`.')
      return false
    }

    // Resolve thinking variant
    const earlyThinkingValue = await (async (): Promise<string | undefined> => {
      if (!preferredVariant) {
        return undefined
      }
      const catalog = await getClient().catalog.providers({ directory: this.sdkDirectory })
      if (catalog instanceof Error) {
        return undefined
      }
      const availableValues = getThinkingValuesForModel({
        providers: catalog.providers,
        providerId: earlyModelParam.providerID,
        modelId: earlyModelParam.modelID,
      })
      if (availableValues.length === 0) {
        return undefined
      }
      return matchThinkingValue({
        requestedValue: preferredVariant,
        availableValues,
      }) || undefined
    })()

    await this.ensureModelContextLimit({
      providerID: earlyModelParam.providerID,
      modelID: earlyModelParam.modelID,
    })

    await this.sendNewSessionModelInfo({
      createdNewSession,
      model: earlyModelParam,
      agent: earlyAgentPreference,
    })

    // ── Build prompt parts ────────────────────────────────────
    const images = input.images || []
    const promptWithImagePaths = (() => {
      if (images.length === 0) {
        return input.prompt
      }
      const imageList = images
        .map((img) => {
          return `- ${img.sourceUrl || img.filename}`
        })
        .join('\n')
      return `${input.prompt}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${imageList}`
    })()

    // ── Working directory for per-turn prompt context ─────────
    const workingDirectory = applicationDirectory() ? undefined : await getThreadWorkingDirectory(this.thread.id)

    const channelTopic = await this.chat.channelTopic(channelId)
    // Pinned before building parts so the fork notice can compare identities.
    // Also covers session.command: the context-awareness plugin reads the same
    // pinned file because the command API has no system field.
    const system = await this.resolveTurnSystemPrompt({
      sessionId: session.id,
      channelTopic,
      agents: earlyAvailableAgents,
      input,
    })
    if (system instanceof Error) {
      logger.error(
        `[DISPATCH] Failed to pin system prompt for session ${session.id}: ${system.message}`,
      )
      void notifyError(system, 'Failed to pin session system prompt')
      this.typing.stopTyping()
      await this.chat.sendMessage(`✗ Failed to prepare system prompt: ${system.message}`, { notify: true })
      return false
    }
    const systemPromptFromSourceSession = systemPromptNamesOtherSession({ system, sessionId: session.id })
    const forkOrigin = await getSessionForkOrigin(session.id)
    const workingDirectoryChanged = this.consumeWorkingDirectoryPromptChange(workingDirectory)
    const syntheticContext = getPromptContext({
      platform: this.chat.platform,
      sessionId: session.id,
      backend: agentBackendLabel(),
      threadId: this.thread.id,
      username: input.username,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      sourceThreadId: input.sourceThreadId || this.thread.id,
      threadName: this.chat.name || undefined,
      repliedMessage: input.repliedMessage,
      workingDirectory,
      currentAgent: earlyAgentPreference,
      workingDirectoryChanged,
      systemPromptFromSourceSession,
      forkOrigin,
      parentSessionId: this.getParentSessionIdMissingFromSystem({ system, input }),
    })
    const turnContext = await this.resolveTurnContext({
      sessionId: session.id,
      input,
      isFirstTurn: createdNewSession,
    })
    const parts: AgentPromptPart[] = [
      { kind: 'text', text: promptWithImagePaths },
      { kind: 'text', text: syntheticContext, synthetic: true },
      ...(turnContext ? [{ kind: 'text' as const, text: turnContext, synthetic: true }] : []),
      ...images.map(toPromptFilePart),
    ]

    const variantField = earlyThinkingValue
      ? { variant: earlyThinkingValue }
      : {}

    if (input.command) {
      const queuedCommand = input.command
      const commandSignal = AbortSignal.timeout(30_000)
      // session.command() only accepts FilePart in parts, not text parts.
      // Append the <discord-user /> tag to the arguments, same as promptAsync,
      // so the model sees who sent the command.
      const discordTag = getPromptContext({
        platform: this.chat.platform,
        sessionId: session.id,
        backend: agentBackendLabel(),
        threadId: this.thread.id,
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: input.sourceThreadId || this.thread.id,
        threadName: this.chat.name || undefined,
        repliedMessage: input.repliedMessage,
        systemPromptFromSourceSession,
        forkOrigin,
        parentSessionId: this.getParentSessionIdMissingFromSystem({ system, input }),
      })
      await this.recordTurnAttribution({ sessionId: session.id, input })
      if (this.disposed) {
        logger.log(`[DISPATCH] Runtime disposed before command was sent sessionId=${session.id}`)
        return false
      }
      const commandResponse = await getClient().sessions.command(
        {
          sessionId: session.id,
          directory: this.sdkDirectory,
          command: queuedCommand.name,
          arguments: queuedCommand.arguments + (discordTag ? `\n${discordTag}` : ''),
          system,
          agent: earlyAgentPreference,
          model: { providerId: earlyModelParam.providerID, modelId: earlyModelParam.modelID },
          ...(variantField.variant ? { variant: variantField.variant } : {}),
        },
        { signal: commandSignal },
      )

      if (commandResponse instanceof AgentRequestError) {
        const errorMessage = commandResponse.message
        if (errorMessage.includes('aborted')) {
          logger.log(
            `[DISPATCH] Command aborted (expected) sessionId=${session.id}`,
          )
          this.typing.stopTyping()
          return true
        }
        const apiError = new Error(`Agent error: ${errorMessage}`)
        logger.error(`[DISPATCH] ${apiError.message}`)
        void notifyError(apiError, 'Agent error during command')
        this.typing.stopTyping()
        await this.chat.sendMessage(`✗ ${apiError.message}`, { notify: true })
        return false
      }

      if (commandResponse instanceof Error) {
        const timeoutReason = commandSignal.reason
        const timedOut =
          commandSignal.aborted &&
          timeoutReason instanceof Error &&
          timeoutReason.name === 'TimeoutError'
        if (timedOut) {
          logger.warn(
            `[DISPATCH] Command timed out after 30s sessionId=${session.id}`,
          )
          this.typing.stopTyping()
          await this.chat.sendMessage('✗ Command timed out after 30 seconds. Try a shorter command or run it with /run-shell-command.', { notify: true })
          return false
        }

        const commandErrorForAbortCheck: unknown = commandResponse
        if (isAbortError(commandErrorForAbortCheck)) {
          logger.log(
            `[DISPATCH] Command aborted (expected) sessionId=${session.id}`,
          )
          this.typing.stopTyping()
          return true
        }

        logger.error(
          `[DISPATCH] Command SDK call failed: ${commandResponse.message}`,
        )
        void notifyError(commandResponse, 'Failed to send command to the agent')
        this.typing.stopTyping()
        await this.chat.sendMessage(`✗ Unexpected bot Error: ${commandResponse.message}`, { notify: true })
        return false
      }

      logger.log(`[DISPATCH] Successfully ran command for session ${session.id}`)
      return true
    }

    await this.recordTurnAttribution({ sessionId: session.id, input })
    await waitForGlobalEventListener()
    if (this.disposed) {
      logger.log(`[DISPATCH] Runtime disposed before prompt was sent sessionId=${session.id}`)
      return false
    }
    const promptResponse = await getClient().sessions.prompt({
      sessionId: session.id,
      directory: this.sdkDirectory,
      parts,
      system,
      model: { providerId: earlyModelParam.providerID, modelId: earlyModelParam.modelID },
      agent: earlyAgentPreference,
      ...(variantField.variant ? { variant: variantField.variant } : {}),
    })

    if (promptResponse instanceof Error) {
      const errorMessage = promptResponse.message
      const errorObject = promptResponse
      logger.error(`[DISPATCH] Prompt API call failed: ${errorMessage}`)
      void notifyError(errorObject, 'Agent error during local queue prompt')
      this.typing.stopTyping()
      await this.chat.sendMessage(`✗ Agent error: ${errorMessage}`, { notify: true })
      return false
    }

    logger.log(
      `[DISPATCH] promptAsync accepted by ${getAgentBackendProvider().id} queue sessionId=${session.id} threadId=${this.threadId}`,
    )
    return true
  }

  // ── Session Ensure ──────────────────────────────────────────
  // Creates or reuses the agent session for this thread.

  /** Cached per-session scheduled task info for the system message. */
  private scheduledTaskContextCache = new Map<
    string,
    ScheduledTaskSystemContext | undefined
  >()

  // Speaker key of the last turn we fetched per-turn host context for.
  private lastContextSpeakerKey: string | undefined

  private resolveTurnContext(args: {
    sessionId: string
    input: { userId?: string; username?: string; personId?: string; actorVia?: 'chat' | 'cli'; contextOnly?: boolean }
    isFirstTurn: boolean
  }): Promise<string> {
    return resolveTurnContext({
      ...args,
      chat: this.chat,
      threadId: this.thread.id,
      runtimeThreadId: this.threadId,
      channelId: this.channelId,
      directory: this.sdkDirectory,
      lastSpeakerKey: this.lastContextSpeakerKey,
      setLastSpeakerKey: (key) => {
        this.lastContextSpeakerKey = key
      },
    })
  }

  private resolveTurnSystemPrompt(args: {
    sessionId: string
    channelTopic: string | undefined
    agents: AgentInfo[]
    input: { username?: string; userId?: string; parentSessionId?: string }
  }) {
    return resolveTurnSystemPrompt({
      ...args,
      chat: this.chat,
      threadId: this.thread.id,
      runtimeThreadId: this.threadId,
      channelId: this.channelId,
      directory: this.sdkDirectory,
      getState: () => this.state,
      scheduledTaskContextCache: this.scheduledTaskContextCache,
    })
  }

  /** Parent set after the first turn is not in the pinned prompt; send it per turn. */
  private getParentSessionIdMissingFromSystem({
    system,
    input,
  }: {
    system: string
    input: { parentSessionId?: string }
  }) {
    const parentSessionId = this.state?.parentSessionId || input.parentSessionId
    if (!parentSessionId) return undefined
    if (systemPromptHasParentSession({ system, parentSessionId })) return undefined
    return parentSessionId
  }

  private async updateExistingSessionPermissions({
    client,
    sessionId,
    permissions,
    noReply,
    owner,
  }: {
    client: AgentBackend
    sessionId: string
    permissions?: string[]
    noReply?: boolean
    owner?: string
  }) {
    if (noReply) {
      return null
    }

    const rules = resolveSessionPermissionRules({
      directory: this.sdkDirectory,
      requested: permissions,
      phase: 'create',
    })

    const updateResult = await client.sessions.setPermissions({
      sessionId,
      permission: rules,
      owner,
    })
    if (updateResult instanceof AgentRequestError) {
      return new Error('Pi rejected permission update', { cause: updateResult })
    }
    if (updateResult instanceof Error) return updateResult
    this.permissionOwner = owner
    return null
  }

  private async ensureSession({
    prompt,
    agent,
    permissions,
    injectionGuardPatterns,
    sourceMessageId,
    sessionStartScheduleKind,
    sessionStartScheduledTaskId,
  }: {
    prompt: string
    agent?: string
    /** Raw "tool:action" strings from --permission flag */
    permissions?: string[]
    injectionGuardPatterns?: string[]
    /** Chat message that started this turn; left out of a retired-session seed. */
    sourceMessageId?: string
    sessionStartScheduleKind?: 'at' | 'cron'
    sessionStartScheduledTaskId?: number
  }): Promise<
    | Error
    | {
        session: { id: string; title: string }
        getClient: AgentBackendGetter
        createdNewSession: boolean
      }
  > {
    const directory = this.sdkDirectory

    // A thread in a separate git checkout is kept out of the origin checkout.
    // A project subfolder is not: its project root contains it.
    const threadDir = applicationDirectory() ? undefined : await getThreadWorkingDirectory(this.thread.id)
    const originalRepoDirectory = threadDir?.kind === 'git-worktree'
      ? threadDir.projectDirectory
      : undefined

    const getClientResult = await getAgentBackendProvider().initializeForDirectory(directory, {
      originalRepoDirectory,
      channelId: this.channelId,
    })
    if (getClientResult instanceof Error) return getClientResult
    const getClient = getClientResult

    // Check thread state for existing session ID
    let sessionId = this.state?.sessionId
    if (!sessionId) {
      // Fallback to DB
      sessionId = await getThreadSession(this.thread.id) || undefined
    }
    // A session the backend does not own is retired, not resumed: the thread
    // moves to a new session, seeded from its chat history below.
    let retiredSessionId: string | undefined
    if (sessionId && isRetiredSession(sessionId)) {
      retiredSessionId = sessionId
      sessionId = undefined
    }

    let session: { id: string; title: string } | undefined
    let createdNewSession = false

    if (sessionId) {
      const sessionResponse = await getClient().sessions.get({
        sessionId,
        directory: this.sdkDirectory,
      })
      if (sessionResponse instanceof Error) {
        logger.warn(
          `[ENSURE SESSION] Failed to get existing session ${sessionId}: ${sessionResponse.message}`,
        )
      } else if (sessionResponse) {
        session = sessionResponse
      } else {
        logger.warn(
          `[ENSURE SESSION] session.get returned no data for ${sessionId}`,
        )
      }
    }

    if (!session) {
      // Roadie's rules for the session: checkout isolation, then requested
      // rules (send, channel policy, identity), then plugins. Later rules win.
      const sessionPermissions = resolveSessionPermissionRules({
        directory: this.sdkDirectory,
        originalRepoDirectory,
        requested: permissions,
        phase: 'create',
      })
      // Untitled: the first task names it (markPendingSessionTitle below).
      const createResult = await getClient().sessions.create({
        directory: this.sdkDirectory,
        permission: sessionPermissions,
      })
      if (createResult instanceof Error) {
        logger.error(
          `[ENSURE SESSION] session.create failed: ${createResult.message}, threadId=${this.thread.id}, directory=${this.sdkDirectory}`,
        )
        return new Error(
          `Failed to create session: ${createResult.message}, threadId=${this.thread.id}, directory=${this.sdkDirectory}`,
          { cause: createResult },
        )
      }
      session = createResult
      // Insert DB row immediately so the external-sync poller sees
      // source='roadie' before the next poll tick and skips this session.
      // The upsert at the end of ensureSession is kept for the reuse path.
      await setThreadSession(this.thread.id, session.id)
      await markPendingSessionTitle(session)
      if (injectionGuardPatterns?.length) {
        writeInjectionGuardConfig({
          sessionId: session.id,
          scanPatterns: injectionGuardPatterns,
        })
      }
      createdNewSession = true
      if (retiredSessionId) {
        await seedFromRetiredSession(
          getClient(), this.chat, this.thread.id, this.sdkDirectory,
          session.id, retiredSessionId, sourceMessageId,
        )
      }
    }

    // Store session in DB and thread state
    await setThreadSession(this.thread.id, session.id)
    threadState.setSessionId(this.threadId, session.id)
    // Parent may have been set on ingress before the thread_sessions row
    // existed; write it now that the row is guaranteed.
    const parentSessionId = this.state?.parentSessionId
    if (parentSessionId) {
      await setThreadParentSessionId({
        threadId: this.thread.id,
        parentSessionId,
      }).catch((error) => {
        logger.warn(
          `[PARENT SESSION] Failed to persist parent session for thread ${this.threadId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
    await this.hydrateSessionEventsFromDatabase({ sessionId: session.id })

    // Store session start source for scheduled tasks
    if (createdNewSession && sessionStartScheduleKind) {
      const sessionStartSourceResult = await setSessionStartSource({
        sessionId: session.id,
        scheduleKind: sessionStartScheduleKind,
        scheduledTaskId: sessionStartScheduledTaskId,
      }).catch((e) =>
        new AgentBackendError({ operation: 'setSessionStartSource', cause: e }),
      )
      if (sessionStartSourceResult instanceof Error) {
        logger.warn(
          `[SESSION START SOURCE] ${sessionStartSourceResult.message}`,
        )
      }
    }

    // Store agent preference if provided
    if (agent && createdNewSession) {
      await setSessionAgent(session.id, agent)
    }

    return { session, getClient, createdNewSession }
  }

  /**
   * Emit the model + agent banner once, before the first prompt or session
   * command can produce visible output in a newly-created session thread.
   */
  private async sendNewSessionModelInfo({
    createdNewSession,
    model,
    agent,
  }: {
    createdNewSession: boolean
    model: { providerID: string; modelID: string }
    agent?: string
  }): Promise<void> {
    if (!createdNewSession) {
      return
    }

    const modelLabel = `${model.providerID}/${model.modelID}`
    const agentLabel = agent && agent.toLowerCase() !== 'build'
      ? ` ⋅ ${agent}`
      : ''
    const result = await this.chat.sendMessage(asSubtext(`*using ${modelLabel}${agentLabel}*`)).catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (result instanceof Error) {
      logger.warn(`[SESSION INFO] Failed to send model info: ${result.message}`)
    }
  }

  /**
   * Emit the run footer: duration, model, context%, project info.
   * Triggered directly from the terminal assistant message.updated event so the
   * footer lands next to the assistant output instead of waiting for session.idle.
   */
  private async emitFooter({
    completedAt,
    runStartTime,
  }: {
    completedAt: number
    runStartTime: number
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    const runInfo = sessionId
      ? getLatestRunInfo({ events: this.eventBuffer, sessionId })
      : {
        model: undefined,
        providerID: undefined,
        agent: undefined,
        tokensUsed: 0,
      }
    const elapsedMs = completedAt - runStartTime
    const sessionDuration =
      elapsedMs < 1000
        ? '<1s'
        : prettyMilliseconds(elapsedMs, { secondsDecimalDigits: 0 })
    const agentInfo =
      runInfo.agent && runInfo.agent.toLowerCase() !== 'build'
        ? ` ⋅ **${runInfo.agent}**`
        : ''
    let contextInfo = ''
    const folderName = path.basename(this.sdkDirectory)

    const client = getAgentBackendProvider().getBackend(this.sdkDirectory)

    // Run git branch and token fetch in parallel (fast, no external CLI)
    const [branchResult, contextResult] = await Promise.all([
      execAsync('git symbolic-ref --short HEAD', {
        cwd: this.sdkDirectory,
      }).catch((e) => new FilesystemOperationError({ operation: 'gitBranch', cause: e })),
      (async () => {
        if (!client || !sessionId) {
          return []
        }
        let tokensUsed = runInfo.tokensUsed
        // Fetch final token count from API
        const [messagesResult, providersResult] = await Promise.all([
          tokensUsed === 0
            ? client.sessions.messages({
                sessionId,
                directory: this.sdkDirectory,
              })
            : null,
          client.catalog.providers({
            directory: this.sdkDirectory,
          }),
        ])

        if (messagesResult && !(messagesResult instanceof Error)) {
          const lastAssistant = [...messagesResult]
            .reverse()
            .find((m) => {
              if (m.message.role !== 'assistant') {
                return false
              }
              if (!m.message.usage) {
                return false
              }
              return getTokenTotal(m.message.usage) > 0
            })
          if (lastAssistant?.message.usage) {
            tokensUsed = getTokenTotal(lastAssistant.message.usage)
          }
        }

        const fallbackLimit = runInfo.providerID
          ? getFallbackContextLimit({
              providerID: runInfo.providerID,
            })
          : undefined

        const providers = providersResult && !(providersResult instanceof Error)
          ? providersResult.providers
          : []
        let contextLimit = fallbackLimit
        if (providers.length > 0) {
          const provider = providers.find((p) => {
            return p.id === runInfo.providerID
          })
          const model = provider?.models[runInfo.model || '']
          contextLimit = model?.contextLimit || contextLimit
        }

        if (contextLimit) {
          const percentage = Math.round(
            (tokensUsed / contextLimit) * 100,
          )
          contextInfo = ` ⋅ ${percentage}%`
        }
        return providers
      })().catch((e) => new AgentBackendError({ operation: 'resolveModelPreference', cause: e })),
    ])
    const branchName =
      branchResult instanceof Error ? '' : branchResult.stdout.trim()
    if (contextResult instanceof Error) {
      logger.error(
        'Failed to fetch provider info for context percentage:',
        contextResult,
      )
    }
    const providers = contextResult instanceof Error ? [] : (contextResult ?? [])
    const modelLabel = runInfo.model
      ? displayedModelLabel({
          modelID: runInfo.model,
          name: await resolveDisplayedModelName({
            providers,
            providerID: runInfo.providerID,
            modelID: runInfo.model,
            sessionID: sessionId,
          }),
        })
      : undefined
    const modelInfo = modelLabel ? ` ⋅ ${modelLabel}` : ''

    const truncate = (s: string, max: number) => {
      return s.length > max ? s.slice(0, max - 1) + '\u2026' : s
    }
    const truncatedFolder = truncate(folderName, 30)
    const truncatedBranch = truncate(branchName, 30)
    const projectInfo = truncatedBranch
      ? `${truncatedFolder} ⋅ ${truncatedBranch} ⋅ `
      : `${truncatedFolder} ⋅ `
    const hasQueuedMessage = this.getQueueLength() > 0
    const didUseSleepTool = sessionId
      ? didLatestUserTurnUseSleepTool({ events: this.eventBuffer, sessionId })
      : false
    const shouldNotifyUser = !hasQueuedMessage && !didUseSleepTool
    const mentionUserId = store.getState().footerMentionsEnabled && shouldNotifyUser
      ? await this.chat.footerMentionUserId(this.state?.sessionUserId)
      : undefined
    const mention = mentionUserId ? ` <@${mentionUserId}>` : ''
    const footerText = asSubtext(
      `*${projectInfo}${sessionDuration}${contextInfo}${modelInfo}${agentInfo}*${mention}`,
    )
    this.typing.stopTyping()

    await this.chat.sendMessage(footerText, { notify: shouldNotifyUser })
    logger.log(
      `DURATION: Session completed in ${sessionDuration}, model ${runInfo.model}, tokens ${runInfo.tokensUsed}`,
    )
  }

  /** Reset per-run state for the next prompt dispatch. */
  private resetPerRunState(): void {
    this.modelContextLimit = undefined
    this.modelContextLimitKey = undefined
    this.lastDisplayedContextPercentage = 0
    this.lastRateLimitDisplayTime = 0
    this.lastSentPartKind = undefined
  }

  private async maybeNotifyPromptCacheClear({
    sessionId,
    messageId,
  }: {
    sessionId: string
    messageId: string
  }): Promise<void> {
    // Only the first reply after a user prompt can show a cold cache. Later steps re-read the turn's own writes.
    // Usage arrives at step finish, so this notice may follow the first tools.
    const [firstAssistantId] = this.getAssistantMessageIdsForCurrentTurn({ sessionId })
    if (firstAssistantId !== messageId) {
      return
    }
    const cacheClear = getPromptCacheClear({
      events: this.eventBuffer,
      sessionId,
      currentMessageId: messageId,
    })
    if (!cacheClear) {
      return
    }
    const systemDiff = await this.getSystemPromptDiffForCacheClear({
      sessionId,
      previousMessageId: cacheClear.previousMessageId,
      currentMessageId: cacheClear.currentMessageId,
    })
    const chunk = asSubtext(formatPromptCacheClearMessage(cacheClear, systemDiff))
    const sendResult = await this.chat.sendNotice(chunk)
    if (sendResult instanceof Error) {
      discordLogger.error('Failed to send prompt cache notice:', sendResult)
    }
  }

  private async getSystemPromptDiffForCacheClear({
    sessionId,
    previousMessageId,
    currentMessageId,
  }: {
    sessionId: string
    previousMessageId: string
    currentMessageId: string
  }): Promise<{ additions: number; deletions: number } | undefined> {
    const previousParentId = this.getAssistantParentId({ sessionId, messageId: previousMessageId })
    const currentParentId = this.getAssistantParentId({ sessionId, messageId: currentMessageId })
    if (!previousParentId || !currentParentId) {
      return undefined
    }
    const beforeText = this.userSystemByMessageId.get(previousParentId)
    const afterText = this.userSystemByMessageId.get(currentParentId)
    if (beforeText === undefined || afterText === undefined || beforeText === afterText) {
      return undefined
    }
    return countSystemPromptDiffLines({ beforeText, afterText })
  }

  private getAssistantParentId({
    sessionId,
    messageId,
  }: {
    sessionId: string
    messageId: string
  }): string | undefined {
    for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
      const event = this.eventBuffer[i]?.event
      if (event?.type !== 'message') {
        continue
      }
      const info = event.message
      if (info.sessionId !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
        continue
      }
      return info.parentId
    }
    return undefined
  }

  // ── Retry Last User Prompt (for model-change flow) ──────────

  /**
   * Abort the active run and immediately send an empty user prompt.
   *
   * Used by /model and /unset-model so Pi can restart from the
   * current session history with the updated model preference, without
   * replaying/fetching the last user message in roadie.
   */
  async retryLastUserPrompt(): Promise<boolean> {
    const state = this.state
    if (!state?.sessionId) {
      logger.log(`[RETRY] No session for thread ${this.threadId}`)
      return false
    }

    const sessionId = state.sessionId

    // 1. Abort active run.
    let needsIdleWait = false
    const waitSinceTimestamp = Date.now()
    const abortResult = await this.dispatchAction(async () => {
      needsIdleWait = this.isBusy()
      const outcome = this.abortActiveRunInternal({
        reason: 'model-change',
      })
      if (outcome.apiAbortPromise) {
        void outcome.apiAbortPromise
      }
    }).catch((e) => new AgentBackendError({ operation: 'abortSession', cause: e }))
    if (abortResult instanceof Error) {
      logger.error('[RETRY] Failed to abort active run before retry:', abortResult)
      return false
    }

    if (needsIdleWait) {
      await this.waitForEvent({
        predicate: (event) => {
          return event.type === 'idle' && event.sessionId === sessionId
        },
        sinceTimestamp: waitSinceTimestamp,
        timeoutMs: 2000,
      })
    }

    if (this.disposed) {
      logger.log(`[RETRY] Runtime disposed before retry for thread ${this.threadId}`)
      return false
    }

    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[RETRY] Session changed before retry for thread ${this.threadId}`,
      )
      return false
    }

    logger.log(
      `[RETRY] Re-submitting with empty prompt for session ${sessionId}`,
    )

    // 2. Re-submit with empty prompt so Pi continues from session history.
    await this.enqueueIncoming({
      prompt: '',
      userId: '',
      username: '',
      appId: this.appId,
      mode: 'direct',
      resetAssistantForNewRun: true,
      expectedSessionId: sessionId,
    })

    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[RETRY] Session changed while retry was enqueued for thread ${this.threadId}`,
      )
      return false
    }

    return true
  }

  /**
   * Resume an idle session by sending `text` as a new user turn.
   *
   * Used when a question is answered after its run was aborted elsewhere:
   * the original run is dead, so question.reply is a no-op. We instead feed
   * the answer back as a fresh prompt so Pi continues from history.
   */
  async resumeWithText({ text }: { text: string }): Promise<boolean> {
    const sessionId = this.state?.sessionId
    if (!sessionId || this.disposed) {
      logger.log(`[RESUME] No session for thread ${this.threadId}`)
      return false
    }
    await this.enqueueIncoming({
      prompt: text,
      userId: '',
      username: '',
      appId: this.appId,
      mode: 'direct',
      resetAssistantForNewRun: true,
      expectedSessionId: sessionId,
    })
    return true
  }
}
