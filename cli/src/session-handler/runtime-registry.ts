// Registry of live ThreadSessionRuntime instances, plus the registry-wide
// operations: restart continuation, restored local queues and disposal.

import {
  consumeInterruptedSessions,
  restartContinuationPrompt,
  type InterruptedSession,
} from '../service-lifecycle.js'
import { ChannelType, type Client, type ThreadChannel } from 'discord.js'
import type { ChatThread } from '../chat-platform/types.js'
import { createDiscordChatChannel } from '../chat-platform/discord.js'
import * as threadState from './thread-runtime-state.js'
import type { QueuedMessage } from './thread-runtime-state.js'
import { channelUsesChannelConversation } from '../channel-policy.js'
import { createLogger, LogPrefix } from '../logger.js'
import { SILENT_MESSAGE_FLAGS, resolveWorkingDirectory } from '../discord-utils.js'
import { asSubtext } from '../message-formatting.js'
import { getThreadSession, listAllThreadQueueItems } from '../database.js'
import { ThreadSessionRuntime } from './thread-session-runtime.js'
import { clearThreadIngress } from './thread-ingress.js'
import { parseQueuedMessagePayload } from './runtime-helpers.js'

const logger = createLogger(LogPrefix.SESSION)

// ── Registry ─────────────────────────────────────────────────────
// Runtime instances are kept in a plain Map (not Zustand — the Map
// is not reactive state, just a lookup for resource handles).

const runtimes = new Map<string, ThreadSessionRuntime>()

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
  // An inline channel conversation (`threads: none`) is keyed by its channel.
  if (fetched?.type === ChannelType.GuildText && channelUsesChannelConversation(fetched.id)) {
    const resolvedChannel = await resolveWorkingDirectory({ channel: fetched })
    if (!resolvedChannel) {
      logger.warn(`[RUNTIME] Skipping ${purpose} for channel ${threadId}: no project directory`)
      return undefined
    }
    return getOrCreateRuntime({
      threadId,
      chat: createDiscordChatChannel(fetched),
      projectDirectory: resolvedChannel.projectDirectory,
      sdkDirectory: resolvedChannel.workingDirectory,
      channelId: fetched.id,
      appId,
      sessionId: await getThreadSession(threadId),
    })
  }
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
      prompt: restartContinuationPrompt(entry),
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
  clearThreadIngress(threadId)
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
    clearThreadIngress(threadId)
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

export async function disposeInactiveRuntimes({
  idleMs,
  nowMs = Date.now(),
}: {
  idleMs: number
  nowMs?: number
}): Promise<{
  disposedThreadIds: string[]
  disposedDirectories: string[]
}> {
  const disposedDirectories = new Set<string>()
  const disposedThreadIds: string[] = []

  for (const [threadId, runtime] of runtimes.entries()) {
    if (!await runtime.isIdleForInactivityTimeout({ idleMs, nowMs })) continue
    if (runtimes.get(threadId) !== runtime) continue
    runtime.dispose()
    runtimes.delete(threadId)
    threadState.removeThread(threadId)
    clearThreadIngress(threadId)
    disposedThreadIds.push(threadId)
    disposedDirectories.add(runtime.projectDirectory)
  }

  return {
    disposedThreadIds,
    disposedDirectories: [...disposedDirectories],
  }
}
