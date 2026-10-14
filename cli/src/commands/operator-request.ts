import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type Client } from 'discord.js'
import { getThreadIdBySessionId } from '../database.js'
import { hasRoadieAdminPermission } from '../discord-utils.js'
import { decideOperatorRequest, expireOperatorRequest, onOperatorRequestCreated, type OperatorRequest } from '../operator-requests.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.INTERACTION)
export const OPERATOR_REQUEST_PREFIX = 'operator_request:'

function promptContent(argv: string[]): string {
  const command = JSON.stringify(argv)
  const fence = '`'.repeat(Math.max(3, ...Array.from(command.matchAll(/`+/g), ([match]) => match.length + 1)))
  return `**Operator approval required**\nExact argv:\n${fence}json\n${command}\n${fence}`
}

/** Install once for the Discord bot, so every agent request has a prompt or expires. */
export function subscribeToOperatorRequests(client: Client): () => void {
  return onOperatorRequestCreated((request: OperatorRequest) => {
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
      await channel.send({
        content: promptContent(request.argv),
        allowedMentions: { parse: [] },
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${OPERATOR_REQUEST_PREFIX}approve:${request.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${OPERATOR_REQUEST_PREFIX}deny:${request.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
        )],
      })
    })().catch((error) => {
      expireOperatorRequest(request.id)
      logger.error('Could not post operator approval prompt:', error)
    })
  })
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
}
