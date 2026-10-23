// Local per-thread message queue for one thread runtime.
// Owns queue item persistence (insert/update/delete in SQLite plus the
// in-memory thread state), the local queue drain, accepted-item acks, the
// "Executing queued prompt" indicator and the single-item handoff to the agent
// backend while a question is pending. The runtime owns this object and passes
// in the callbacks it needs; the serial action queue, prompt dispatch and
// opencode submission stay in the runtime.

import crypto from 'node:crypto'
import type { ChatThread } from '../chat-platform/types.js'
import {
  insertThreadQueueItem,
  deleteThreadQueueItem,
  deleteThreadQueueItems,
  updateThreadQueueItemPayload,
} from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import { asSubtext } from '../message-formatting.js'
import { notifyError } from '../sentry.js'
import {
  didQuestionQueueHandoffSinceLatestQuestionAsked,
  isSessionBusy,
  type EventBufferEntry,
} from './event-stream-state.js'
import type { EnqueueResult, IngressInput } from './ingress-input.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import { parseQueuedMessagePayload } from './runtime-helpers.js'
import * as threadState from './thread-runtime-state.js'
import type { QueuedMessage } from './thread-runtime-state.js'

const logger = createLogger(LogPrefix.SESSION)
const discordLogger = createLogger(LogPrefix.DISCORD)

export type MessageQueueOptions = {
  threadId: string
  chat: ChatThread
  isDisposed: () => boolean
  isBusy: () => boolean
  hasPendingQuestionUi: () => boolean
  getEventBuffer: () => EventBufferEntry[]
  dispatchAction: (action: () => Promise<void>) => Promise<void>
  markQueueDispatchBusy: (sessionId: string) => void
  markQueueDispatchIdle: (sessionId: string) => void
  markQuestionQueueHandoffStarted: (sessionId: string) => void
  submitViaOpencodeQueue: (input: IngressInput) => Promise<EnqueueResult>
  dispatchPrompt: (input: QueuedMessage) => Promise<boolean>
}

export class MessageQueue {
  private readonly opts: MessageQueueOptions
  private readonly threadId: string
  private dispatchingQueueId: string | undefined

  // Detached helper promise for the "question blocks while local queue has
  // items" flow. Prevents overlapping single-item handoffs when the question is
  // shown, answered, and new queued items arrive close together.
  private questionQueueHandoffPromise: Promise<void> | null = null

  constructor(opts: MessageQueueOptions) {
    this.opts = opts
    this.threadId = opts.threadId
  }

  private get state(): threadState.ThreadRunState | undefined {
    return threadState.getThreadState(this.threadId)
  }

  maybeHandoffQueuedItemForPendingQuestion({
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
      events: this.opts.getEventBuffer(),
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
    if (this.opts.isDisposed()) {
      return
    }
    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[QUESTION QUEUE HANDOFF] Session changed before queue handoff for thread ${this.threadId}`,
      )
      return
    }

    // Pi cannot switch speaker policies inside a running turn, even while
    // waiting on a question. Leave the item for the normal idle drain.
    if (getAgentBackendProvider().id === 'pi') return

    const next = threadState.dequeueItem(this.threadId)
    if (!next) {
      return
    }

    await this.sendQueueDrainIndicator(next)

    this.opts.markQuestionQueueHandoffStarted(sessionId)
    await this.opts.submitViaOpencodeQueue(next)
  }

  /**
   * Enqueue in roadie's local per-thread queue.
   * Used for explicit queue workflows (slash commands, queueMessage=true).
   */
  async enqueueViaLocalQueue(input: IngressInput): Promise<EnqueueResult> {
    const queueId = crypto.randomBytes(8).toString('hex')
    const queuedMessage: QueuedMessage = {
      queueId,
      prompt: input.prompt,
      userId: input.userId,
      personId: input.personId,
      actorVia: input.actorVia,
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

    await this.opts.dispatchAction(async () => {
      // Determine if the message will genuinely wait in queue
      const position = (this.state?.queueItems.length ?? 0) + 1
      result = this.opts.isBusy()
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

      if (this.opts.hasPendingQuestionUi()) {
        this.maybeHandoffQueuedItemForPendingQuestion({
          sessionId: stateAfterEnqueue?.sessionId || this.state?.sessionId,
          reason: 'queue-added-during-question',
        })
      }

      await this.tryDrainQueue()
    })
    return result
  }

  /** Number of messages waiting in the queue. */
  getQueueLength(): number {
    return this.state?.queueItems.length ?? 0
  }

  /** Clear all queued messages. Returns the removed items. */
  async clearQueue(): Promise<threadState.QueuedMessage[]> {
    let cleared: threadState.QueuedMessage[] = []
    await this.opts.dispatchAction(async () => {
      cleared = await this.clearQueueNow()
    })
    return cleared
  }

  // Must run inside dispatchAction.
  async clearQueueNow(): Promise<threadState.QueuedMessage[]> {
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
    await this.opts.dispatchAction(async () => {
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
    await this.opts.dispatchAction(async () => {
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
    await this.opts.dispatchAction(async () => {
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
    await this.opts.dispatchAction(async () => {
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

  private async acknowledgeAcceptedQueueItem(item: QueuedMessage): Promise<void> {
    if (!item.queueId) {
      return
    }
    await this.opts.dispatchAction(async () => {
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
    const sendResult = await this.opts.chat.sendNotice(content, replyTarget ? { replyTo: replyTarget } : undefined)
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
  async tryDrainQueue({ showIndicator = false } = {}): Promise<void> {
    const thread = threadState.getThreadState(this.threadId)
    if (!thread) {
      return
    }
    if (thread.queueItems.length === 0) {
      return
    }
    // Interactive UI (action buttons, questions, permissions) does NOT block
    // queue drain. The isSessionBusy check is sufficient: questions and
    // permissions keep the agent session busy, so drain is naturally
    // blocked. Action buttons are fire-and-forget (session already idle),
    // so queued messages should dispatch immediately.

    const sessionBusy = thread.sessionId
      ? isSessionBusy({ events: this.opts.getEventBuffer(), sessionId: thread.sessionId })
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
      this.opts.markQueueDispatchBusy(dispatchSessionId)
    }
    let accepted = false
    void this.opts.dispatchPrompt(next).then(async (ok) => {
      accepted = ok
      if (ok) {
        await this.acknowledgeAcceptedQueueItem(next)
      }
    }).catch(async (err) => {
      logger.error('[DISPATCH] Prompt dispatch failed:', err)
      void notifyError(err, 'Runtime prompt dispatch failed')
      if (dispatchSessionId) {
        this.opts.markQueueDispatchIdle(dispatchSessionId)
      }
    }).finally(() => {
      this.dispatchingQueueId = undefined
      if (!accepted) {
        return
      }
      void this.opts.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
    })
  }
}
