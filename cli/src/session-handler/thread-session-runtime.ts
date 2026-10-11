// ThreadSessionRuntime — one per active thread.
// Owns resource handles (listener controller, typing timers, part buffer).
// Delegates all state to the global store via thread-runtime-state.ts transitions.
//
// This is the sole session orchestrator. Discord handlers and slash commands
// call runtime APIs (enqueueIncoming, abortActiveRun, etc.) without inspecting
// run internals.

import { resolveSessionPermissionRules } from '../permission-policy.js'
import { forkTitlePrompt, schedulePendingForkTitle } from '../fork-title.js'
import { doAction } from '../hooks.js'
import { toAgentEvents, toAgentMessage } from '../agent-backend/opencode-events.js'
import { parsePersistedEvents } from './persisted-events.js'
import {
  consumeInterruptedSessions,
  RESTART_CONTINUATION_FAILED_NOTICE,
  RESTART_CONTINUATION_MAX_ATTEMPTS,
  RESTART_CONTINUATION_PROMPT,
  type InterruptedSession,
} from '../service-lifecycle.js'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { type Client, type ThreadChannel } from 'discord.js'
import type { ChatThread } from '../chat-platform/types.js'
import { createDiscordChatThread } from '../chat-platform/discord.js'
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
} from '@opencode-ai/sdk/v2'
import {
  agentEventSessionId,
  type AgentChildSessionEvent,
  type AgentError,
  type AgentEvent,
  type AgentMessage,
  type AgentPart,
  type AgentPermissionRequest,
  type AgentQuestionRequest,
  type AgentStatus,
  type AgentUsage,
} from '../agent-backend/events.js'
import { AgentRequestError, type AgentPromptPart } from '../agent-backend/types.js'
import path from 'node:path'
import prettyMilliseconds from 'pretty-ms'
import * as errore from 'errore'
import * as threadState from './thread-runtime-state.js'
import type { QueuedMessage } from './thread-runtime-state.js'
import type { AgentBackend, AgentBackendGetter } from '../agent-backend/types.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import { getCachedPerson, isIdentityHookConfigured, resolvePerson } from '../identity.js'
import { personMcpPermissions, registerPersonMcpServers } from '../person-mcp.js'
import { applicationDirectory, channelPolicyOverrides, channelContextBinding } from '../channel-policy.js'
import {
  isContextProviderConfigured,
  renderContextSections,
  requestContext,
  speakerKey,
} from '../context-provider.js'
import {
  writeInjectionGuardConfig,
  extractSdkErrorMessage,
  OPENCODE_SERVER_LOG_FILE,
} from '../opencode.js'
import { isAbortError } from '../utils.js'
import {
  registerEventListener,
  unregisterEventListener,
  waitForGlobalEventListener,
} from './global-event-listener.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  SILENT_MESSAGE_FLAGS,
  NOTIFY_MESSAGE_FLAGS,
  raceDiscordRename,
  DISCORD_THREAD_RENAME_TIMEOUT_MS,
  resolveThreadFooterMentionUserId,
  resolveWorkingDirectory,
} from '../discord-utils.js'
import type { DiscordFileAttachment, SessionPartKind } from '../message-formatting.js'
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
  getThreadParentSessionId,
  setThreadParentSessionId,
  getThreadWorkingDirectory,
  setSessionAgent,
  setSessionModel,
  clearSessionModel,
  getVariantCascade,
  setSessionStartSource,
  getSessionStartSource,
  getScheduledTask,
  completeScheduledTaskRunsForSession,
  failScheduledTaskRunsForSession,
  startScheduledTaskRunSession,
  appendSessionEventsSinceLastTimestamp,
  getSessionEventSnapshot,
  cancelSessionSleepForThread,
  insertThreadQueueItem,
  listAllThreadQueueItems,
  deleteThreadQueueItem,
  deleteThreadQueueItems,
  updateThreadQueueItemPayload,
} from '../database.js'
import * as orm from 'drizzle-orm'
import * as schema from '../schema.js'
import { personKeyFrom, resolvePersonBillingPool } from '../credentials/person-pool.js'
import {
  showPermissionButtons,
  addPermissionRequestToContext,
  arePatternsCoveredBy,
  pendingPermissionContexts,
} from '../commands/permissions.js'
import {
  showAskUserQuestionDropdowns,
  pendingQuestionContexts,
  cancelPendingQuestion,
  findPendingQuestionContextForRequest,
} from '../commands/ask-question.js'
import {
  showActionButtons,
  waitForQueuedActionButtonsRequest,
  pendingActionButtonContexts,
  cancelPendingActionButtons,
} from '../commands/action-buttons.js'
import {
  pendingFileUploadContexts,
  cancelPendingFileUpload,
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
  getOpencodePromptContext,
  getOpencodeSystemMessage,
  isSystemPromptForSession,
  resolveSessionSystemPrompt,
  systemPromptHasParentSession,
  type AgentInfo,
  type RepliedMessageContext,
  type WorkingDirectoryInfo,
  type ScheduledTaskSystemContext,
} from '../system-message.js'
import { getDataDir } from '../config.js'
import { countSystemPromptDiffLines } from '../cache-rewrite.js'
import { store } from '../store.js'
import { resolveValidatedAgentPreference } from './agent-utils.js'
import {
  appendOpencodeSessionEventLog,
  isOpencodeSessionEventLogEnabled,
} from './opencode-session-event-log.js'
import {
  doesLatestUserTurnHaveNaturalCompletion,
  getContinuationTurnOutcome,
  didLatestUserTurnUseSleepTool,
  didQuestionQueueHandoffSinceLatestQuestionAsked,
  deriveLatestUnansweredQuestion,
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

// Track multiple pending permissions per thread (keyed by permission ID).
// OpenCode handles blocking/sequencing — we just need to track all pending
// permissions to avoid duplicates and properly clean up on reply/teardown.
// The runtime is the sole owner of pending permissions per thread.
export const pendingPermissions = new Map<
  string, // threadId
  Map<
    string,
    {
      permission: AgentPermissionRequest
      messageId: string
      directory: string
      contextHash: string
      dedupeKey: string
    }
  > // permissionId -> data
>()
import {
  getThinkingValuesForModel,
  matchThinkingValue,
} from '../thinking-utils.js'
import { execAsync } from '../git-utils.js'
import {
  DiscordOperationError,
  OpenCodeSdkError,
  FilesystemOperationError,
} from '../errors.js'

import { notifyError } from '../sentry.js'
import { createDebouncedProcessFlush } from '../debounced-process-flush.js'
import { cancelHtmlActionsForThread } from '../html-actions.js'
import { createDebouncedTimeout } from '../debounce-timeout.js'
import { extractLeadingOpencodeCommand } from '../opencode-command-detection.js'

const logger = createLogger(LogPrefix.SESSION)
const discordLogger = createLogger(LogPrefix.DISCORD)
const DETERMINISTIC_CONTEXT_LIMIT = 100_000
const TOAST_SESSION_ID_REGEX = /\b(ses_[A-Za-z0-9]+)\b\s*$/u

function extractToastSessionId({ message }: { message: string }): string | undefined {
  const match = message.match(TOAST_SESSION_ID_REGEX)
  return match?.[1]
}

function stripToastSessionId({ message }: { message: string }): string {
  return message.replace(TOAST_SESSION_ID_REGEX, '').trimEnd()
}

const shouldLogSessionEvents =
  process.env['ROADIE_LOG_SESSION_EVENTS'] === '1' ||
  process.env['ROADIE_VITEST'] === '1'

// ── Registry ─────────────────────────────────────────────────────
// Runtime instances are kept in a plain Map (not Zustand — the Map
// is not reactive state, just a lookup for resource handles).

const runtimes = new Map<string, ThreadSessionRuntime>()

// Per-thread FIFO for Discord arrival order of one-shot slash calls vs messages.
// Covers /plan-agent (no prompt) and /foo-cmd /foo-skill. OpenCode already
// queues promptAsync. /model, /agent, and /compact are not on this queue.
const threadIngressChains = new Map<string, Promise<void>>()
const threadIngressSlotAls = new AsyncLocalStorage<ThreadIngressSlot | undefined>()

export type ThreadIngressSlot = {
  wait: Promise<void>
  release: () => void
}

export function reserveThreadIngress(threadId: string): ThreadIngressSlot {
  const previous = threadIngressChains.get(threadId) ?? Promise.resolve()
  let released = false
  let releaseHeld = () => {}
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  threadIngressChains.set(
    threadId,
    previous.then(() => held),
  )
  return {
    wait: previous,
    release: () => {
      if (released) {
        return
      }
      released = true
      releaseHeld()
    },
  }
}

export async function runInThreadIngressSlot<T>(
  slot: ThreadIngressSlot | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await threadIngressSlotAls.run(slot, run)
  } finally {
    slot?.release()
  }
}

export async function waitForCurrentThreadIngress(): Promise<void> {
  const slot = threadIngressSlotAls.getStore()
  if (!slot) {
    return
  }
  await slot.wait
}

export function releaseCurrentThreadIngress(): void {
  threadIngressSlotAls.getStore()?.release()
}

export function getRuntime(
  threadId: string,
): ThreadSessionRuntime | undefined {
  return runtimes.get(threadId)
}

export type RuntimeOptions = {
  threadId: string
  projectDirectory: string
  sdkDirectory: string
  channelId?: string
  appId?: string
  sessionId?: string
} & ({ thread: ThreadChannel; chat?: never } | { chat: ChatThread; thread?: never })

export function getOrCreateRuntime(
  opts: RuntimeOptions,
): ThreadSessionRuntime {
  const existing = runtimes.get(opts.threadId)
  if (existing) {
    if (existing.sdkDirectory !== opts.sdkDirectory) {
      logger.warn(
        `[RUNTIME] Ignoring sdkDirectory change for existing thread ${opts.threadId}: ${existing.sdkDirectory} → ${opts.sdkDirectory}`,
      )
    }
    if (opts.sessionId && !existing.state?.sessionId) {
      threadState.setSessionId(opts.threadId, opts.sessionId)
    }
    return existing
  }
  threadState.ensureThread(opts.threadId) // add to global store
  if (opts.sessionId) {
    threadState.setSessionId(opts.threadId, opts.sessionId)
  }
  const runtime = new ThreadSessionRuntime(opts)
  runtimes.set(opts.threadId, runtime)
  return runtime
}

function groupQueueRowsByThread(
  rows: Array<{ thread_id: string; queue_id: string; payload_json: string }>,
): Map<string, QueuedMessage[]> {
  const byThread = new Map<string, QueuedMessage[]>()
  for (const row of rows) {
    const parsed = parseQueuedMessagePayload({
      queueId: row.queue_id,
      payloadJson: row.payload_json,
    })
    if (parsed instanceof Error) {
      logger.warn(
        `[QUEUE] Skipping invalid queue row ${row.queue_id} in thread ${row.thread_id}: ${parsed.message}`,
      )
      continue
    }
    const items = byThread.get(row.thread_id) ?? []
    items.push(parsed)
    byThread.set(row.thread_id, items)
  }
  return byThread
}

/** Existing runtime for a thread, or one rebuilt from Discord and the DB after a restart. */
async function ensureRuntimeForThread({
  discordClient,
  resolveRuntime,
  threadId,
  appId,
  purpose,
}: {
  discordClient?: Client
  resolveRuntime?: (threadId: string) => Promise<ThreadSessionRuntime | undefined>
  threadId: string
  appId?: string
  purpose: string
}): Promise<ThreadSessionRuntime | undefined> {
  const existing = runtimes.get(threadId)
  if (existing) {
    return existing
  }
  if (resolveRuntime) return resolveRuntime(threadId)
  if (!discordClient) return undefined
  const fetched = await discordClient.channels.fetch(threadId).catch((error) => {
    logger.warn(
      `[RUNTIME] Failed to fetch thread ${threadId} for ${purpose}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  })
  if (!fetched?.isThread()) {
    logger.warn(`[RUNTIME] Skipping ${purpose} for missing thread ${threadId}`)
    return undefined
  }
  const resolved = await resolveWorkingDirectory({ channel: fetched })
  if (!resolved) {
    logger.warn(`[RUNTIME] Skipping ${purpose} for thread ${threadId}: no project directory`)
    return undefined
  }
  const sessionId = await getThreadSession(threadId)
  return getOrCreateRuntime({
    threadId,
    thread: fetched,
    projectDirectory: resolved.projectDirectory,
    sdkDirectory: resolved.workingDirectory,
    channelId: fetched.parentId || fetched.id,
    appId,
    sessionId,
  })
}

/** Threads whose main session has a run in progress right now. */
export function snapshotBusyRuntimes(): InterruptedSession[] {
  const busy: InterruptedSession[] = []
  for (const [threadId, runtime] of runtimes) {
    const sessionId = runtime.state?.sessionId
    if (!sessionId || !runtime.isBusy()) {
      continue
    }
    busy.push({
      threadId,
      sessionId,
      userId: runtime.state?.sessionUserId,
      username: runtime.state?.sessionUsername,
    })
  }
  return busy
}

/**
 * Resume runs interrupted by the previous process's shutdown. Fresh records
 * get a continuation turn; stale ones only get a notice in their thread.
 */
export async function resumeInterruptedSessions({
  discordClient,
  resolveRuntime,
  appId,
  consume = consumeInterruptedSessions,
}: {
  discordClient?: Client
  resolveRuntime?: (threadId: string) => Promise<ThreadSessionRuntime | undefined>
  appId?: string
  consume?: typeof consumeInterruptedSessions
}): Promise<{ resumed: string[]; notified: string[] }> {
  const { resume, stale } = consume()
  const resumed: string[] = []
  const notified: string[] = []
  for (const entry of stale) {
    if (resolveRuntime) {
      const runtime = await resolveRuntime(entry.threadId)
      if (!runtime) continue
      await runtime.chat.sendNotice('Roadie restarted while this session was running. Send a message to continue.')
      notified.push(entry.threadId)
      continue
    }
    const thread = await discordClient?.channels.fetch(entry.threadId).catch(() => null)
    if (!thread?.isThread()) continue
    await thread.send({
      content: asSubtext('Roadie restarted while this session was running. It was too long ago to resume automatically; send a message to continue.'),
      flags: SILENT_MESSAGE_FLAGS,
    }).catch(() => undefined)
    notified.push(entry.threadId)
  }
  for (const entry of resume) {
    const runtime = await ensureRuntimeForThread({
      discordClient,
      resolveRuntime,
      threadId: entry.threadId,
      appId,
      purpose: 'restart continuation',
    })
    if (!runtime) continue
    // The thread was rebound (e.g. /resume) since the snapshot; the old run is not ours to continue.
    if (runtime.state?.sessionId && runtime.state.sessionId !== entry.sessionId) {
      logger.log(`[RUNTIME] Thread ${entry.threadId} moved to another session since the restart; not resuming`)
      continue
    }
    await runtime.chat.sendNotice(asSubtext('Roadie restarted while this session was running. Resuming.'))
    const result = await runtime.resumeAfterRestart({
      prompt: RESTART_CONTINUATION_PROMPT,
      userId: entry.userId || discordClient?.user?.id || '',
      username: entry.username || 'Roadie',
      appId,
      expectedSessionId: entry.sessionId,
    }).catch((error: unknown) => {
      logger.warn(
        `[RUNTIME] Failed to resume thread ${entry.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    })
    if (result) resumed.push(entry.threadId)
  }
  if (resumed.length || notified.length) {
    logger.log(`[RUNTIME] Restart continuation: resumed ${resumed.length}, notified ${notified.length}`)
  }
  return { resumed, notified }
}

export async function restorePersistedLocalQueues({
  discordClient,
  resolveRuntime,
  appId,
}: {
  discordClient?: Client
  resolveRuntime?: (threadId: string) => Promise<ThreadSessionRuntime | undefined>
  appId?: string
}): Promise<void> {
  const rows = await listAllThreadQueueItems()
  if (rows.length === 0) {
    return
  }

  const byThread = groupQueueRowsByThread(rows)
  for (const [threadId, items] of byThread) {
    if (items.length === 0) {
      continue
    }
    const runtime = await ensureRuntimeForThread({ discordClient, resolveRuntime, threadId, appId, purpose: 'restored queue' })
    if (!runtime) {
      continue
    }
    await runtime.dispatchAction(() => {
      return runtime.mergeRestoredQueueAndDrain(items)
    })
  }
}

export function disposeRuntime(
  threadId: string,
  { abortActiveRun = false }: { abortActiveRun?: boolean } = {},
): void {
  const runtime = runtimes.get(threadId)
  if (!runtime) {
    return
  }
  if (abortActiveRun) {
    runtime.abortDeletedDiscordResource()
  }
  runtime.dispose()
  runtimes.delete(threadId)
  threadState.removeThread(threadId) // remove from global store
  threadIngressChains.delete(threadId)
}

export function disposeRuntimesForDirectory({
  directory,
  channelId,
}: {
  directory: string
  channelId?: string
}): number {
  let count = 0
  for (const [threadId, runtime] of runtimes) {
    if (runtime.projectDirectory !== directory) {
      continue
    }
    if (channelId && runtime.channelId !== channelId) {
      continue
    }
    runtime.dispose()
    runtimes.delete(threadId)
    threadState.removeThread(threadId)
    threadIngressChains.delete(threadId)
    count++
  }
  return count
}

export function getRuntimeThreadIdsForChannel(channelId: string): string[] {
  return Array.from(runtimes.entries())
    .filter(([, runtime]) => runtime.channelId === channelId)
    .map(([threadId]) => threadId)
}

/** Returns number of active runtimes (useful for diagnostics). */
export function getRuntimeCount(): number {
  return runtimes.size
}

export function disposeInactiveRuntimes({
  idleMs,
  nowMs = Date.now(),
}: {
  idleMs: number
  nowMs?: number
}): {
  disposedThreadIds: string[]
  disposedDirectories: string[]
} {
  const candidates = [...runtimes.entries()].filter(([, runtime]) => {
    return runtime.isIdleForInactivityTimeout({ idleMs, nowMs })
  })
  const disposedDirectories = new Set<string>()
  const disposedThreadIds: string[] = []

  for (const [threadId, runtime] of candidates) {
    runtime.dispose()
    runtimes.delete(threadId)
    threadState.removeThread(threadId)
    threadIngressChains.delete(threadId)
    disposedThreadIds.push(threadId)
    disposedDirectories.add(runtime.projectDirectory)
  }

  return {
    disposedThreadIds,
    disposedDirectories: [...disposedDirectories],
  }
}

// ── Pending UI cleanup ───────────────────────────────────────────
// Clears all pending interactive UI state for a thread on dispose/delete.
// Uses existing cancel functions which handle upstream replies (so OpenCode
// doesn't hang waiting for answers that will never come).

function cleanupPendingUiForThread(threadId: string): void {
  // Permissions: reject each pending permission so OpenCode doesn't hang,
  // then delete the per-thread tracking map.
  const threadPerms = pendingPermissions.get(threadId)
  if (threadPerms) {
    for (const [, entry] of threadPerms) {
      const ctx = pendingPermissionContexts.get(entry.contextHash)
      if (ctx) {
        const client = getAgentBackendProvider().getBackend(ctx.directory)
        if (client) {
          const requestIds: string[] = ctx.requestIds.length > 0
            ? ctx.requestIds
            : [ctx.permission.id]
          void Promise.all(
            requestIds.map((requestId) => {
              return client.sessions.replyPermission({
                requestId,
                directory: ctx.directory,
                reply: 'reject',
              })
            }),
          ).catch(() => {})
        }
        pendingPermissionContexts.delete(entry.contextHash)
      }
    }
    pendingPermissions.delete(threadId)
  }

  // Questions: cancel deletes pending context without replying to OpenCode.
  void cancelPendingQuestion(threadId)

  // Action buttons: resolves context and clears timer.
  cancelPendingActionButtons(threadId)

  // File uploads: resolves with empty files so OpenCode unblocks.
  void cancelPendingFileUpload(threadId)

  // HTML actions: clears registered action callbacks for this thread.
  cancelHtmlActionsForThread(threadId)
}

// ── Helpers ──────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function getTimestampFromSnowflake(snowflake: string): number | undefined {
  const discordEpochMs = 1_420_070_400_000n
  const snowflakeIdResult = errore.try(
    { try: () => {
      return BigInt(snowflake)
    }, catch: () => {
      return new Error('Invalid Discord snowflake')
    } },
  )
  if (snowflakeIdResult instanceof Error) return undefined
  const timestampBigInt = (snowflakeIdResult >> 22n) + discordEpochMs
  const timestampMs = Number(timestampBigInt)
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return undefined
  }
  return timestampMs
}

function toPromptFilePart(file: DiscordFileAttachment): AgentPromptPart {
  return {
    kind: 'file',
    mime: file.mime,
    url: file.url,
    ...(file.filename && { filename: file.filename }),
  }
}

function getTokenTotal(usage: AgentUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

/**
 * Built-in read-only tools that are hidden in default verbosity mode.
 * Any tool NOT in this list is considered "essential" and shown,
 * which means custom tools, MCP tools, and plugin tools are visible by default.
 */
const HIDDEN_READONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'describe-media',
  'todoread',
]

/** Check if a tool part is "essential" (shown in text-and-essential-tools mode). */
export function isEssentialToolName(toolName: string): boolean {
  // Hide known read-only built-in tools; show everything else
  // (custom tools, MCP tools, plugin tools are visible by default)
  return !HIDDEN_READONLY_TOOLS.some((name) => {
    return toolName === name || toolName.endsWith(`_${name}`)
  })
}

export function isEssentialToolPart(part: AgentPart): boolean {
  if (part.kind !== 'tool') {
    return false
  }
  if (!isEssentialToolName(part.tool)) {
    return false
  }
  if (part.tool === 'bash') {
    const hasSideEffect = part.input?.hasSideEffect
    return hasSideEffect !== false
  }
  return true
}

// ── Thread title derivation ──────────────────────────────────────

const DISCORD_THREAD_NAME_MAX = 100
const PRESERVED_THREAD_PREFIXES: string[] = [
  STATUS_PREFIX,
  // Legacy prefix from the removed /btw command; existing threads keep it.
  'btw: ',
  'Fork: ',
]

function stripPreservedThreadPrefix(name: string) {
  const matchedPrefix = PRESERVED_THREAD_PREFIXES.find((prefix) => {
    return name.startsWith(prefix)
  })
  if (!matchedPrefix) return name
  return name.slice(matchedPrefix.length).trim()
}

function getThreadNameCandidateFromSessionTitle({
  sessionTitle,
  currentName,
}: {
  sessionTitle: string | undefined | null
  currentName: string
}) {
  const trimmed = sessionTitle
    ?.replace(/<\/?callout\b[^>]*>/gi, '')
    .trim()
  if (!trimmed) {
    return null
  }
  const withoutCopiedPrefix = stripPreservedThreadPrefix(trimmed)
  if (!withoutCopiedPrefix) {
    return null
  }
  if (/^new session\s*-/i.test(withoutCopiedPrefix)) {
    return null
  }
  const matchedPrefix =
    PRESERVED_THREAD_PREFIXES.find((p) => {
      return p !== 'Fork: ' && currentName.startsWith(p)
    }) ?? ''
  return `${matchedPrefix}${withoutCopiedPrefix}`.slice(0, DISCORD_THREAD_NAME_MAX)
}

export function deriveThreadNameFromSessionTitle({
  sessionTitle,
  currentName,
}: {
  sessionTitle: string | undefined | null
  currentName: string
}): string | undefined {
  const candidate = getThreadNameCandidateFromSessionTitle({
    sessionTitle,
    currentName,
  })
  if (candidate === null) {
    return undefined
  }
  if (candidate === currentName) {
    return undefined
  }
  return candidate
}

// ── Ingress input type ───────────────────────────────────────────

export type EnqueueResult = {
  /** True if the message is waiting in queue behind an active run. */
  queued: boolean
  /** Queue position (1-based). Only set when queued is true. */
  position?: number
  /** Stable queue entry id. Set when the item was placed in the local queue. */
  queueId?: string
}

/**
 * Result of the preprocess callback. Returns the resolved prompt, images,
 * and mode after expensive async work (context fetch,
 * attachment download) completes.
 */
export type PreprocessResult = {
  prompt: string
  images?: DiscordFileAttachment[]
  repliedMessage?: RepliedMessageContext
  /** Resolved ingress mode (queue suffix or forced queue). */
  mode: 'opencode' | 'local-queue'
  /** When true, preprocessing determined the message should be silently dropped. */
  skip?: boolean
  /** Agent requested during preprocessing. Applied to the session if set. */
  agent?: string
}

/**
 * Apply the identity hook's per-person overrides to a chat turn. Only
 * platform-authenticated speakers ('chat') get a person: a CLI-asserted actor
 * is never treated as that person. Explicit agent/model on the input win;
 * person permission rules are added to any explicit ones.
 */
export function applyPersonToIngress(input: IngressInput): IngressInput {
  if (!isIdentityHookConfigured()) return input
  if (!input.userId || (input.actorVia ?? 'chat') !== 'chat') return input
  const person = getCachedPerson({ platform: input.actorPlatform ?? 'discord', id: input.userId })
  if (!person?.allowed) return input
  // Every person turn resets the session's person-scoped MCP access to the
  // speaker's own servers (none when they have no config).
  const mcpPermissions = personMcpPermissions({
    personKey: personKeyFrom({
      personId: person.personId,
      platform: input.actorPlatform ?? 'discord',
      actorId: input.userId,
    }) ?? undefined,
    hasServers: (person.mcpServers?.length ?? 0) > 0,
  })
  return {
    ...input,
    ...(person.personId ? { personId: person.personId } : {}),
    ...(person.credentialPool ? { credentialPool: person.credentialPool } : {}),
    ...(input.agent || !person.agent ? {} : { agent: person.agent }),
    ...(input.model || !person.model ? {} : { model: person.model }),
    // The MCP pair goes before the hook's own rules, which may refine it.
    permissions: [...(input.permissions ?? []), ...mcpPermissions, ...person.permissions],
  }
}

/**
 * Add the channel policy's session permission rules to a turn. Agent, model,
 * directory and verbosity come from the channel getters, which already read
 * the policy.
 */
export function applyChannelPolicyToIngress({
  input,
  channelId,
}: {
  input: IngressInput
  channelId: string
}): IngressInput {
  const { permissions } = channelPolicyOverrides(channelId)
  if (!permissions || permissions.length === 0) return input
  return { ...input, permissions: [...(input.permissions ?? []), ...permissions] }
}

export type IngressInput = {
  /** Raw task text when a fork adds synthetic lineage instructions. */
  titlePrompt?: string
  actorPlatform?: string
  prompt: string
  userId: string
  username: string
  // How userId was established: 'chat' (platform-authenticated author,
  // default) or 'cli' (asserted by a local `roadie send --user` caller).
  actorVia?: 'chat' | 'cli'
  // Opaque host person id resolved by the identity hook for this turn.
  personId?: string
  // Credential pool override from the identity hook (`credential_pool`),
  // applied to the speaker's billing pool when credential pools are enabled.
  credentialPool?: string
  // Discord message ID and thread ID for the source message, embedded in
  // <discord-user> synthetic context so the model knows which message it answers.
  sourceMessageId?: string
  sourceThreadId?: string
  // Channel that holds the source message. Differs from the thread for the
  // thread starter message, which lives in the parent channel.
  sourceChannelId?: string
  repliedMessage?: RepliedMessageContext
  images?: DiscordFileAttachment[]
  appId?: string
  command?: { name: string; arguments: string }
  /**
   * `opencode` (default): send via session.promptAsync and let opencode
   * serialize pending user turns internally.
   * `local-queue`: keep in roadie's local queue (used by slash commands).
   */
  mode?: 'opencode' | 'local-queue'
  // Force a new assistant-part routing window by resetting run-state to
  // running before enqueue. Used by model-switch retry flows where old
  // assistant IDs can linger briefly after abort.
  resetAssistantForNewRun?: boolean
  // First-dispatch-only overrides (used when creating a new session)
  agent?: string
  model?: string
  /**
   * Thinking-level variant from `/xxx-agent variant:`. Applied after
   * agent/model snapshot so it wins over cascade for this turn.
   */
  variant?: string
  /**
   * Raw permission rule strings from --permission flag ("tool:action" or
   * "tool:pattern:action"). Parsed into PermissionRuleset entries by
   * parsePermissionRules() and appended after buildSessionPermissions()
   * so they win via opencode's findLast() evaluation. Only used on
   * session creation (first dispatch).
   */
  permissions?: string[]
  injectionGuardPatterns?: string[]
  /**
   * Parent OpenCode session ID from explicit `roadie send --parent-session` only.
   * Stored once on first ingress and injected into the child system message.
   * Never set for /fork or task/subagent children (keeps system prompt cache).
   */
  parentSessionId?: string
  sessionStartSource?: { scheduleKind: 'at' | 'cron'; scheduledTaskId?: number; scheduledTaskRunId?: number }
  /** Optional guard for retries: skip enqueue when session has changed. */
  expectedSessionId?: string
  /**
   * When true, the message is added to the session context without triggering
   * the AI agent loop. Used for messages that should be visible to the model
   * on the next real turn but should not cause a response on their own
   * (e.g. user-to-user replies in a thread).
   */
  noReply?: boolean
  /** Intake data only: preserve execution identity and preferences as well as suppressing replies. */
  contextOnly?: boolean
  /**
   * True only for the wake prompt posted by the roadie_sleep task runner.
   * Every other ingress cancels a pending sleep; this one must not, because it
   * is delivering that sleep rather than superseding it.
   */
  isSleepWake?: boolean
  /** Synthetic recovery turn, never a new fork task. Preserved on retries. */
  isRestartContinuation?: boolean
  /**
   * Lazy preprocessing callback. When set, the runtime serializes it via a
   * lightweight promise chain (preprocessChain) to resolve prompt/images/mode
   * from the raw Discord message. This replaces the threadIngressQueue in
   * discord-bot.ts: expensive async work (context fetch,
   * attachment download) runs in arrival order but outside dispatchAction,
   * so SSE event handling and permission UI are not blocked.
   *
   * The closure captures Discord objects (Message, ThreadChannel) so the
   * runtime stays platform-agnostic — it just awaits the callback.
   */
  preprocess?: () => Promise<PreprocessResult>
  /**
   * Posts the "Queued message" ack and returns its Discord message ID. Runs
   * inside the serialized enqueue, before any drain can start, so the drain
   * indicator can always reply to it. Only called when the item really waits.
   */
  onLocalQueued?: (queued: { queueId: string; position: number }) => Promise<string>
}

function parseQueuedMessagePayload({
  queueId,
  payloadJson,
}: {
  queueId: string
  payloadJson: string
}): QueuedMessage | Error {
  return errore.try(
    { try: () => {
      const parsed = JSON.parse(payloadJson) as QueuedMessage
      if (!parsed || typeof parsed !== 'object') {
        return new Error('Queued message payload is not an object')
      }
      if (typeof parsed.prompt !== 'string') {
        return new Error('Queued message payload is missing prompt')
      }
      if (typeof parsed.userId !== 'string') {
        return new Error('Queued message payload is missing userId')
      }
      if (typeof parsed.username !== 'string') {
        return new Error('Queued message payload is missing username')
      }
      return { ...parsed, queueId }
    }, catch: (error) => {
      return new Error('Failed to parse queued message payload', { cause: error })
    } },
  )
}

// Rewrite `{ prompt: "/build foo" }` → `{ prompt: "", command: { name, arguments }, mode: "local-queue" }`
// when the prompt's leading token matches a registered opencode command.
// Skip if a command is already set or there's no prompt to inspect.
function maybeConvertLeadingCommand(input: IngressInput): IngressInput {
  if (input.command) return input
  if (!input.prompt) return input
  const extracted = extractLeadingOpencodeCommand(input.prompt)
  if (!extracted) return input
  return {
    ...input,
    prompt: '',
    command: extracted.command,
    mode: 'local-queue',
  }
}

type AbortRunOutcome = {
  abortId: string
  reason: string
  apiAbortPromise: Promise<void> | undefined
}

function getWorkingDirectoryPromptKey(dir: WorkingDirectoryInfo | undefined): string | null {
  if (!dir) {
    return null
  }
  return [dir.workingDirectory, dir.label, dir.projectDirectory].join('::')
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
  private dispatchingQueueId: string | undefined

  // Typing indicator scheduler handles.
  // `typingKeepaliveTimeout` is the 7s keepalive loop while a run stays busy.
  // `typingRepulseDebounce` collapses clustered immediate re-pulses after bot
  // messages into one last pulse, because Discord hides typing on the next bot
  // message and showing multiple back-to-back POSTs is wasteful.
  private typingKeepaliveTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly typingRepulseDebounce: ReturnType<typeof createDebouncedTimeout>
  private readonly deferredQuestionShow: ReturnType<typeof createDebouncedTimeout>

  private static TYPING_REPULSE_DEBOUNCE_MS = 500
  private static DEFERRED_QUESTION_SHOW_MS = 1000

  // Notification throttles for retry/context notices.
  private lastDisplayedContextPercentage = 0
  private lastRateLimitDisplayTime = 0
  private userSystemByMessageId = new Map<string, string>()

  // Last OpenCode session title we applied to Discord. Dedupes session.updated
  // so we only call setName once per distinct title. Not persisted.
  private appliedOpencodeTitle: string | undefined

  // Part output buffering (write-side cache, not domain state)
  private partBuffer = new Map<string, Map<string, AgentPart>>()
  private shownQuestionRequestIds = new Set<string>()

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
    this.typingRepulseDebounce = createDebouncedTimeout({
      delayMs: ThreadSessionRuntime.TYPING_REPULSE_DEBOUNCE_MS,
      callback: () => {
        if (!this.shouldTypeNow()) {
          return
        }
        this.restartTypingKeepalive({ sendNow: true })
      },
    })
    this.deferredQuestionShow = createDebouncedTimeout({
      delayMs: ThreadSessionRuntime.DEFERRED_QUESTION_SHOW_MS,
      callback: () => {
        if (this.disposed) {
          return
        }
        void this.dispatchAction(async () => {
          await this.tryShowPendingQuestion({ ignoreUnfinishedText: true })
        })
      },
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
    this.deferredQuestionShow.clear()
    this.stopTyping()

    // Release large internal buffers so GC can reclaim memory immediately
    // instead of waiting for the runtime object itself to become unreachable.
    this.eventBuffer = []
    this.nextEventIndex = 0
    this.partBuffer.clear()
    this.shownQuestionRequestIds.clear()
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

  seedForkPromptCacheBaseline(message: Extract<OpenCodeMessage, { role: 'assistant' }>): void {
    if (message.sessionID !== this.state?.sessionId || this.eventBuffer.length > 0) return
    this.appendEventToBuffer({ type: 'message', message: toAgentMessage(message) })
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

  private markQuestionQueueHandoffStarted(sessionId: string): void {
    this.appendEventToBuffer({ type: 'queue.question-handoff-started', sessionId })
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

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    // One backend event can imply several Roadie agent events (a task tool
    // part update also carries child-session lifecycle). Each runs the full
    // pipeline: buffer check, append, log, and its own switch case. The raw
    // backend event is logged once, with the first implied agent event.
    const agentEvents = toAgentEvents(event)
    for (let i = 0; i < agentEvents.length; i++) {
      await this.handleAgentEvent({
        agentEvent: agentEvents[i]!,
        ...(i === 0 && { rawBackendEvent: event }),
      })
    }
  }

  private async handleAgentEvent({
    agentEvent,
    rawBackendEvent,
  }: {
    agentEvent: AgentEvent
    /** Present on the first agent event derived from one backend event; the opt-in jsonl log writes it. */
    rawBackendEvent?: OpenCodeEvent
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

    if (rawBackendEvent && isOpencodeSessionEventLogEnabled()) {
      const eventLogResult = await appendOpencodeSessionEventLog({
        threadId: this.threadId,
        projectDirectory: this.projectDirectory,
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
        await this.handlePermissionAsked(agentEvent.request)
        break
      case 'permission.replied':
        this.handlePermissionReplied(agentEvent)
        break
      case 'question.asked':
        await this.handleQuestionAsked(agentEvent.request)
        break
      case 'question.replied':
        this.handleQuestionReplied(agentEvent)
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
        const result = await action().catch((e) => new OpenCodeSdkError({ operation: 'dispatchAction', cause: e }))
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
        const result = await next().catch((e) => new OpenCodeSdkError({ operation: 'processAction', cause: e }))
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
    this.ensureTypingNow()
    void this.dispatchAction(() => {
      return this.tryDrainQueue({ showIndicator: true })
    })
  }

  private shouldTypeNow(): boolean {
    if (!this.chat.capabilities.typing) return false
    if (this.disposed) {
      return false
    }
    if (this.hasPendingInteractiveUi()) {
      return false
    }
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return false
    }
    return isSessionBusy({ events: this.eventBuffer, sessionId })
  }

  private async sendTypingPulse(): Promise<void> {
    const result = await this.chat.sendTyping()
    if (result instanceof Error) {
      discordLogger.log(`Failed to send typing: ${result}`)
    }
  }

  private clearTypingKeepalive(): void {
    if (!this.typingKeepaliveTimeout) {
      return
    }
    clearTimeout(this.typingKeepaliveTimeout)
    this.typingKeepaliveTimeout = null
  }

  private armTypingKeepalive({
    delayMs,
  }: {
    delayMs: number
  }): void {
    this.typingKeepaliveTimeout = setTimeout(() => {
      const activeTimer = this.typingKeepaliveTimeout
      if (!activeTimer) {
        return
      }
      void (async () => {
        if (!this.shouldTypeNow()) {
          this.stopTyping()
          return
        }
        await this.sendTypingPulse()
        if (this.typingKeepaliveTimeout !== activeTimer) {
          return
        }
        if (!this.shouldTypeNow()) {
          this.stopTyping()
          return
        }
        this.armTypingKeepalive({ delayMs: 7000 })
      })()
    }, delayMs)
  }

  private restartTypingKeepalive({
    sendNow,
  }: {
    sendNow: boolean
  }): void {
    this.clearTypingKeepalive()
    this.armTypingKeepalive({ delayMs: sendNow ? 0 : 7000 })
  }

  private ensureTypingNow(): void {
    if (!this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    if (!this.typingKeepaliveTimeout && !this.typingRepulseDebounce.isPending()) {
      this.armTypingKeepalive({ delayMs: 0 })
      return
    }
    this.typingRepulseDebounce.trigger()
  }

  private ensureTypingKeepalive(): void {
    if (!this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    if (this.typingKeepaliveTimeout || this.typingRepulseDebounce.isPending()) {
      return
    }
    this.armTypingKeepalive({ delayMs: 7000 })
  }

  private stopTyping(): void {
    this.typingRepulseDebounce.clear()
    this.clearTypingKeepalive()
  }

  private requestTypingRepulse(): void {
    if (!this.shouldTypeNow()) {
      return
    }
    this.typingRepulseDebounce.trigger()
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
    const last = finalPart
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
      this.requestTypingRepulse()
    }
  }

  private async showInteractiveUi({
    skipPartId,
    show,
  }: {
    skipPartId?: string
    flushMessageId?: string
    show: () => Promise<void>
  }): Promise<void> {
    this.stopTyping()
    await this.flushCurrentTurnParts({
      mode: 'interactive',
      throughPartId: skipPartId,
      skipPartId,
    })
    await show()
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
    // means OpenCode promoted the oldest one at a step boundary.
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

    this.storePart(part)

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
      this.ensureTypingNow()
      return
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
      await this.showInteractiveUi({
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
        await this.tryShowPendingQuestion()
      }
      return
    }

    if (part.kind === 'step-finish') {
      this.ensureTypingKeepalive()
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
    this.requestTypingRepulse()
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
      await this.tryDrainQueue({ showIndicator: true })
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
      this.stopTyping()
      this.resetPerRunState()
      this.clearBufferedPartsForMessages(assistantMessageIds)
      logger.log(
        `[ASSISTANT COMPLETED] no visible output, skipping footer for message ${completedMessageId} sessionId=${sessionId}`,
      )
      return
    }

    this.stopTyping()

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
          `[SESSION ERROR] Run aborted by the agent backend, not by Roadie sessionId=${sessionId} ${this.formatRunStateForLog()}; the backend's reason is in ${OPENCODE_SERVER_LOG_FILE}`,
        )
      }
      await this.persistEventBufferDebounced.flush()
      return
    }

    const errorMessage = truncateSessionErrorMessage(
      formatSessionErrorFromProps(event.error),
    )
    logger.error(`Sending error to thread: ${errorMessage}`)
    await this.chat.sendMessage(`✗ opencode session error: ${errorMessage}`, { notify: true })
    await this.persistEventBufferDebounced.flush()

    // Inject synthetic idle so isSessionBusy() returns false and queued
    // messages can drain. Without this, a session error leaves the event
    // buffer in a "busy" state forever (no session.idle follows the error),
    // causing local-queue items to be stuck indefinitely. See #74.
    this.markQueueDispatchIdle(sessionId)
    await this.tryDrainQueue({ showIndicator: true })
  }

  private async handlePermissionAsked(
    permission: AgentPermissionRequest,
  ): Promise<void> {
    const sessionId = this.state?.sessionId
    const subtaskInfo = this.getSubtaskInfoForSession(permission.sessionId)
    const isMainSession = permission.sessionId === sessionId
    const isSubtaskSession = Boolean(subtaskInfo)

    if (!isMainSession && !isSubtaskSession) {
      logger.log(
        `[PERMISSION IGNORED] Permission for unknown session (expected: ${sessionId} or subtask, got: ${permission.sessionId})`,
      )
      return
    }

    const subtaskLabel = subtaskInfo?.label

    const dedupeKey = buildPermissionDedupeKey({
      permission,
      directory: this.sdkDirectory,
    })
    const threadPermissions = pendingPermissions.get(this.thread.id)
    const existingPending = threadPermissions
      ? Array.from(threadPermissions.values()).find((pending) => {
          if (pending.dedupeKey === dedupeKey) {
            return true
          }
          if (pending.directory !== this.sdkDirectory) {
            return false
          }
          if (pending.permission.permission !== permission.permission) {
            return false
          }
          return arePatternsCoveredBy({
            patterns: permission.patterns,
            coveringPatterns: pending.permission.patterns,
          })
        })
      : undefined

    if (existingPending) {
      logger.log(
        `[PERMISSION] Deduped permission ${permission.id} (matches pending ${existingPending.permission.id})`,
      )
      this.stopTyping()
      if (!pendingPermissions.has(this.thread.id)) {
        pendingPermissions.set(this.thread.id, new Map())
      }
      pendingPermissions.get(this.thread.id)!.set(permission.id, {
        permission,
        messageId: existingPending.messageId,
        directory: this.sdkDirectory,
        contextHash: existingPending.contextHash,
        dedupeKey,
      })
      const added = this.chat.interactions.addPermissionRequest({
        contextHash: existingPending.contextHash,
        requestId: permission.id,
      })
      if (!added) {
        logger.log(
          `[PERMISSION] Failed to attach duplicate request ${permission.id} to context`,
        )
      }
      return
    }

    logger.log(
      `Permission requested: permission=${permission.permission}, patterns=${permission.patterns.join(', ')}${subtaskLabel ? `, subtask=${subtaskLabel}` : ''}`,
    )

    this.stopTyping()

    const { messageId, contextHash } = await this.chat.interactions.permission({
      permission,
      directory: this.sdkDirectory,
      subtaskLabel,
    })

    if (!pendingPermissions.has(this.thread.id)) {
      pendingPermissions.set(this.thread.id, new Map())
    }
    pendingPermissions.get(this.thread.id)!.set(permission.id, {
      permission,
      messageId,
      directory: this.sdkDirectory,
      contextHash,
      dedupeKey,
    })
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

  private hasUnfinishedTextPart(messageID: string): boolean {
    return this.getBufferedParts(messageID).some((part) => {
      return part.kind === 'text' && !part.endedAt
    })
  }

  // OpenCode emits question.asked when the tool starts, often before the
  // preceding text part gets time.end. Showing the dropdown on that event
  // holds the action queue while Discord posts, so the later text-end cannot
  // send and dumps after the queued » user: indicator. Wait for text-end.
  private async tryShowPendingQuestion({
    ignoreUnfinishedText = false,
  } = {}): Promise<boolean> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return false
    }

    const request = deriveLatestUnansweredQuestion({
      events: this.eventBuffer,
      sessionId,
    })
    if (!request) {
      this.deferredQuestionShow.clear()
      return false
    }
    if (
      this.shownQuestionRequestIds.has(request.id)
      || findPendingQuestionContextForRequest({
        threadId: this.thread.id,
        requestId: request.id,
      })
    ) {
      this.deferredQuestionShow.clear()
      return true
    }

    const messageId = request.tool?.messageID
    if (!ignoreUnfinishedText && messageId && this.hasUnfinishedTextPart(messageId)) {
      return false
    }

    this.shownQuestionRequestIds.add(request.id)
    await this.showInteractiveUi({
      flushMessageId: messageId,
      show: async () => {
        await this.chat.interactions.question({
          sessionId,
          directory: this.sdkDirectory,
          requestId: request.id,
          input: { questions: request.questions },
          silent: this.getQueueLength() > 0,
        })
      },
    })
    this.deferredQuestionShow.clear()
    this.maybeHandoffQueuedItemForPendingQuestion({
      sessionId,
      reason: 'question-shown',
    })
    return true
  }

  private async handleQuestionAsked(
    questionRequest: AgentQuestionRequest,
  ): Promise<void> {
    const sessionId = this.state?.sessionId
    if (questionRequest.sessionId !== sessionId) {
      logger.log(
        `[QUESTION IGNORED] Question for different session (expected: ${sessionId}, got: ${questionRequest.sessionId})`,
      )
      return
    }

    logger.log(
      `Question requested: id=${questionRequest.id}, questions=${questionRequest.questions.length}`,
    )

    const shown = await this.tryShowPendingQuestion()
    if (!shown) {
      this.deferredQuestionShow.trigger()
    }
  }

  private handleQuestionReplied(properties: { sessionId: string }): void {
    const sessionId = this.state?.sessionId
    if (properties.sessionId !== sessionId) {
      return
    }
    this.deferredQuestionShow.clear()
    this.onInteractiveUiStateChanged()

    // When a question is answered and the local queue has items, the model may
    // continue the same run without ever reaching the local-queue idle gate.
    // Hand off only the next queued item to OpenCode immediately so the queue
    // resumes, but keep later items local so their `» user:` indicators still
    // appear one-by-one when they actually become active.
    this.maybeHandoffQueuedItemForPendingQuestion({
      sessionId,
      reason: 'question-replied',
    })
  }

  // Detached helper promise for the "question blocks while local queue has
  // items" flow. Prevents overlapping single-item handoffs when the question is
  // shown, answered, and new queued items arrive close together.
  private questionQueueHandoffPromise: Promise<void> | null = null

  private maybeHandoffQueuedItemForPendingQuestion({
    sessionId,
    reason,
  }: {
    sessionId: string | undefined
    reason: 'question-shown' | 'question-replied' | 'queue-added-during-question'
  }): void {
    if (!sessionId) {
      return
    }
    if (didQuestionQueueHandoffSinceLatestQuestionAsked({
      events: this.eventBuffer,
      sessionId,
    })) {
      return
    }
    if (this.getQueueLength() === 0) {
      return
    }
    if (this.questionQueueHandoffPromise) {
      return
    }
    logger.log(
      `[QUESTION QUEUE HANDOFF] Queue has ${this.getQueueLength()} items, handing off first item (${reason})`,
    )
    this.questionQueueHandoffPromise = this.handoffQueuedItemForPendingQuestion({
      sessionId,
    }).catch((error) => {
      logger.error('[QUESTION QUEUE HANDOFF] Failed to hand off queued message:', error)
      if (error instanceof Error) {
        void notifyError(error, 'Failed to hand off queued message during pending question')
      }
    }).finally(() => {
      this.questionQueueHandoffPromise = null
    })
  }

  private async handoffQueuedItemForPendingQuestion({
    sessionId,
  }: {
    sessionId: string
  }): Promise<void> {
    if (this.disposed) {
      return
    }
    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[QUESTION QUEUE HANDOFF] Session changed before queue handoff for thread ${this.threadId}`,
      )
      return
    }

    const next = threadState.dequeueItem(this.threadId)
    if (!next) {
      return
    }

    await this.sendQueueDrainIndicator(next)

    this.markQuestionQueueHandoffStarted(sessionId)
    await this.submitViaOpencodeQueue(next)
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
      this.stopTyping()
      return
    }

    if (event.status.state === 'busy') {
      this.ensureTypingNow()
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

  // Rename the Discord thread to match the OpenCode-generated session title.
  //
  // Discord rate-limits channel/thread renames heavily — reported as ~2 per
  // 10 minutes per thread (discord/discord-api-docs#1900, discordjs/discord.js#6651)
  // and discord.js setName() can block silently on the 3rd attempt. We therefore:
  // - rename at most once per distinct title (deduped via appliedOpencodeTitle)
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
    if (this.appliedOpencodeTitle === normalizedTitle) {
      return
    }
    if (!this.chat.capabilities.rename) {
      await (await getDb()).update(schema.thread_sessions).set({ last_synced_name: normalizedTitle }).where(orm.eq(schema.thread_sessions.thread_id, this.threadId))
      const synced = await this.chat.syncTitle?.(normalizedTitle)
      if (synced instanceof Error) logger.warn('Could not synchronize native chat title:', synced)
      this.appliedOpencodeTitle = normalizedTitle
      return
    }
    const desiredName = deriveThreadNameFromSessionTitle({
      sessionTitle: info.title,
      currentName: this.chat.name,
    })
    // Mark before setName so concurrent session.updated events don't stack
    // renames. Keep the mark on failure — retry is almost always a rate limit.
    this.appliedOpencodeTitle = normalizedTitle
    if (!desiredName) {
      return
    }

    const renameResult = await raceDiscordRename({
      rename: this.chat.rename(desiredName)
        .catch((e) =>
          new Error('Failed to rename thread from OpenCode title', {
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
    logger.log(
      `[TITLE] Renamed thread ${this.threadId} to "${desiredName}" from OpenCode session title`,
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
   * Submit a user turn directly to opencode's internal session queue.
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
   * pool (person id, else `<platform>:<actorId>`, with the identity hook's
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

  private async submitViaOpencodeQueue(input: IngressInput): Promise<EnqueueResult> {
    await this.supersedePendingSleep(input)
    let skippedBySessionGuard = false

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
        if (input.contextOnly) {
          const backend = await getAgentBackendProvider().initializeForDirectory(this.sdkDirectory)
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
          const context = getOpencodePromptContext({
            platform: this.chat.platform, sessionId: existingSessionId, threadId: this.threadId,
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
        this.stopTyping()
        await this.chat.sendMessage(errorMessage, { notify: true })
        await this.tryDrainQueue({ showIndicator: true })
      }

      // ── Ensure session ──────────────────────────────────────
      const sessionResult = await this.ensureSession({
        prompt: input.prompt,
        agent: input.agent,
        permissions: input.permissions,
        injectionGuardPatterns: input.injectionGuardPatterns,
        sessionStartScheduleKind: input.sessionStartSource?.scheduleKind,
        sessionStartScheduledTaskId: input.sessionStartSource?.scheduledTaskId,
      })
      if (sessionResult instanceof Error) {
        await cleanupOnError(`✗ ${sessionResult.message}`)
        return
      }

      const { session, getClient, createdNewSession } = sessionResult
      schedulePendingForkTitle({ session, prompt: forkTitlePrompt(input), backend: getClient(), directory: this.sdkDirectory })

      await this.registerSpeakerMcpServers({ client: getClient(), input })
      const updatePermissionsResult = await this.updateExistingSessionPermissions({
        client: getClient(),
        sessionId: session.id,
        createdNewSession,
        permissions: input.permissions,
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
      // from the requested agent while OpenCode keeps running the old agent.
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
      }).catch((e) => new OpenCodeSdkError({ operation: 'resolveAgent', cause: e }))
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
        })().catch((e) => new OpenCodeSdkError({ operation: 'resolveModelPreference', cause: e })),
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
          'No AI provider connected. Configure a provider in OpenCode with `/connect` command.',
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
      const syntheticContext = getOpencodePromptContext({
        platform: this.chat.platform,
        sessionId: session.id,
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
        systemPromptFromSourceSession: !isSystemPromptForSession({ system, sessionId: session.id }),
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
      // A busy session takes this prompt at its next step boundary; the
      // running step is never aborted. Only /abort stops a run.
      // Marked before sending so a fast pickup event can't arrive first.
      const pendingMessageId = this.isBusy() && !input.noReply ? input.sourceMessageId : undefined
      if (pendingMessageId) {
        this.markPendingDelivery(pendingMessageId)
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
        void notifyError(promptResult, 'promptAsync failed in submitViaOpencodeQueue')
        await cleanupOnError(`✗ OpenCode API error: ${promptResult.message}`)
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
        `[INGRESS] promptAsync accepted by opencode queue sessionId=${session.id} threadId=${this.threadId}`,
      )

      // noReply messages don't trigger the agent loop, so don't mark as busy
      if (!input.noReply) {
        this.markQueueDispatchBusy(session.id)
      }
    })

    if (skippedBySessionGuard) {
      return { queued: false }
    }
    return { queued: false }
  }

  /**
   * Enqueue in roadie's local per-thread queue.
   * Used for explicit queue workflows (slash commands, queueMessage=true).
   */
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
    const queueId = crypto.randomBytes(8).toString('hex')
    const queuedMessage: QueuedMessage = {
      queueId,
      prompt: input.prompt,
      userId: input.userId,
      username: input.username,
      images: input.images,
      appId: input.appId,
      command: input.command,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      permissions: input.permissions,
      injectionGuardPatterns: input.injectionGuardPatterns,
      parentSessionId: input.parentSessionId,
      sourceMessageId: input.sourceMessageId,
      sourceThreadId: input.sourceThreadId,
      sourceChannelId: input.sourceChannelId,
      repliedMessage: input.repliedMessage,
      sessionStartScheduleKind: input.sessionStartSource?.scheduleKind,
      sessionStartScheduledTaskId: input.sessionStartSource?.scheduledTaskId,
      titlePrompt: input.titlePrompt,
      noReply: input.noReply,
      contextOnly: input.contextOnly,
      isSleepWake: input.isSleepWake,
      isRestartContinuation: input.isRestartContinuation,
    }

    let result: EnqueueResult = { queued: false, queueId }

    await this.dispatchAction(async () => {
      // Determine if the message will genuinely wait in queue
      const position = (this.state?.queueItems.length ?? 0) + 1
      result = this.isBusy()
        ? { queued: true, position, queueId }
        : { queued: false, queueId }

      // Post the ack before the item is visible to any drain path.
      const queueAckMessageId = result.queued && input.onLocalQueued
        ? await input.onLocalQueued({ queueId, position }).catch((error) => {
          logger.error(`[QUEUE] Failed to post queue ack for ${queueId}:`, error)
          return undefined
        })
        : undefined
      const item: QueuedMessage = queueAckMessageId
        ? { ...queuedMessage, queueAckMessageId }
        : queuedMessage

      const persistResult = await insertThreadQueueItem({
        queueId,
        threadId: this.threadId,
        payloadJson: JSON.stringify(item),
      }).catch((error) => {
        return new Error('Failed to persist queued message', { cause: error })
      })
      if (persistResult instanceof Error) {
        logger.error(
          `[QUEUE] Failed to persist queued message ${queueId} in thread ${this.threadId}: ${persistResult.message}`,
        )
        throw persistResult
      }
      threadState.enqueueItem(this.threadId, item)
      const stateAfterEnqueue = threadState.getThreadState(this.threadId)

      if (this.hasPendingQuestionUi()) {
        this.maybeHandoffQueuedItemForPendingQuestion({
          sessionId: stateAfterEnqueue?.sessionId || this.state?.sessionId,
          reason: 'queue-added-during-question',
        })
      }

      await this.tryDrainQueue()
    })
    return result
  }

  /**
   * Ingress API for Discord handlers and commands.
   * Defaults to opencode queue mode; local queue mode is explicit.
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
    // opencode's session.command API instead of being sent to the model as
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
    return this.submitViaOpencodeQueue(input)
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
        // noReply messages always go through the opencode path so the flag
        // reaches promptAsync; local queue doesn't support noReply.
        const enqueueResult = resolvedInput.noReply
          ? await this.submitViaOpencodeQueue({
              ...resolvedInput,
              mode: 'opencode',
              command: undefined,
            })
          : (resolvedInput.mode === 'local-queue' || resolvedInput.command)
            ? await this.enqueueViaLocalQueue(resolvedInput)
            : await this.submitViaOpencodeQueue(resolvedInput)
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

    this.stopTyping()
    this.deferredQuestionShow.clear()

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
      cleared = await this.clearQueueNow()
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
    }).catch((e) => new OpenCodeSdkError({ operation: 'abortSession', cause: e }))
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
    return this.state?.queueItems.length ?? 0
  }

  /** Clear all queued messages. Returns the removed items. */
  async clearQueue(): Promise<threadState.QueuedMessage[]> {
    let cleared: threadState.QueuedMessage[] = []
    await this.dispatchAction(async () => {
      cleared = await this.clearQueueNow()
    })
    return cleared
  }

  // Must run inside dispatchAction.
  private async clearQueueNow(): Promise<threadState.QueuedMessage[]> {
    const persistResult = await deleteThreadQueueItems(this.threadId).catch((error) => {
      return new Error('Failed to clear persisted queue', { cause: error })
    })
    if (persistResult instanceof Error) {
      logger.error(
        `[QUEUE] Failed to clear persisted queue for thread ${this.threadId}: ${persistResult.message}`,
      )
      return []
    }
    return threadState.clearQueueItems(this.threadId)
  }

  /** Remove a queued message by its 1-based position. */
  async removeQueuePosition(position: number): Promise<threadState.QueuedMessage | undefined> {
    let removed: threadState.QueuedMessage | undefined
    await this.dispatchAction(async () => {
      const current = this.state?.queueItems[position - 1]
      if (!current) {
        return
      }
      if (current.queueId) {
        const persistResult = await deleteThreadQueueItem(current.queueId).catch((error) => {
          return new Error('Failed to delete persisted queue item', { cause: error })
        })
        if (persistResult instanceof Error) {
          logger.error(
            `[QUEUE] Failed to delete persisted queue item ${current.queueId}: ${persistResult.message}`,
          )
          return
        }
      }
      removed = threadState.removeQueueItemAtPosition(this.threadId, position)
    })
    return removed
  }

  /** Remove a queued message by stable queue id. */
  async removeQueueItemById(queueId: string): Promise<threadState.QueuedMessage | undefined> {
    let removed: threadState.QueuedMessage | undefined
    await this.dispatchAction(async () => {
      const persistResult = await deleteThreadQueueItem(queueId).catch((error) => {
        return new Error('Failed to delete persisted queue item', { cause: error })
      })
      if (persistResult instanceof Error) {
        logger.error(
          `[QUEUE] Failed to delete persisted queue item ${queueId}: ${persistResult.message}`,
        )
        return
      }
      removed = threadState.removeQueueItemById(this.threadId, queueId)
      if (!removed && persistResult) {
        const parsed = parseQueuedMessagePayload({
          queueId: persistResult.queue_id,
          payloadJson: persistResult.payload_json,
        })
        if (!(parsed instanceof Error)) {
          removed = parsed
        }
      }
    })
    return removed
  }

  /**
   * Update a queued message identified by its Discord source message ID.
   * If newPrompt is empty, the item is removed from the queue.
   * Returns { found: true, removed } if the item was in the queue,
   * or { found: false } if it was already dispatched or never queued.
   */
  async updateQueuedMessage({
    sourceMessageId,
    newPrompt,
  }: {
    sourceMessageId: string
    newPrompt: string
    }): Promise<{ found: boolean; removed: boolean }> {
    let result: { found: boolean; removed: boolean } = { found: false, removed: false }
    await this.dispatchAction(async () => {
      const trimmed = newPrompt.trim()
      const original = this.state?.queueItems.find((item) => {
        return item.sourceMessageId === sourceMessageId
      })
      if (!original) {
        result = { found: false, removed: false }
        return
      }
      const queueId = original.queueId
      if (queueId) {
        const persistResult = trimmed
          ? await updateThreadQueueItemPayload({
            queueId,
            payloadJson: JSON.stringify({ ...original, prompt: trimmed }),
          }).catch((error) => {
            return new Error('Failed to update persisted queue item', { cause: error })
          })
          : await deleteThreadQueueItem(queueId).catch((error) => {
            return new Error('Failed to delete persisted queue item', { cause: error })
          })
        if (persistResult instanceof Error) {
          logger.error(
            `[QUEUE] Failed to persist queue update for ${queueId}: ${persistResult.message}`,
          )
          result = { found: true, removed: false }
          return
        }
      }
      threadState.updateQueueItemBySourceMessageId(
        this.threadId,
        sourceMessageId,
        (item) => {
          if (!trimmed) return null
          return { ...item, prompt: trimmed }
        },
      )
      result = trimmed
        ? { found: true, removed: false }
        : { found: true, removed: true }
    })
    return result
  }

  /** Remove a queued message identified by its Discord source message ID. */
  async removeQueuedMessage(
    sourceMessageId: string,
  ): Promise<threadState.QueuedMessage | undefined> {
    let removed: threadState.QueuedMessage | undefined
    await this.dispatchAction(async () => {
      const current = this.state?.queueItems.find((item) => {
        return item.sourceMessageId === sourceMessageId
      })
      if (!current) {
        return
      }
      if (current.queueId) {
        const persistResult = await deleteThreadQueueItem(current.queueId).catch((error) => {
          return new Error('Failed to delete persisted queue item', { cause: error })
        })
        if (persistResult instanceof Error) {
          logger.error(
            `[QUEUE] Failed to delete persisted queue item ${current.queueId}: ${persistResult.message}`,
          )
          return
        }
      }
      removed = threadState.updateQueueItemBySourceMessageId(
        this.threadId,
        sourceMessageId,
        () => null,
      )
    })
    return removed
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
    await this.tryDrainQueue({ showIndicator: true })
  }

  private async hydrateLiveSessionStatus(): Promise<'idle' | 'busy' | 'unavailable'> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return 'idle'
    }
    await this.hydrateSessionEventsFromDatabase({ sessionId })
    const getClient = await getAgentBackendProvider().initializeForDirectory(this.sdkDirectory)
    if (getClient instanceof Error) {
      logger.warn(
        `[QUEUE] OpenCode unavailable while restoring queue for ${this.threadId}: ${getClient.message}`,
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

  private async acknowledgeAcceptedQueueItem(item: QueuedMessage): Promise<void> {
    if (!item.queueId) {
      return
    }
    await this.dispatchAction(async () => {
      const persistResult = await deleteThreadQueueItem(item.queueId!).catch((error) => {
        return new Error('Failed to delete persisted queue item', { cause: error })
      })
      if (persistResult instanceof Error) {
        logger.error(
          `[QUEUE] Failed to persist accept of ${item.queueId}: ${persistResult.message}`,
        )
        return
      }
      threadState.removeQueueItemById(this.threadId, item.queueId!)
    })
  }

  // Silent reply to the message that queued the item. Discord replies must
  // reference a message in the same channel.
  private async sendQueueDrainIndicator(item: QueuedMessage): Promise<void> {
    const replyTarget = item.queueAckMessageId
      ?? (item.sourceChannelId === this.threadId ? item.sourceMessageId : undefined)
    const content = (() => {
      if (replyTarget) {
        return asSubtext('Executing queued prompt')
      }
      const preview = item.command
        ? `/${item.command.name}`
        : item.prompt.replace(/\s+/g, ' ').trim().slice(0, 150)
      return asSubtext(`Executing queued prompt from ${item.username}: ${preview}`)
    })()
    const sendResult = await this.chat.sendNotice(content, replyTarget ? { replyTo: replyTarget } : undefined)
    if (sendResult instanceof Error) {
      discordLogger.error('Failed to send queue drain indicator:', sendResult)
    }
  }

  // ── Queue Drain ─────────────────────────────────────────────

  /**
   * Check if we can dispatch the next queued message. If so, dequeue and
   * start dispatchPrompt (detached — does not block the action queue).
   * Called after enqueue, after run finishes, or after a blocker resolves.
   *
   * @param showIndicator - When true, shows "» username: prompt" in Discord.
   *   Only set to true when draining after a previous run finishes or a
   *   blocker resolves — not on the immediate first dispatch from enqueueIncoming.
   */
  private async tryDrainQueue({ showIndicator = false } = {}): Promise<void> {
    const thread = threadState.getThreadState(this.threadId)
    if (!thread) {
      return
    }
    if (thread.queueItems.length === 0) {
      return
    }
    // Interactive UI (action buttons, questions, permissions) does NOT block
    // queue drain. The isSessionBusy check is sufficient: questions and
    // permissions keep the OpenCode session busy, so drain is naturally
    // blocked. Action buttons are fire-and-forget (session already idle),
    // so queued messages should dispatch immediately.

    const sessionBusy = thread.sessionId
      ? isSessionBusy({ events: this.eventBuffer, sessionId: thread.sessionId })
      : false
    if (sessionBusy) {
      return
    }

    if (this.dispatchingQueueId) return
    const next = thread.queueItems[0]
    if (!next) {
      return
    }
    this.dispatchingQueueId = next.queueId

    logger.log(
      `[QUEUE DRAIN] Processing queued message from ${next.username}`,
    )

    // Show queued message indicator only for messages that actually waited
    // behind a running request — not for the first immediate dispatch.
    if (showIndicator) {
      await this.sendQueueDrainIndicator(next)
    }

    // Start dispatch (detached — does not block the action queue).
    // The prompt call is long-running. Events continue to flow through
    // the action queue while the SDK call is in-flight. Event-derived busy
    // gating prevents concurrent local-queue dispatches. Mark busy now to
    // close the tiny window before the first session.status busy arrives.
    const dispatchSessionId = thread.sessionId
    if (dispatchSessionId) {
      this.markQueueDispatchBusy(dispatchSessionId)
    }
    let accepted = false
    void this.dispatchPrompt(next).then(async (ok) => {
      accepted = ok
      if (ok) {
        await this.acknowledgeAcceptedQueueItem(next)
      }
    }).catch(async (err) => {
      logger.error('[DISPATCH] Prompt dispatch failed:', err)
      void notifyError(err, 'Runtime prompt dispatch failed')
      if (dispatchSessionId) {
        this.markQueueDispatchIdle(dispatchSessionId)
      }
    }).finally(() => {
      this.dispatchingQueueId = undefined
      if (!accepted) {
        return
      }
      void this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
    })
  }

  // ── Prompt Dispatch ─────────────────────────────────────────
  // Resolve session, build system message, send to OpenCode.
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
      sessionStartScheduleKind: input.sessionStartScheduleKind,
      sessionStartScheduledTaskId: input.sessionStartScheduledTaskId,
    })
    if (sessionResult instanceof Error) {
      this.stopTyping()
      await this.chat.sendMessage(`✗ ${sessionResult.message}`, { notify: true })
      // Show indicator: this dispatch failed, so the next queued message
      // has been waiting — the user needs to see which one is starting.
      return false
    }
    const { session, getClient, createdNewSession } = sessionResult
    schedulePendingForkTitle({ session, prompt: forkTitlePrompt(input), backend: getClient(), directory: this.sdkDirectory })

    await this.registerSpeakerMcpServers({ client: getClient(), input })
    const updatePermissionsResult = await this.updateExistingSessionPermissions({
      client: getClient(),
      sessionId: session.id,
      createdNewSession,
      permissions: input.permissions,
    })
    if (updatePermissionsResult instanceof Error) {
      this.stopTyping()
      await this.chat.sendMessage(`Failed to update session permissions: ${updatePermissionsResult.message}`, { notify: true })
      return false
    }

    // ── Resolve model + agent preferences ─────────────────────
    const channelId = this.channelId
    const resolvedAppId = input.appId

    // Explicit agent prompts (for example /plan-agent <prompt>) must update
    // the session preference before dispatch. Otherwise the model can resolve
    // from the requested agent while OpenCode keeps running the old agent.
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
        this.stopTyping()
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
    }).catch((e) => new OpenCodeSdkError({ operation: 'resolveAgent', cause: e }))
    if (earlyAgentResult instanceof Error) {
      this.stopTyping()
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
      })().catch((e) => new OpenCodeSdkError({ operation: 'resolveModelPreference', cause: e })),
      getVariantCascade({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
      }),
    ])
    if (earlyModelResult instanceof Error) {
      this.stopTyping()
      await this.chat.sendMessage(`Failed to resolve model: ${earlyModelResult.message}`, { notify: true })
      return false
    }
    const earlyModelParam = earlyModelResult
    if (!earlyModelParam) {
      this.stopTyping()
      await this.chat.sendMessage('No AI provider connected. Configure a provider in OpenCode with `/connect` command.')
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
      this.stopTyping()
      await this.chat.sendMessage(`✗ Failed to prepare system prompt: ${system.message}`, { notify: true })
      return false
    }
    const systemPromptFromSourceSession = !isSystemPromptForSession({ system, sessionId: session.id })
    const workingDirectoryChanged = this.consumeWorkingDirectoryPromptChange(workingDirectory)
    const syntheticContext = getOpencodePromptContext({
      platform: this.chat.platform,
      sessionId: session.id,
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
      const discordTag = getOpencodePromptContext({
        platform: this.chat.platform,
        sessionId: session.id,
        threadId: this.thread.id,
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: input.sourceThreadId || this.thread.id,
        threadName: this.chat.name || undefined,
        repliedMessage: input.repliedMessage,
        systemPromptFromSourceSession,
        parentSessionId: this.getParentSessionIdMissingFromSystem({ system, input }),
      })
      await this.recordTurnAttribution({ sessionId: session.id, input })
      const commandResponse = await getClient().sessions.command(
        {
          sessionId: session.id,
          directory: this.sdkDirectory,
          command: queuedCommand.name,
          arguments: queuedCommand.arguments + (discordTag ? `\n${discordTag}` : ''),
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
          this.stopTyping()
          return true
        }
        const apiError = new Error(`OpenCode API error: ${errorMessage}`)
        logger.error(`[DISPATCH] ${apiError.message}`)
        void notifyError(apiError, 'OpenCode API error during command')
        this.stopTyping()
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
          this.stopTyping()
          await this.chat.sendMessage('✗ Command timed out after 30 seconds. Try a shorter command or run it with /run-shell-command.', { notify: true })
          return false
        }

        const commandErrorForAbortCheck: unknown = commandResponse
        if (isAbortError(commandErrorForAbortCheck)) {
          logger.log(
            `[DISPATCH] Command aborted (expected) sessionId=${session.id}`,
          )
          this.stopTyping()
          return true
        }

        logger.error(
          `[DISPATCH] Command SDK call failed: ${commandResponse.message}`,
        )
        void notifyError(commandResponse, 'Failed to send command to OpenCode')
        this.stopTyping()
        await this.chat.sendMessage(`✗ Unexpected bot Error: ${commandResponse.message}`, { notify: true })
        return false
      }

      logger.log(`[DISPATCH] Successfully ran command for session ${session.id}`)
      return true
    }

    await this.recordTurnAttribution({ sessionId: session.id, input })
    await waitForGlobalEventListener()
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
      void notifyError(errorObject, 'OpenCode API error during local queue prompt')
      this.stopTyping()
      await this.chat.sendMessage(`✗ OpenCode API error: ${errorMessage}`, { notify: true })
      return false
    }

    logger.log(
      `[DISPATCH] promptAsync accepted by opencode queue sessionId=${session.id} threadId=${this.threadId}`,
    )
    return true
  }

  // ── Session Ensure ──────────────────────────────────────────
  // Creates or reuses the OpenCode session for this thread.

  /** Cached per-session scheduled task info for the system message. */
  private scheduledTaskContextCache = new Map<
    string,
    ScheduledTaskSystemContext | undefined
  >()

  /**
   * Resolve the scheduled-task context for the system message, once per
   * session. The row in session_start_sources is immutable, so caching the
   * result keeps the system prompt identical across turns (prompt-cache safe).
   * One-shot 'at' tasks are deleted after their run, so only schedule_kind
   * survives for them.
   */
  private async resolveScheduledTaskContext(
    sessionId: string,
  ): Promise<ScheduledTaskSystemContext | undefined> {
    const cache = this.scheduledTaskContextCache
    if (cache.has(sessionId)) {
      return cache.get(sessionId)
    }
    const context = await (async (): Promise<
      ScheduledTaskSystemContext | undefined
    > => {
      const source = await getSessionStartSource({ sessionId })
      if (!source) {
        return undefined
      }
      const task = source.scheduled_task_id
        ? await getScheduledTask(source.scheduled_task_id)
        : null
      return {
        taskId: source.scheduled_task_id ?? undefined,
        scheduleKind: source.schedule_kind,
        cronExpr: task?.cron_expr,
        timezone: task?.timezone,
      }
    })().catch((error) => {
      logger.warn(
        `[SCHEDULED TASK CONTEXT] Failed to resolve for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    })
    cache.set(sessionId, context)
    return context
  }

  // Speaker key of the last turn we fetched per-turn host context for.
  private lastContextSpeakerKey: string | undefined

  private contextSpeaker(input: { userId?: string; username?: string; personId?: string; actorVia?: 'chat' | 'cli' }) {
    if (!input.userId || (input.actorVia ?? 'chat') !== 'chat') return {}
    return {
      actor: {
        platform: this.chat.platform,
        id: input.userId,
        ...(input.username ? { name: input.username } : {}),
      },
      ...(input.personId ? { personId: input.personId } : {}),
    }
  }

  /**
   * Per-turn host context, fetched only when the speaker differs from the
   * previous turn's. First/reconstructed turns have no successful speaker
   * lookup, so they fetch too. Shared session context carries no speaker.
   */
  private async resolveTurnContext({
    sessionId,
    input,
    isFirstTurn,
  }: {
    sessionId: string
    input: { userId?: string; username?: string; personId?: string; actorVia?: 'chat' | 'cli'; contextOnly?: boolean }
    isFirstTurn: boolean
  }): Promise<string> {
    if (input.contextOnly || !isContextProviderConfigured()) return ''
    const speaker = this.contextSpeaker(input)
    const key = speakerKey(speaker)
    const previous = this.lastContextSpeakerKey
    if (previous === key) return ''
    if (key === 'none') {
      this.lastContextSpeakerKey = key
      return ''
    }
    const sections = await requestContext({
      event: 'turn',
      sessionId,
      spaceId: this.chat.spaceId ?? undefined,
      threadId: this.thread.id,
      channelId: this.channelId,
      directory: this.sdkDirectory,
      ...channelContextBinding(this.channelId || this.threadId),
      ...speaker,
    })
    // Empty/error responses are not a successful refresh. Retry on the next
    // turn rather than permanently caching the failed speaker lookup.
    if (sections.length > 0) this.lastContextSpeakerKey = key
    return renderContextSections(sections)
  }

  /**
   * Pinned system prompt for this turn. Generated only on the first turn of a
   * session; forks start with the source session's pinned prompt.
   */
  private async resolveTurnSystemPrompt({
    sessionId,
    channelTopic,
    agents,
    input,
  }: {
    sessionId: string
    channelTopic: string | undefined
    agents: AgentInfo[]
    input: { username?: string; userId?: string; parentSessionId?: string }
  }) {
    return resolveSessionSystemPrompt({
      sessionId,
      generate: async () => {
        const base = getOpencodeSystemMessage({
          platform: this.chat.platform,
          sessionId,
          channelId: this.channelId,
          guildId: this.chat.spaceId ?? undefined,
          threadId: this.thread.id,
          channelTopic,
          agents,
          username: this.state?.sessionUsername || input.username,
          userId: this.state?.sessionUserId || input.userId,
          parentSessionId: this.state?.parentSessionId || input.parentSessionId,
          scheduledTask: await this.resolveScheduledTaskContext(sessionId),
        })
        // Host context for the whole session, pinned with the prompt so it
        // stays cache-stable across turns.
        const sections = await requestContext({
          event: 'session_start',
          sessionId,
          spaceId: this.chat.spaceId ?? undefined,
          threadId: this.thread.id,
          channelId: this.channelId,
          directory: this.sdkDirectory,
          ...channelContextBinding(this.channelId || this.threadId),
        })
        return base + renderContextSections(sections)
      },
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

  /**
   * Connect the speaker's own MCP servers, authenticated with their stored
   * credential. Only chat speakers the identity hook allows get any; the
   * hook result is read again here (cached) rather than carried on the queued
   * turn so no credential material ever travels with it. Never fatal.
   */
  private async registerSpeakerMcpServers({
    client,
    input,
  }: {
    client: AgentBackend
    input: Pick<IngressInput, 'userId' | 'actorVia' | 'personId'>
  }): Promise<void> {
    if (!isIdentityHookConfigured()) return
    if (!input.userId || (input.actorVia ?? 'chat') !== 'chat') return
    const actor = { platform: this.chat.platform, id: input.userId }
    const person = await resolvePerson({ actor }).catch(() => null)
    if (!person?.allowed || !person.mcpServers?.length) return
    const personKey = personKeyFrom({ personId: person.personId, platform: actor.platform, actorId: actor.id })
    if (!personKey) return
    await registerPersonMcpServers({
      backend: client,
      directory: this.sdkDirectory,
      dataDir: getDataDir(),
      personKey,
      servers: person.mcpServers,
    }).catch((e: unknown) => logger.warn(`[PERSON-MCP] registration failed: ${String(e)}`))
  }

  private async updateExistingSessionPermissions({
    client,
    sessionId,
    createdNewSession,
    permissions,
  }: {
    client: AgentBackend
    sessionId: string
    createdNewSession: boolean
    permissions?: string[]
  }) {
    if (createdNewSession) {
      return null
    }

    const rules = resolveSessionPermissionRules({
      directory: this.sdkDirectory,
      requested: permissions,
      phase: 'update',
    })
    if (rules.length === 0) {
      return null
    }

    const updateResult = await client.sessions.setPermissions({
      sessionId,
      permission: rules,
    })
    if (updateResult instanceof AgentRequestError) {
      return new Error('OpenCode rejected permission update', { cause: updateResult })
    }
    if (updateResult instanceof Error) return updateResult
    return null
  }

  private async ensureSession({
    prompt,
    agent,
    permissions,
    injectionGuardPatterns,
    sessionStartScheduleKind,
    sessionStartScheduledTaskId,
  }: {
    prompt: string
    agent?: string
    /** Raw "tool:action" strings from --permission flag */
    permissions?: string[]
    injectionGuardPatterns?: string[]
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
      // Omit title so OpenCode auto-generates a summary from the conversation
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
      if (injectionGuardPatterns?.length) {
        writeInjectionGuardConfig({
          sessionId: session.id,
          scanPatterns: injectionGuardPatterns,
        })
      }
      createdNewSession = true
    }

    if (!session) {
      return new Error(
        `Failed to create or get session: threadId=${this.thread.id}, channelId=${this.channelId}, directory=${directory}, sdkDirectory=${this.sdkDirectory}, existingSessionId=${sessionId ?? 'none'}, createdNewSession=${createdNewSession}`,
      )
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
        new OpenCodeSdkError({ operation: 'setSessionStartSource', cause: e }),
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
   * Emit the model + agent banner once, before the first prompt or OpenCode
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
      })().catch((e) => new OpenCodeSdkError({ operation: 'resolveModelPreference', cause: e })),
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
    this.stopTyping()

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
    // TODO: send this before step 1 tools finish. Tokens arrive only with step-finish, after tools in v1 and v2.
    // OpenCode v2 publishes `session.step.streamed` at stream end (before tools settle) but without tokens, and
    // packages/ai drops Anthropic `message_start` usage (onMessageStart returns NO_EVENTS). Needs upstream:
    // add tokens to Step.Streamed, or emit a usage event on message_start for a notice right after the prompt.
    // https://github.com/anomalyco/opencode/blob/v2/packages/schema/src/session-event.ts
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
   * Used by /model and /unset-model so opencode can restart from the
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
    }).catch((e) => new OpenCodeSdkError({ operation: 'abortSession', cause: e }))
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

    // 2. Re-submit with empty prompt so opencode continues from session history.
    await this.enqueueIncoming({
      prompt: '',
      userId: '',
      username: '',
      appId: this.appId,
      mode: 'opencode',
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
   * the answer back as a fresh prompt so opencode continues from history.
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
      mode: 'opencode',
      resetAssistantForNewRun: true,
      expectedSessionId: sessionId,
    })
    return true
  }
}

// ── Module-level helpers ──────────────────────────────────────────

function buildPermissionDedupeKey({
  permission,
  directory,
}: {
  permission: AgentPermissionRequest
  directory: string
}): string {
  const normalizedPatterns = [...permission.patterns].sort((a, b) => {
    return a.localeCompare(b)
  })
  return `${directory}::${permission.permission}::${normalizedPatterns.join('|')}`
}

function getFallbackContextLimit({
  providerID,
}: {
  providerID: string
}): number | undefined {
  if (providerID === 'deterministic-provider') {
    return DETERMINISTIC_CONTEXT_LIMIT
  }
  return undefined
}

/** Format a session error from event properties for display. */
function formatSessionErrorFromProps(error?: AgentError): string {
  if (!error) {
    return 'Unknown error'
  }
  const parts: string[] = []
  // A backend error without a message carries only its name as the message.
  if (error.message && error.message !== error.name) {
    parts.push(error.message)
  }
  if (error.statusCode) {
    parts.push(`(${error.statusCode})`)
  }
  if (error.provider) {
    parts.push(`[${error.provider}]`)
  }
  return parts.length > 0 ? parts.join(' ') : error.name || 'Unknown error'
}

function truncateSessionErrorMessage(message: string): string {
  const maxLength = 400
  if (message.length <= maxLength) {
    return message
  }
  return `${message.slice(0, maxLength - 1)}…`
}
