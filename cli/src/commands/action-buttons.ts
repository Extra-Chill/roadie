// Action button tool handler - Shows Discord buttons for quick model actions.
// Used by the roadie_action_buttons tool to render up to 3 buttons and route
// button clicks back into the session as a new user message.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ButtonInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import { channelUsesChannelConversation } from '../channel-policy.js'
import { createDiscordChatChannel } from '../chat-platform/discord.js'
import crypto from 'node:crypto'
import {
  deletePendingActionButtons,
  deletePendingActionButtonsForThread,
  getPendingActionButtons,
  getThreadSession,
  insertPendingActionButtons,
  type PendingActionButtons,
} from '../database.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  SILENT_MESSAGE_FLAGS,
  resolveWorkingDirectory,
  sendThreadMessage,
} from '../discord-utils.js'
import { createLogger } from '../logger.js'
import { replyOrEditInteraction } from '../interaction-reply.js'
import { QUEUE_PREFIX } from '../message-formatting.js'
import { notifyError } from '../sentry.js'
import { getOrCreateRuntime } from '../session-handler/runtime-registry.js'

const logger = createLogger('ACT_BTN')
const PENDING_TTL_MS = 24 * 60 * 60 * 1000

export type ActionButtonColor = 'white' | 'blue' | 'green' | 'red'

export type ActionButtonOption = {
  label: string
  color?: ActionButtonColor
}

export type ActionButtonsRequest = {
  sessionId: string
  threadId: string
  directory: string
  buttons: ActionButtonOption[]
}

const pendingActionButtonRequests = new Map<string, ActionButtonsRequest>()
const pendingActionButtonRequestWaiters = new Map<
  string,
  (request: ActionButtonsRequest) => void
>()

export function queueActionButtonsRequest(request: ActionButtonsRequest): void {
  pendingActionButtonRequests.set(request.sessionId, request)
  const waiter = pendingActionButtonRequestWaiters.get(request.sessionId)
  if (!waiter) {
    return
  }
  pendingActionButtonRequestWaiters.delete(request.sessionId)
  waiter(request)
}

export async function waitForQueuedActionButtonsRequest({
  sessionId,
  timeoutMs,
}: {
  sessionId: string
  timeoutMs: number
}): Promise<ActionButtonsRequest | undefined> {
  const queued = pendingActionButtonRequests.get(sessionId)
  if (queued) {
    pendingActionButtonRequests.delete(sessionId)
    return queued
  }

  return await new Promise<ActionButtonsRequest | undefined>((resolve) => {
    const timeout = setTimeout(() => {
      const currentWaiter = pendingActionButtonRequestWaiters.get(sessionId)
      if (!currentWaiter || currentWaiter !== onRequest) {
        return
      }
      pendingActionButtonRequestWaiters.delete(sessionId)
      resolve(undefined)
    }, timeoutMs)

    const onRequest = (request: ActionButtonsRequest) => {
      clearTimeout(timeout)
      pendingActionButtonRequests.delete(sessionId)
      resolve(request)
    }

    pendingActionButtonRequestWaiters.set(sessionId, onRequest)
  })
}

function toButtonStyle(color?: ActionButtonColor): ButtonStyle {
  if (color === 'blue') {
    return ButtonStyle.Primary
  }
  if (color === 'green') {
    return ButtonStyle.Success
  }
  if (color === 'red') {
    return ButtonStyle.Danger
  }
  return ButtonStyle.Secondary
}

async function updateButtonMessage({
  context,
  status,
  channel,
}: {
  context: PendingActionButtons
  status: string
  channel: ThreadChannel | TextChannel
}): Promise<void> {
  try {
    const message = await channel.messages.fetch(context.message_id)
    await message.edit({
      content: `**Action Required**\n${status}`,
      components: [],
    })
  } catch {
    // Deleted or inaccessible Discord messages must not prevent cleanup.
  }
}

async function sendClickedActionToModel({
  interaction,
  thread,
  prompt,
}: {
  interaction: ButtonInteraction
  thread: ThreadChannel | TextChannel
  prompt: string
}): Promise<void> {
  const resolved = await resolveWorkingDirectory({ channel: thread })
  if (!resolved) {
    throw new Error('Could not resolve project directory for thread')
  }

  const username = interaction.user.globalName || interaction.user.username

  // Action button clicks submit directly to the session.
  const runtime = thread.type === ChannelType.GuildText
    ? getOrCreateRuntime({
        threadId: thread.id,
        chat: createDiscordChatChannel(thread),
        projectDirectory: resolved.projectDirectory,
        sdkDirectory: resolved.workingDirectory,
        channelId: thread.id,
      })
    : getOrCreateRuntime({
        threadId: thread.id,
        thread,
        projectDirectory: resolved.projectDirectory,
        sdkDirectory: resolved.workingDirectory,
        channelId: thread.parentId || thread.id,
      })
  await runtime.enqueueIncoming({
    prompt,
    userId: interaction.user.id,
    username,
    mode: 'direct',
  })
}

export async function showActionButtons({
  thread,
  sessionId,
  directory,
  buttons,
  silent,
}: {
  thread: ThreadChannel
  sessionId: string
  directory: string
  buttons: ActionButtonOption[]
  /** Suppress notification when queue has pending items */
  silent?: boolean
}): Promise<void> {
  const safeButtons = buttons
    .slice(0, 3)
    .map((button) => {
      return {
        label: button.label.trim().slice(0, 80),
        color: button.color,
      }
    })
    .filter((button) => {
      return button.label.length > 0
    })

  if (safeButtons.length === 0) {
    throw new Error('No valid buttons to display')
  }

  const replaced = await deletePendingActionButtonsForThread(thread.id)
  for (const existing of replaced) {
    await updateButtonMessage({ context: existing, status: '_Replaced._', channel: thread })
  }

  const contextHash = crypto.randomBytes(8).toString('hex')

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...safeButtons.map((button, index) => {
      return new ButtonBuilder()
        .setCustomId(`action_button:${contextHash}:${index}`)
        .setLabel(button.label)
        .setStyle(toButtonStyle(button.color))
    }),
  )

  try {
    const message = await thread.send({
      content: '**Action Required**',
      components: [row],
      flags: silent ? SILENT_MESSAGE_FLAGS : NOTIFY_MESSAGE_FLAGS,
    })

    await insertPendingActionButtons({
      context_hash: contextHash,
      session_id: sessionId,
      thread_id: thread.id,
      directory,
      message_id: message.id,
      buttons: safeButtons,
      expires_at: new Date(Date.now() + PENDING_TTL_MS),
    })
    logger.log(
      `Showed ${safeButtons.length} action button(s) for session ${sessionId}`,
    )
  } catch (error) {
    throw new Error('Failed to send action buttons', { cause: error })
  }
}

export async function handleActionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('action_button:')) {
    return
  }

  const [, contextHash, indexPart] = customId.split(':')
  if (!contextHash || !indexPart) {
    await replyOrEditInteraction(interaction, 'Invalid action button.')
    return
  }

  const context = await getPendingActionButtons(contextHash)
  if (!context) {
    await replyOrEditInteraction(interaction, 'This action is no longer available.')
    return
  }

  if (context.expires_at.getTime() <= Date.now()) {
    if (await deletePendingActionButtons(contextHash)) {
      await interaction.editReply({
        content: '**Action Required**\n_Expired_',
        components: [],
      })
    }
    return
  }

  const buttonIndex = Number.parseInt(indexPart, 10)
  const button = context.buttons[buttonIndex]
  if (!button) {
    await replyOrEditInteraction(interaction, 'This action is no longer available.')
    return
  }

  // The interaction listener already acknowledged the click (deferUpdate).
  const claimed = await deletePendingActionButtons(contextHash)
  if (!claimed) {
    return
  }

  const channel = interaction.channel ?? await interaction.client.channels.fetch(context.thread_id)
  // Inline channel conversations (`threads: none`) host buttons directly.
  const thread =
    channel?.isThread() ||
    (channel?.type === ChannelType.GuildText && channelUsesChannelConversation(channel.id))
      ? channel
      : undefined
  if (!thread) {
    logger.warn('[ACTION] Button clicked outside thread channel')
    await interaction.editReply({
      content: '**Action Required**\n_This action is no longer available._',
      components: [],
    })
    return
  }

  const currentSessionId = await getThreadSession(thread.id)
  if (!currentSessionId || currentSessionId !== context.session_id) {
    await interaction.editReply({
      content: '**Action Required**\n_Expired due to session change._',
      components: [],
    })
    return
  }

  await interaction.editReply({
    content: `**Action Required**\n_Selected: ${button.label}_`,
    components: [],
  })

  const username = interaction.user.globalName || interaction.user.username
  const prompt = `User clicked: ${button.label}`

  await sendThreadMessage(
    thread,
    `${QUEUE_PREFIX}**${username}:** ${button.label}`,
  )

  try {
    await sendClickedActionToModel({
      interaction,
      thread,
      prompt,
    })
  } catch (error) {
    logger.error('[ACTION] Failed to send click to model:', error)
    void notifyError(error, 'Action button click send to model failed')
    await sendThreadMessage(
      thread,
      `Failed to send action click: ${error instanceof Error ? error.message : String(error)}`,
      { flags: NOTIFY_MESSAGE_FLAGS },
    )
  }
}
