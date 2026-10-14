import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type Client } from 'discord.js'
import { getThreadIdBySessionId } from '../database.js'
import { hasRoadieAdminPermission } from '../discord-utils.js'
import {
  attachOperatorRequestPrompt,
  consumeInterruptedOperatorRequests,
  decideOperatorRequest,
  expireOperatorRequest,
  onOperatorRequestCreated,
  onOperatorRequestFinished,
  type OperatorRequest,
  type OperatorRequestOutcome,
} from '../operator-requests.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.INTERACTION)
export const OPERATOR_REQUEST_PREFIX = 'operator_request:'

function fenced(text: string, lang = ''): string {
  const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), ([match]) => match.length + 1)))
  return `${fence}${lang}\n${text}\n${fence}`
}

function promptContent(argv: string[]): string {
  return `**Operator approval required**\nExact argv:\n${fenced(JSON.stringify(argv), 'json')}`
}

// Button status updates still in flight, by request id.
const decisionPosts = new Map<string, Promise<void>>()

const OUTPUT_SUMMARY_LINES = 6
const OUTPUT_SUMMARY_CHARS = 600

/** The last few lines of a command's output, enough to tell what happened. */
export function summarizeOutput(output: string): string {
  const lines = output.split('\n').map((line) => line.trimEnd()).filter(Boolean)
  let summary = lines.slice(-OUTPUT_SUMMARY_LINES).join('\n')
  if (summary.length > OUTPUT_SUMMARY_CHARS) summary = `…${summary.slice(-OUTPUT_SUMMARY_CHARS)}`
  return summary
}

/** The prompt after an approved request finished: who approved it and how it ended. */
export function outcomeContent(request: Pick<OperatorRequest, 'argv' | 'approverId'>, outcome: OperatorRequestOutcome): string {
  const approved = `approved by <@${request.approverId ?? 'unknown'}>.`
  if ('interrupted' in outcome) {
    return `${promptContent(request.argv)}\nStatus: ${approved} Interrupted by a Roadie restart before it finished; it did not complete.`
  }
  const summary = summarizeOutput(outcome.output)
  return `${promptContent(request.argv)}\nStatus: ${approved} Finished with exit ${outcome.exitCode}.` +
    (summary ? `\n${fenced(summary)}` : '')
}

async function editPrompt(client: Client, prompt: NonNullable<OperatorRequest['prompt']>, content: string): Promise<void> {
  const channel = await client.channels.fetch(prompt.threadId)
  if (!channel?.isTextBased()) return
  await channel.messages.edit(prompt.messageId, { content, components: [], allowedMentions: { parse: [] } })
}

/**
 * Called once when the bot is ready: approved requests the previous process
 * never finished were dropped by a restart. Mark their prompts interrupted.
 */
export async function reportInterruptedOperatorRequests(client: Client): Promise<number> {
  const interrupted = consumeInterruptedOperatorRequests()
  for (const request of interrupted) {
    if (!request.prompt) continue
    await editPrompt(client, request.prompt, outcomeContent(request, { interrupted: true })).catch((error) => {
      logger.warn(`Could not mark operator request ${request.id} interrupted: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return interrupted.length
}

/** Install once for the Discord bot, so every agent request has a prompt or expires. */
export function subscribeToOperatorRequests(client: Client): () => void {
  const unsubscribeFinished = onOperatorRequestFinished(async (request, outcome) => {
    if (!request.prompt) return
    await decisionPosts.get(request.id)
    await editPrompt(client, request.prompt, outcomeContent(request, outcome))
  })
  const unsubscribeCreated = onOperatorRequestCreated((request: OperatorRequest) => {
    void (async () => {
      const threadId = await getThreadIdBySessionId(request.sessionId)
      if (!threadId) {
        expireOperatorRequest(request.id)
        return
      }
      const channel = await client.channels.fetch(threadId)
      if (!channel?.isSendable()) {
        expireOperatorRequest(request.id)
        return
      }
      const message = await channel.send({
        content: promptContent(request.argv),
        allowedMentions: { parse: [] },
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${OPERATOR_REQUEST_PREFIX}approve:${request.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${OPERATOR_REQUEST_PREFIX}deny:${request.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
        )],
      })
      attachOperatorRequestPrompt(request.id, { threadId, messageId: message.id })
    })().catch((error) => {
      expireOperatorRequest(request.id)
      logger.error('Could not post operator approval prompt:', error)
    })
  })
  return () => {
    unsubscribeCreated()
    unsubscribeFinished()
  }
}

export async function handleOperatorRequestButton(interaction: ButtonInteraction): Promise<void> {
  if (!hasRoadieAdminPermission(interaction.member, interaction.guild)) {
    await interaction.reply({ content: 'Only a Roadie operator can decide this request.', flags: MessageFlags.Ephemeral })
    return
  }
  const match = /^operator_request:(approve|deny):([\w-]+)$/.exec(interaction.customId)
  if (!match) {
    await interaction.reply({ content: 'Invalid operator request.', flags: MessageFlags.Ephemeral })
    return
  }
  const [, decision, id] = match
  // Registered before deciding: an approved command can finish quickly, and
  // its outcome edit must land after this status update, not under it.
  let markPosted!: () => void
  decisionPosts.set(id!, new Promise<void>((resolve) => { markPosted = resolve }))
  try {
    let status: string
    try {
      const result = decideOperatorRequest({ id: id!, decision: decision as 'approve' | 'deny', approverId: interaction.user.id })
      status = `${result.state} by <@${interaction.user.id}>.`
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Operator request')) throw error
      status = 'Already decided or expired.'
    }
    await interaction.update({
      content: `${interaction.message.content.split('\nStatus:')[0]}\nStatus: ${status}`,
      components: [],
      allowedMentions: { parse: [] },
    })
  } finally {
    markPosted()
    decisionPosts.delete(id!)
  }
}
