// Interactive UI prompts for one thread runtime.
// Shows permission requests (deduped against pending ones covering the same
// patterns) and question dropdowns. Questions wait for the preceding text part
// to finish, with a debounced fallback, so the dropdown never lands ahead of
// the text that introduced it. The runtime owns this object and passes in the
// callbacks it needs; queue handoff stays in the runtime.

import type { AgentPermissionRequest, AgentQuestionRequest, AgentPart } from '../agent-backend/events.js'
import type { ChatThread } from '../chat-platform/types.js'
import { arePatternsCoveredBy } from '../commands/permissions.js'
import { findPendingQuestionContextForRequest } from '../commands/ask-question.js'
import { createDebouncedTimeout } from '../debounce-timeout.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { AssistantTurnFlushMode } from '../message-formatting.js'
import { deriveLatestUnansweredQuestion, type EventBufferEntry } from './event-stream-state.js'
import { buildPermissionDedupeKey, pendingPermissions } from './pending-ui.js'

const logger = createLogger(LogPrefix.SESSION)

const DEFERRED_QUESTION_SHOW_MS = 1000

export type InteractiveUiOptions = {
  threadId: string
  sdkDirectory: string
  chat: ChatThread
  isDisposed: () => boolean
  getSessionId: () => string | undefined
  getEventBuffer: () => EventBufferEntry[]
  getBufferedParts: (messageID: string) => AgentPart[]
  getSubtaskInfoForSession: (sessionId: string) => { label: string } | undefined
  getQueueLength: () => number
  stopTyping: () => void
  flushCurrentTurnParts: (opts: {
    mode: AssistantTurnFlushMode
    throughPartId?: string
    skipPartId?: string
  }) => Promise<void>
  dispatchAction: (action: () => Promise<void>) => Promise<void>
  onQuestionShown: (sessionId: string) => void
}

export class InteractiveUi {
  private readonly opts: InteractiveUiOptions
  private readonly deferredQuestionShow: ReturnType<typeof createDebouncedTimeout>
  private shownQuestionRequestIds = new Set<string>()

  constructor(opts: InteractiveUiOptions) {
    this.opts = opts
    this.deferredQuestionShow = createDebouncedTimeout({
      delayMs: DEFERRED_QUESTION_SHOW_MS,
      callback: () => {
        if (this.opts.isDisposed()) {
          return
        }
        void this.opts.dispatchAction(async () => {
          await this.tryShowPendingQuestion({ ignoreUnfinishedText: true })
        })
      },
    })
  }

  clearDeferredQuestionShow(): void {
    this.deferredQuestionShow.clear()
  }

  dispose(): void {
    this.deferredQuestionShow.clear()
    this.shownQuestionRequestIds.clear()
  }

  async showInteractiveUi({
    skipPartId,
    show,
  }: {
    skipPartId?: string
    flushMessageId?: string
    show: () => Promise<void>
  }): Promise<void> {
    this.opts.stopTyping()
    await this.opts.flushCurrentTurnParts({
      mode: 'interactive',
      throughPartId: skipPartId,
      skipPartId,
    })
    await show()
  }

  async handlePermissionAsked(
    permission: AgentPermissionRequest,
  ): Promise<void> {
    const { threadId, sdkDirectory, chat } = this.opts
    const sessionId = this.opts.getSessionId()
    const subtaskInfo = this.opts.getSubtaskInfoForSession(permission.sessionId)
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
      directory: sdkDirectory,
    })
    const threadPermissions = pendingPermissions.get(threadId)
    const existingPending = threadPermissions
      ? Array.from(threadPermissions.values()).find((pending) => {
          if (pending.dedupeKey === dedupeKey) {
            return true
          }
          if (pending.directory !== sdkDirectory) {
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
      this.opts.stopTyping()
      if (!pendingPermissions.has(threadId)) {
        pendingPermissions.set(threadId, new Map())
      }
      pendingPermissions.get(threadId)!.set(permission.id, {
        permission,
        messageId: existingPending.messageId,
        directory: sdkDirectory,
        contextHash: existingPending.contextHash,
        dedupeKey,
      })
      const added = chat.interactions.addPermissionRequest({
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

    this.opts.stopTyping()

    const { messageId, contextHash } = await chat.interactions.permission({
      permission,
      directory: sdkDirectory,
      subtaskLabel,
    })

    if (!pendingPermissions.has(threadId)) {
      pendingPermissions.set(threadId, new Map())
    }
    pendingPermissions.get(threadId)!.set(permission.id, {
      permission,
      messageId,
      directory: sdkDirectory,
      contextHash,
      dedupeKey,
    })
  }

  private hasUnfinishedTextPart(messageID: string): boolean {
    return this.opts.getBufferedParts(messageID).some((part) => {
      return part.kind === 'text' && !part.endedAt
    })
  }

  // OpenCode emits question.asked when the tool starts, often before the
  // preceding text part gets time.end. Showing the dropdown on that event
  // holds the action queue while Discord posts, so the later text-end cannot
  // send and dumps after the queued » user: indicator. Wait for text-end.
  async tryShowPendingQuestion({
    ignoreUnfinishedText = false,
  } = {}): Promise<boolean> {
    const sessionId = this.opts.getSessionId()
    if (!sessionId) {
      return false
    }

    const request = deriveLatestUnansweredQuestion({
      events: this.opts.getEventBuffer(),
      sessionId,
    })
    if (!request) {
      this.deferredQuestionShow.clear()
      return false
    }
    if (
      this.shownQuestionRequestIds.has(request.id)
      || findPendingQuestionContextForRequest({
        threadId: this.opts.threadId,
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
        await this.opts.chat.interactions.question({
          sessionId,
          directory: this.opts.sdkDirectory,
          requestId: request.id,
          input: { questions: request.questions },
          silent: this.opts.getQueueLength() > 0,
        })
      },
    })
    this.deferredQuestionShow.clear()
    this.opts.onQuestionShown(sessionId)
    return true
  }

  async handleQuestionAsked(
    questionRequest: AgentQuestionRequest,
  ): Promise<void> {
    const sessionId = this.opts.getSessionId()
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
}
