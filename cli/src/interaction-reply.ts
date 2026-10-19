import {
  MessageFlags,
  type InteractionEditReplyOptions,
  type InteractionUpdateOptions,
  type MessageComponentInteraction,
  type RepliableInteraction,
} from 'discord.js'

/**
 * True when a component was acknowledged with deferUpdate(): the pending
 * "reply" is the component's own message, so editReply() rewrites it. A
 * deferReply() sets `ephemeral` to true or false instead.
 */
function deferredAsUpdate(interaction: RepliableInteraction): boolean {
  return interaction.deferred && interaction.ephemeral === null && interaction.isMessageComponent()
}

/**
 * Private notice for the user, whatever the interaction's state: an initial
 * ephemeral reply, the early deferred reply, or (after deferUpdate) an
 * ephemeral follow-up so the component's message is left alone.
 */
export async function replyOrEditInteraction(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || deferredAsUpdate(interaction)) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral })
  } else if (interaction.deferred) {
    await interaction.editReply({ content })
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral })
  }
}

/**
 * Rewrite a component's message (e.g. remove its buttons): update() as the
 * first response, editReply() once the listener has already deferred it.
 */
export async function updateComponentMessage(
  interaction: MessageComponentInteraction,
  options: InteractionUpdateOptions & InteractionEditReplyOptions,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(options)
  } else {
    await interaction.update(options)
  }
}
