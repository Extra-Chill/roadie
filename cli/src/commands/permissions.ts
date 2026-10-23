// Permission button handler - Shows buttons for permission requests.
// When Pi asks for permission, this module renders 3 buttons:
// Accept, Accept Always, and Deny.
//
// The `directory` stored in PendingPermissionContext is the session directory
// (sdkDirectory), which is the thread's working directory when it has one.
// This is used for both the agent backend lookup (so the client header matches)
// and for explicit `directory` params in SDK calls.

import { matchesPermissionPattern } from '../permission-policy.js'
import {
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ActionRowBuilder,
  type ThreadChannel,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import type { AgentPermissionRequest } from '../agent-backend/events.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import { AgentRequestError, type AgentBackend } from '../agent-backend/types.js'
import { getPermissionTimeoutMs } from '../config.js'
import { NOTIFY_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { updateComponentMessage } from '../interaction-reply.js'

/**
 * Permission replies used to ignore backend rejection responses and only
 * fail on transport errors. Keep that: rethrow anything but a rejection.
 */
function throwUnlessRejected(result: void | Error): void {
  if (result instanceof Error && !(result instanceof AgentRequestError)) throw result
}

const logger = createLogger(LogPrefix.PERMISSIONS)

async function resumeSessionIfIdleAfterPermission({
  client,
  sessionId,
  directory,
}: {
  client: AgentBackend
  sessionId: string
  directory: string
}): Promise<Error | boolean> {
  await new Promise((resolve) => {
    setTimeout(resolve, 100)
  })

  const statuses = await client.sessions.status({ directory })
  if (statuses instanceof AgentRequestError) {
    return new Error('Failed to check session status')
  }
  if (statuses instanceof Error) throw statuses

  const sessionStatus = statuses[sessionId]
  if (!sessionStatus || sessionStatus.state !== 'idle') {
    return false
  }

  const resumeResult = await client.sessions.prompt({
    sessionId,
    directory,
    parts: [],
  })
  if (resumeResult instanceof AgentRequestError) {
    return new Error('Failed to resume session')
  }
  if (resumeResult instanceof Error) throw resumeResult

  return true
}

export function arePatternsCoveredBy({
  patterns,
  coveringPatterns,
}: {
  patterns: string[]
  coveringPatterns: string[]
}): boolean {
  return patterns.every((pattern) => {
    return coveringPatterns.some((coveringPattern) => {
      return matchesPermissionPattern({ value: pattern, pattern: coveringPattern })
    })
  })
}

export function compactPermissionPatterns(patterns: string[]): string[] {
  const uniquePatterns = Array.from(new Set(patterns))
  return uniquePatterns.filter((pattern, index) => {
    return !uniquePatterns.some((candidate, candidateIndex) => {
      if (candidateIndex === index) {
        return false
      }
      return matchesPermissionPattern({ value: pattern, pattern: candidate })
    })
  })
}

type PendingPermissionContext = {
  permission: AgentPermissionRequest
  requestIds: string[]
  directory: string
  thread: ThreadChannel
  contextHash: string
  messageId?: string
}

// Store pending permission contexts by hash.
// TTL prevents unbounded growth if user never clicks a permission button.
// Configurable via --permission-timeout-minutes CLI flag (default: 10 minutes).
export const pendingPermissionContexts = new Map<
  string,
  PendingPermissionContext
>()

// Atomic take: removes context from Map and returns it. Only the first caller
// (TTL expiry or button click) wins, preventing duplicate permission replies.
function takePendingPermissionContext(contextHash: string): PendingPermissionContext | undefined {
  const ctx = pendingPermissionContexts.get(contextHash)
  if (!ctx) {
    return undefined
  }
  pendingPermissionContexts.delete(contextHash)
  return ctx
}

/**
 * Show permission buttons for a permission request.
 * Displays 3 buttons in a row: Accept, Accept Always, Deny.
 * Returns the message ID and context hash for tracking.
 */
export async function showPermissionButtons({
  thread,
  permission,
  directory,
  subtaskLabel,
}: {
  thread: ThreadChannel
  permission: AgentPermissionRequest
  directory: string
  subtaskLabel?: string
}): Promise<{ messageId: string; contextHash: string }> {
  const contextHash = crypto.randomBytes(8).toString('hex')

  const context: PendingPermissionContext = {
    permission,
    requestIds: [permission.id],
    directory,
    thread,
    contextHash,
  }

  pendingPermissionContexts.set(contextHash, context)
  // Auto-reject on TTL expiry so the agent session doesn't hang forever
  // waiting for a permission reply that will never come. Uses atomic take
  // so only one of TTL-expiry or button-click can win.
  // After a denial, the model sees
  // this as a tool error and continues (tries alternatives or explains).
  const ttlMs = getPermissionTimeoutMs()
  setTimeout(async () => {
    const ctx = takePendingPermissionContext(contextHash)
    if (!ctx) {
      return
    }
    const client = getAgentBackendProvider().getBackend(ctx.directory)
    if (client) {
      const requestIds = ctx.requestIds.length > 0
        ? ctx.requestIds
        : [ctx.permission.id]
      const userId = ctx.thread.ownerId
      const timeoutFeedback =
        `Permission timed out — the user did not respond. They are probably away and not watching the session. ` +
        (userId
          ? `If this tool call is necessary for the core goal of this session, stop and mention the user with <@${userId}> asking them to grant permission. `
          : `If this tool call is necessary for the core goal of this session, stop and ask the user to grant permission. `) +
        `If not, continue normally — work around it, skip the tool, or use an alternative approach.`
      await Promise.all(
        requestIds.map((requestId) => {
          return client.sessions.replyPermission({
            requestId,
            directory: ctx.directory,
            reply: 'reject',
            message: timeoutFeedback,
          }).then(throwUnlessRejected)
        }),
      ).catch((error) => {
        logger.error('Failed to auto-reject expired permission:', error)
      })
      const minutes = Math.round(ttlMs / 60_000)
      updatePermissionMessage({
        context: ctx,
        status: `_Permission expired after ${minutes} minute${minutes !== 1 ? 's' : ''} and was rejected._`,
      })
    }
  }, ttlMs).unref()

  const patternStr = compactPermissionPatterns(permission.patterns).join(', ')

  // Build 3 buttons for permission actions
  const acceptButton = new ButtonBuilder()
    .setCustomId(`permission_once:${contextHash}`)
    .setLabel('Accept')
    .setStyle(ButtonStyle.Success)

  const acceptAlwaysButton = new ButtonBuilder()
    .setCustomId(`permission_always:${contextHash}`)
    .setLabel('Accept Always')
    .setStyle(ButtonStyle.Success)

  const denyButton = new ButtonBuilder()
    .setCustomId(`permission_reject:${contextHash}`)
    .setLabel('Deny')
    .setStyle(ButtonStyle.Secondary)

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    acceptButton,
    acceptAlwaysButton,
    denyButton,
  )

  const subtaskLine = subtaskLabel ? `**From:** \`${subtaskLabel}\`\n` : ''
  const externalDirLine =
    permission.permission === 'external_directory'
      ? `Agent is accessing files outside the project.\n`
      : ''
  const fullContent =
    `⚠️ **Permission Required**\n` +
    subtaskLine +
    `**Type:** \`${permission.permission}\`\n` +
    externalDirLine +
    (patternStr ? `**Pattern:** \`${patternStr}\`` : '')
  const permissionMessage = await thread.send({
    content: fullContent.slice(0, 1900),
    components: [actionRow],
    flags: NOTIFY_MESSAGE_FLAGS | MessageFlags.SuppressEmbeds,
  })

  context.messageId = permissionMessage.id

  logger.log(`Showed permission buttons for ${permission.id}`)

  return { messageId: permissionMessage.id, contextHash }
}

function updatePermissionMessage({
  context,
  status,
}: {
  context: PendingPermissionContext
  status: string
}): void {
  if (!context.messageId) {
    return
  }
  context.thread.messages
    .fetch(context.messageId)
    .then((message) => {
      const patternStr = compactPermissionPatterns(context.permission.patterns).join(', ')
      const externalDirLine =
        context.permission.permission === 'external_directory'
          ? 'Agent is accessing files outside the project.\n'
          : ''
      return message.edit({
        content:
          `⚠️ **Permission Required**\n` +
          `**Type:** \`${context.permission.permission}\`\n` +
          externalDirLine +
          (patternStr ? `**Pattern:** \`${patternStr}\`\n` : '') +
          status,
        components: [],
      })
    })
    .catch((error) => {
      logger.error('Failed to update permission message:', error)
    })
}

export async function cancelPendingPermission(threadId: string): Promise<boolean> {
  const contexts = Array.from(pendingPermissionContexts.values()).filter((context) => {
    return context.thread.id === threadId
  })

  if (contexts.length === 0) {
    return false
  }

  let cancelledCount = 0
  for (const context of contexts) {
    const pendingContext = takePendingPermissionContext(context.contextHash)
    if (!pendingContext) {
      continue
    }

    const client = getAgentBackendProvider().getBackend(pendingContext.directory)
    if (!client) {
      pendingPermissionContexts.set(pendingContext.contextHash, pendingContext)
      logger.error('Failed to dismiss pending permission: Pi backend not found')
      continue
    }

    const requestIds = pendingContext.requestIds.length > 0
      ? pendingContext.requestIds
      : [pendingContext.permission.id]

    const result = await Promise.all(
      requestIds.map((requestId) => {
        return client.sessions.replyPermission({
          requestId,
          directory: pendingContext.directory,
          reply: 'reject',
        }).then(throwUnlessRejected)
      }),
    ).then(() => {
      return 'ok' as const
    }).catch((error) => {
      pendingPermissionContexts.set(pendingContext.contextHash, pendingContext)
      logger.error('Failed to dismiss pending permission:', error)
      return 'error' as const
    })

    if (result === 'error') {
      continue
    }

    updatePermissionMessage({
      context: pendingContext,
      status: '_Permission dismissed - user sent a new message._',
    })
    cancelledCount++
  }

  if (cancelledCount > 0) {
    logger.log(`Dismissed ${cancelledCount} pending permission request(s) for thread ${threadId}`)
  }

  return cancelledCount > 0
}

/**
 * Handle button click for permission.
 */
export async function handlePermissionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId

  // Extract action and hash from customId (e.g., "permission_once:abc123")
  const [actionPart, contextHash] = customId.split(':')
  if (!actionPart || !contextHash) {
    return
  }

  const response = actionPart.replace('permission_', '')
  if (response !== 'once' && response !== 'always' && response !== 'reject') {
    return
  }

  // Atomic take: if TTL already expired and auto-rejected, context is gone.
  const context = takePendingPermissionContext(contextHash)

  if (!context) {
    await updateComponentMessage(interaction, {
      content: '_Permission expired and was already rejected. Send a new message to continue._',
      components: [],
    })
    return
  }

  // The interaction listener already acknowledged the click (deferUpdate).

  try {
    const permClient = getAgentBackendProvider().getBackend(context.directory)
    if (!permClient) {
      throw new Error('Pi backend not found for directory')
    }
    const requestIds =
      context.requestIds.length > 0
        ? context.requestIds
        : [context.permission.id]
    await Promise.all(
      requestIds.map((requestId) => {
        return permClient.sessions.replyPermission({
          requestId,
          directory: context.directory,
          reply: response,
        }).then(throwUnlessRejected)
      }),
    )

    if (response !== 'reject') {
      const resumed = await resumeSessionIfIdleAfterPermission({
        client: permClient,
        sessionId: context.permission.sessionId,
        directory: context.directory,
      })
      if (resumed instanceof Error) {
        logger.error('Failed to resume idle session after permission:', resumed)
      }
      if (resumed === true) {
        logger.log(`Resumed idle session after permission ${context.permission.id}`)
      }
    }

    // Context already removed by takePendingPermissionContext above.

    // Update message: show result and remove dropdown
    const resultText = (() => {
      switch (response) {
        case 'once':
          return '✅ Permission **accepted**'
        case 'always':
          return '✅ Permission **accepted** (auto-approve similar requests)'
        case 'reject':
          return '❌ Permission **rejected**'
      }
    })()

    updatePermissionMessage({
      context,
      status: resultText,
    })

    logger.log(
      `Permission ${context.permission.id} ${response} (${requestIds.length} request(s))`,
    )
  } catch (error) {
    logger.error('Error handling permission:', error)
    await interaction.editReply({
      content: `Failed to process permission: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

export function addPermissionRequestToContext({
  contextHash,
  requestId,
}: {
  contextHash: string
  requestId: string
}): boolean {
  const context = pendingPermissionContexts.get(contextHash)
  if (!context) {
    return false
  }
  if (context.requestIds.includes(requestId)) {
    return false
  }
  context.requestIds = [...context.requestIds, requestId]
  pendingPermissionContexts.set(contextHash, context)
  return true
}
