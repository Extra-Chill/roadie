// /link command, Link buttons and the unprompted link prompt on Discord
// (issue #292). The flow itself lives in identity-link.ts.
//
//   /link                          start linking on demand (ephemeral)
//   roadie_link:<guild>:           Link button in a DM: acts for the clicker
//   roadie_link:<guild>:<user>     Link button posted in a channel (DM
//                                  fallback): only <user> may use it
//
// The guild id is context for the host's filters, never identity. Authority
// always comes from the clicking user: the actor is `interaction.user`, never
// anything the button carries. The channel fallback additionally refuses
// clickers other than the person it was posted for, so a public button cannot
// be used as someone else's prompt.
//
// The sign-in link and user code are only ever shown in an ephemeral reply to
// the clicker. Tokens are never logged or shown.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageCreateOptions,
  type User,
} from 'discord.js'
import {
  claimLinkPrompt,
  LINK_BUTTON_LABEL,
  linkPromptText,
  startIdentityLink,
  type IdentityLinkProvider,
} from '../identity-link.js'
import type { IdentityActor, IdentityContext, Person } from '../identity.js'
import { createLogger, LogPrefix } from '../logger.js'
import { welcomeDiscordUser } from './start.js'

const logger = createLogger(LogPrefix.DISCORD)

export const LINK_BUTTON_PREFIX = 'roadie_link:'
// Discord interaction tokens last 15 minutes; stop polling before the reply
// can no longer be edited.
const MAX_WAIT_MS = 14 * 60_000

// ── Button ids ──────────────────────────────────────────────────

export function linkButtonCustomId({ guildId, restrictTo }: { guildId?: string; restrictTo?: string }): string {
  return `${LINK_BUTTON_PREFIX}${guildId ?? ''}:${restrictTo ?? ''}`
}

export function parseLinkButtonCustomId(customId: string): { guildId?: string; restrictTo?: string } | null {
  if (!customId.startsWith(LINK_BUTTON_PREFIX)) return null
  const [guildId = '', restrictTo = '', ...rest] = customId.slice(LINK_BUTTON_PREFIX.length).split(':')
  if (rest.length > 0) return null
  const snowflake = /^\d{1,25}$/
  if (guildId && !snowflake.test(guildId)) return null
  if (restrictTo && !snowflake.test(restrictTo)) return null
  return { ...(guildId ? { guildId } : {}), ...(restrictTo ? { restrictTo } : {}) }
}

export function buildLinkButtonRow(options: { guildId?: string; restrictTo?: string }): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(linkButtonCustomId(options))
      .setLabel(LINK_BUTTON_LABEL)
      .setStyle(ButtonStyle.Primary),
  )
}

// ── Unprompted prompt (denied message) ──────────────────────────

/**
 * Offer the link prompt to a denied speaker, at most once per actor per
 * interval: a DM with a Link button, or, if DMs are closed, a channel reply
 * whose button only that speaker may use. Returns true when it replied in the
 * channel (the caller then skips its own denial reply). Never throws.
 */
export async function offerDiscordLinkPrompt({
  user,
  displayName,
  person,
  context,
  replyInChannel,
}: {
  user: Pick<User, 'id' | 'bot' | 'send'>
  displayName?: string
  person: Person | null | undefined
  context: IdentityContext
  replyInChannel: (payload: { content: string; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<unknown>
}): Promise<boolean> {
  try {
    const actor: IdentityActor = { platform: 'discord', id: user.id, ...(displayName ? { name: displayName } : {}) }
    const provider = await claimLinkPrompt({ actor, context, person, isBot: user.bot })
    if (!provider) return false
    const guildId = context.guildId
    const dm: MessageCreateOptions = {
      content: linkPromptText(provider),
      components: [buildLinkButtonRow({ ...(guildId ? { guildId } : {}) })],
    }
    const sent = await user.send(dm).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    if (!(sent instanceof Error)) {
      await replyInChannel({
        content: "You don't have access yet. I sent you a DM to link your account (or run `/link`).",
        components: [],
      })
      return true
    }
    logger.log(`[LINK] DM to ${user.id} failed; posting the link prompt in the channel`)
    await replyInChannel({
      content: channelPromptText(provider),
      components: [buildLinkButtonRow({ ...(guildId ? { guildId } : {}), restrictTo: user.id })],
    })
    return true
  } catch (error) {
    logger.warn(`[LINK] could not offer the link prompt: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function channelPromptText(provider: IdentityLinkProvider): string {
  return `${linkPromptText(provider)}\nOnly you can use this button; the sign-in link is shown only to you.`
}

// ── Handlers ────────────────────────────────────────────────────

function actorOf(interaction: ChatInputCommandInteraction | ButtonInteraction): IdentityActor {
  return { platform: 'discord', id: interaction.user.id, name: interaction.user.displayName }
}

async function runLink(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  context: IdentityContext,
): Promise<void> {
  const actor = actorOf(interaction)
  const started = await startIdentityLink({
    actor,
    context,
    isBot: interaction.user.bot,
    maxWaitMs: MAX_WAIT_MS,
    retryHint: 'Run `/link` to try again.',
    welcome: async (person) =>
      await welcomeDiscordUser({
        user: interaction.user,
        displayName: interaction.user.displayName,
        person,
        ...(context.channelId ? { channelId: context.channelId } : {}),
      }),
    onDone: async (outcome) => {
      await interaction.editReply({ content: outcome.text, components: [] }).catch((error: unknown) => {
        logger.warn(`[LINK] could not update sign-in reply: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
  })
  if (started instanceof Error) {
    await interaction.editReply({ content: started.message, components: [] })
    return
  }
  await interaction.editReply({
    content: started.text,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(started.link).setLabel('Open sign-in page'),
      ),
    ],
  })
}

export async function handleLinkCommand({ command }: { command: ChatInputCommandInteraction }): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  await runLink(command, {
    ...(command.guildId ? { guildId: command.guildId } : {}),
    ...(command.channelId ? { channelId: command.channelId } : {}),
  })
}

export async function handleLinkButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseLinkButtonCustomId(interaction.customId)
  if (!parsed) return
  if (parsed.restrictTo && parsed.restrictTo !== interaction.user.id) {
    await interaction.reply({
      content: 'This button is for someone else. Run `/link` to link your own account.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const guildId = interaction.guildId ?? parsed.guildId
  await runLink(interaction, {
    ...(guildId ? { guildId } : {}),
    ...(interaction.guildId && interaction.channelId ? { channelId: interaction.channelId } : {}),
  })
}
