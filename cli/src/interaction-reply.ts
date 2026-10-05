import { MessageFlags, type RepliableInteraction } from 'discord.js'

/** Complete an early deferred reply, or send an initial ephemeral response. */
export async function replyOrEditInteraction(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred) {
    await interaction.editReply({ content })
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral })
  }
}
