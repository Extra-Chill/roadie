// MCP form elicitation dialog — Discord side of person MCP form approvals.
//
// A person-scoped MCP server answered a tools/call with a form elicitation;
// the backend turned it into `form.asked`. This module renders the server's
// message verbatim with Accept / Decline / Cancel buttons plus one select
// (choice/boolean) or modal text input (string/number) per schema field.
//
// Consent integrity:
// - The decision goes to the backend's replyForm and never through permission
//   rules; the backend refuses anyone but the asking person, and this module
//   shows that refusal ephemerally.
// - Selections are recorded per person, so a bystander clicking around cannot
//   shape the answer the speaker submits.
// - An unrenderable schema never shows buttons: it is answered cancel and the
//   tool result explains why (the extension already refuses to ask; this is
//   the belt to its braces).

import crypto from 'node:crypto'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
} from 'discord.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import type { AgentFormRequest } from '../agent-backend/events.js'
import { IDENTITY_LOOKUP_FAILED_MESSAGE, isIdentityConfigured, resolvePerson } from '../identity.js'
import { personKeyFrom } from '../credentials/person-pool.js'
import { getThreadSession } from '../database.js'
import { parseFormSchema, type NativeFormField } from '../agent-backend/pi/mcp-native.js'
import { QUEUE_PREFIX } from '../message-formatting.js'
import { createLogger } from '../logger.js'
import { displayServerName } from '../person-mcp-name.js'

/** The server name a person sees, without the per-person scope hash. */
export { displayServerName }
import { replyOrEditInteraction } from '../interaction-reply.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  SILENT_MESSAGE_FLAGS,
  sendThreadMessage,
} from '../discord-utils.js'

const logger = createLogger('MCP_FORM')

export const MCP_FORM_BUTTON_PREFIX = 'mcp_form:'
export const MCP_FORM_FIELD_PREFIX = 'mcp_form_field:'
export const MCP_FORM_MODAL_PREFIX = 'mcp_form_modal:'

type PendingMcpFormContext = {
  contextHash: string
  sessionId: string
  directory: string
  thread: ThreadChannel
  requestId: string
  server: string
  tool: string
  message: string
  fields: NativeFormField[]
  /** Selections per person key, so only the speaker's own choices are submitted. */
  selections: Map<string, Record<string, unknown>>
  messageId?: string
  resolved: boolean
}

// No TTL on purpose: the backend's form timeout answers cancel and the
// runtime dismisses the dialog through form.replied. Cleanup happens on
// answer, on that dismissal, and on session change.
export const pendingMcpFormContexts = new Map<string, PendingMcpFormContext>()

/** A form belongs to the session it was asked in; a session change expires it. */
async function sessionChanged(context: PendingMcpFormContext): Promise<boolean> {
  const current = await getThreadSession(context.thread.id)
  return current !== context.sessionId
}

export function findPendingMcpFormContextForRequest({
  threadId,
  requestId,
}: {
  threadId: string
  requestId: string
}): PendingMcpFormContext | undefined {
  return [...pendingMcpFormContexts.values()].find((context) => context.thread.id === threadId && context.requestId === requestId)
}

/** Claim a form so only one answer reaches the backend; the loser is a no-op. */
function claimContext(context: PendingMcpFormContext): boolean {
  if (context.resolved) return false
  context.resolved = true
  pendingMcpFormContexts.delete(context.contextHash)
  return true
}

/** Put a claimed form back after a refusal, so the right person can still answer. */
function unclaimContext(context: PendingMcpFormContext): void {
  context.resolved = false
  pendingMcpFormContexts.set(context.contextHash, context)
}


/** Show the server's form: message verbatim, one select per choice field, then Accept/Decline/Cancel. */
export async function showMcpFormDialog({
  thread,
  sessionId,
  directory,
  requestId,
  request,
  silent,
}: {
  thread: ThreadChannel
  sessionId: string
  directory: string
  requestId: string
  request: AgentFormRequest
  /** Suppress notification when the queue has pending items. */
  silent?: boolean
}): Promise<void> {
  if (findPendingMcpFormContextForRequest({ threadId: thread.id, requestId })) {
    logger.log(`Deduped MCP form ${requestId} for thread ${thread.id}`)
    return
  }
  const parsed = parseFormSchema(request.schema)
  if (!parsed.ok) {
    // The extension refuses to ask what it cannot render; if a form still
    // arrives unrenderable, cancel it instead of showing a wrong dialog.
    logger.warn(`Cancelling unrenderable MCP form ${requestId}: ${parsed.reason}`)
    await answerThroughBackend({ directory, requestId, action: 'cancel' })
    await sendThreadMessage(thread, `⚪ Cancelled an approval form from \`${displayServerName(request.server)}\` because ${parsed.reason}. Nothing was run.`, { flags: NOTIFY_MESSAGE_FLAGS })
    return
  }

  // A random key (ask-question's pattern): customId handlers split on `:`,
  // so the key itself must not contain one.
  const contextHash = crypto.randomBytes(8).toString('hex')
  const context: PendingMcpFormContext = {
    contextHash,
    sessionId,
    directory,
    thread,
    requestId,
    server: request.server,
    tool: request.tool,
    message: request.message,
    fields: parsed.fields,
    selections: new Map(),
    resolved: false,
  }
  pendingMcpFormContexts.set(contextHash, context)

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = parsed.fields
    .filter((field) => field.kind === 'select')
    .map((field, index) => {
      const options = field.kind === 'select' ? field.options : []
      const select = new StringSelectMenuBuilder()
        .setCustomId(`${MCP_FORM_FIELD_PREFIX}${contextHash}:${index}`)
        .setPlaceholder(`${field.title.slice(0, 100)}${field.required ? ' (required)' : ' (optional)'}`)
        .addOptions(options.map((option) => ({
          label: option.label.slice(0, 100),
          value: option.value,
        })))
      return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
    })
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MCP_FORM_BUTTON_PREFIX}${contextHash}:accept`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${MCP_FORM_BUTTON_PREFIX}${contextHash}:decline`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${MCP_FORM_BUTTON_PREFIX}${contextHash}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  ))

  try {
    const message = await thread.send({
      content: [
        `**Approval needed** — \`${displayServerName(context.server)}\` asks before its \`${context.tool}\` runs:`,
        context.message,
        ...(context.fields.some((field) => field.kind === 'text') ? ['_Accept opens a short form for the text fields._'] : []),
      ].join('\n\n'),
      components: rows,
      flags: silent ? SILENT_MESSAGE_FLAGS : NOTIFY_MESSAGE_FLAGS,
    })
    context.messageId = message.id
  } catch (error) {
    pendingMcpFormContexts.delete(contextHash)
    logger.error('Failed to send MCP form dialog:', error)
    // Without a visible dialog the person cannot ever answer, so cancel:
    // the server runs nothing.
    await answerThroughBackend({ directory, requestId, action: 'cancel' })
    await sendThreadMessage(thread, '⚪ The approval form could not be posted, so it was cancelled. Nothing was run.', { flags: NOTIFY_MESSAGE_FLAGS })
  }
}

/** Record a select choice under the clicking person's own key. */
export async function handleMcpFormFieldSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, contextHash, indexPart] = interaction.customId.split(':')
  const context = contextHash ? pendingMcpFormContexts.get(contextHash) : undefined
  const fieldIndex = Number.parseInt(indexPart ?? '', 10)
  const field = context?.fields.filter((entry) => entry.kind === 'select')[fieldIndex]
  if (!context || context.resolved || field?.kind !== 'select') {
    await interaction.followUp({ content: 'This form is no longer available.', flags: MessageFlags.Ephemeral })
    return
  }
  const clicker = await clickerPersonKey(interaction)
  if (clicker instanceof Error) {
    await interaction.followUp({ content: clicker.message, flags: MessageFlags.Ephemeral })
    return
  }
  const value = interaction.values[0]
  const option = field.options.find((entry) => entry.value === value)
  if (!option) {
    await interaction.followUp({ content: 'That choice is not part of this form.', flags: MessageFlags.Ephemeral })
    return
  }
  const selections = context.selections.get(clicker) ?? {}
  selections[field.name] = option.content
  context.selections.set(clicker, selections)
  await interaction.followUp({ content: `Recorded **${field.title}** = **${option.label}**.`, flags: MessageFlags.Ephemeral })
}

/** Accept / Decline / Cancel buttons. */
export async function handleMcpFormButton(interaction: ButtonInteraction): Promise<void> {
  const [, contextHash, actionPart] = interaction.customId.split(':')
  const context = contextHash ? pendingMcpFormContexts.get(contextHash) : undefined
  const action = actionPart === 'accept' || actionPart === 'decline' || actionPart === 'cancel' ? actionPart : undefined
  if (!contextHash || !context || context.resolved || !action) {
    await interaction.followUp({ content: 'This form is no longer available.', flags: MessageFlags.Ephemeral })
    return
  }
  if (await sessionChanged(context)) {
    await editFormMessage(context, 'This form expired with its session.')
    await interaction.followUp({ content: 'This form expired with its session.', flags: MessageFlags.Ephemeral })
    return
  }
  const clicker = await clickerPersonKey(interaction)
  if (clicker instanceof Error) {
    await interaction.followUp({ content: clicker.message, flags: MessageFlags.Ephemeral })
    return
  }

  if (action === 'accept') {
    const missing = context.fields.filter((field) => field.kind === 'select' && field.required && !(field.name in (context.selections.get(clicker) ?? {})))
    if (missing.length > 0) {
      await interaction.followUp({ content: `Choose a value for ${missing.map((field) => `**${field.title}**`).join(', ')} first.`, flags: MessageFlags.Ephemeral })
      return
    }
    const textFields = context.fields.filter((field): field is Extract<NativeFormField, { kind: 'text' }> => field.kind === 'text')
    if (textFields.length > 0) {
      // Text answers ride a modal: show it; the modal submit completes the accept.
      await interaction.showModal(buildTextFieldsModal({ contextHash, message: context.message, fields: textFields }))
      return
    }
    await answerPendingForm({ interaction, context, action, content: context.selections.get(clicker) ?? {}, personKey: clicker })
    return
  }
  await answerPendingForm({ interaction, context, action, personKey: clicker })
}

/** Modal submit for a form's text fields; completes the accept. */
export async function handleMcpFormModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const contextHash = interaction.customId.slice(MCP_FORM_MODAL_PREFIX.length)
  const context = contextHash ? pendingMcpFormContexts.get(contextHash) : undefined
  if (!context || context.resolved) {
    await interaction.reply({ content: 'This form is no longer available.', flags: MessageFlags.Ephemeral })
    return
  }
  const clicker = await clickerPersonKey(interaction)
  if (clicker instanceof Error) {
    await interaction.reply({ content: clicker.message, flags: MessageFlags.Ephemeral })
    return
  }
  const content: Record<string, unknown> = { ...(context.selections.get(clicker) ?? {}) }
  for (const field of context.fields) {
    if (field.kind !== 'text') continue
    let raw = ''
    try {
      raw = interaction.fields.getTextInputValue(field.name)
    } catch {
      raw = ''
    }
    if (raw === '') {
      if (field.required) {
        await interaction.reply({ content: `**${field.title}** is required.`, flags: MessageFlags.Ephemeral })
        return
      }
      continue
    }
    if (field.inputType !== 'string') {
      const number = Number(raw)
      if (!Number.isFinite(number) || (field.inputType === 'integer' && !Number.isInteger(number))) {
        await interaction.reply({ content: `**${field.title}** needs a${field.inputType === 'integer' ? 'n integer' : ' number'}.`, flags: MessageFlags.Ephemeral })
        return
      }
      content[field.name] = number
      continue
    }
    content[field.name] = raw
  }
  await answerPendingForm({ interaction, context, action: 'accept', content, personKey: clicker })
}

/** Send the answer to the backend, claim the form first, and update the message. */
async function answerPendingForm({ interaction, context, action, content, personKey }: {
  interaction: ButtonInteraction | ModalSubmitInteraction
  context: PendingMcpFormContext
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  personKey: string
}): Promise<void> {
  // Claim before the call: form.replied races the reply's resolution, and the
  // loser of the claim must not edit the message twice.
  if (!claimContext(context)) return
  const result = await answerThroughBackend({ directory: context.directory, requestId: context.requestId, action, content, personKey })
  if (result instanceof Error) {
    // Refused (not the asking person, or the form is gone): the ephemeral
    // refusal is the clicker's only feedback; the form stays for its person.
    unclaimContext(context)
    await replyOrEditInteraction(interaction, result.message)
    return
  }
  const username = interaction.user.globalName || interaction.user.username
  if (action !== 'cancel') {
    await sendThreadMessage(context.thread, `${QUEUE_PREFIX}**${username}:** ${outcomeText(action)}`, { flags: NOTIFY_MESSAGE_FLAGS })
  }
  await editFormMessage(context, `${outcomeText(action)} _(${username})_`)
  await replyOrEditInteraction(interaction, outcomeText(action))
}

async function answerThroughBackend({ directory, requestId, action, content, personKey }: {
  directory: string
  requestId: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  personKey?: string
}): Promise<void | Error> {
  const client = getAgentBackendProvider().getBackend(directory)
  const replyForm = client?.sessions.replyForm
  if (!replyForm) return new Error('MCP forms are not supported here.')
  const result = await replyForm.call(client.sessions, { requestId, directory, action, ...(content && { content }), ...(personKey && { personKey }) })
  return result instanceof Error ? result : undefined
}

function outcomeText(action: 'accept' | 'decline' | 'cancel'): string {
  if (action === 'accept') return '✓ Approved — the server is running the operation.'
  if (action === 'decline') return '✗ Declined — the server was told no.'
  return '⚪ Cancelled — nothing was run.'
}

async function editFormMessage(context: PendingMcpFormContext, status: string): Promise<void> {
  if (!context.messageId) return
  try {
    const message = await context.thread.messages.fetch(context.messageId)
    await message.edit({
      content: `**Approval needed** — \`${displayServerName(context.server)}\` asked before its \`${context.tool}\` runs:\n\n${context.message}\n\n${status}`,
      components: [],
    })
  } catch (error) {
    logger.warn('Could not update MCP form message:', error)
  }
}

/**
 * The person key of the clicking user, resolved the same way turns resolve
 * theirs (the identity layer). Consent comes from this, never from the form
 * message: a form forwarded or clicked by someone else acts on their key and
 * is refused by the backend unless it matches the asking person.
 */
async function clickerPersonKey(interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction): Promise<string | Error> {
  if (!isIdentityConfigured()) return new Error('Per-person services are not configured on this server.')
  const person = await resolvePerson({
    actor: { platform: 'discord', id: interaction.user.id, name: interaction.user.displayName },
    context: {
      ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
      ...(interaction.channelId ? { channelId: interaction.channelId } : {}),
    },
  })
  if (person?.lookupFailed) return new Error(IDENTITY_LOOKUP_FAILED_MESSAGE)
  const personKey = personKeyFrom({ personId: person?.personId, platform: 'discord', actorId: interaction.user.id })
  if (!personKey) return new Error('Could not resolve your account.')
  return personKey
}

function buildTextFieldsModal({ contextHash, message, fields }: {
  contextHash: string
  message: string
  fields: Array<Extract<NativeFormField, { kind: 'text' }>>
}): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${MCP_FORM_MODAL_PREFIX}${contextHash}`)
    .setTitle(message.trim().slice(0, 45) || 'Server question')
  for (const field of fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.name)
      .setLabel(field.title.slice(0, 45))
      .setStyle(field.inputType === 'string' && field.placeholder && field.placeholder.length > 40 ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required)
    if (field.placeholder) input.setPlaceholder(field.placeholder.slice(0, 100))
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
  }
  return modal
}

/** Expire a form's dialog when the backend answers it without a click (timeout, abort, platform without a form UI). */
export async function cancelPendingMcpFormsForRequest({ threadId, requestId, action }: {
  threadId: string
  requestId: string
  action: 'accept' | 'decline' | 'cancel'
}): Promise<boolean> {
  const context = findPendingMcpFormContextForRequest({ threadId, requestId })
  if (!context || !claimContext(context)) return false
  const suffix = action === 'cancel' ? 'The form expired or was aborted, so nothing was run.' : outcomeText(action)
  await editFormMessage(context, suffix)
  return true
}
