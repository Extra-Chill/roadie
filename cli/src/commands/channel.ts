import { ChannelType, MessageFlags, type AutocompleteInteraction } from 'discord.js'
import type { CommandContext } from './types.js'
import { applicationBinding, channelBindingConfig, channelBehavior, resolveChannelPolicy, setApplicationChannelBinding, type ChannelBehavior } from '../channel-policy.js'
import { hasRoadieAdminPermission } from '../discord-utils.js'
import { disposeRuntime, getRuntimeThreadIdsForChannel } from '../session-handler/runtime-registry.js'

export async function handleChannelAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const query = interaction.options.getFocused().toLowerCase()
  const projects = Object.keys(channelBindingConfig()?.projects ?? {})
  await interaction.respond(projects.filter((name) => name.toLowerCase().includes(query)).slice(0, 25)
    .map((name) => ({ name, value: name })))
}

/** Bootstrap only in a guild already represented by explicit configuration. */
export async function isApplicationGuild(interaction: Pick<CommandContext['command'], 'client' | 'guildId'>): Promise<boolean> {
  const application = applicationBinding()
  if (!interaction.guildId) return false
  const ids = application ? [application.channel] : Object.keys(channelBindingConfig()?.channels ?? {}).filter((id) => id !== '*')
  for (const id of ids) {
    const channel = await interaction.client.channels.fetch(id).catch(() => null)
    if (application
      ? channel?.type === ChannelType.GuildText && channel.guildId === interaction.guildId
      : channel && 'guildId' in channel && channel.guildId === interaction.guildId) return true
  }
  return false
}

export async function handleChannelCommand({ command }: CommandContext): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  // The operator's authority is independent of the channel being enabled.
  // Passing an unbound channel to the capability gate would prevent bootstrap.
  if (!hasRoadieAdminPermission(command.member, command.guild)) {
    await command.editReply('Only Roadie administrators can bind or unbind application channels')
    return
  }
  const application = applicationBinding()
  if (!application && !Object.keys(channelBindingConfig()?.projects ?? {}).length) {
    await command.editReply('Channels config has no projects or application block; configure one before binding channels')
    return
  }
  if (!(await isApplicationGuild(command))) {
    await command.editReply('No configured channel or category belongs to this server; add one to the channels config first')
    return
  }
  const id = command.options.getChannel('channel')?.id ?? command.channelId
  const channel = await command.client.channels.fetch(id).catch(() => null)
  if (channel?.type !== ChannelType.GuildText || channel.guildId !== command.guildId) {
    await command.editReply('Choose an existing text channel in this server, or run the command in that channel')
    return
  }
  const subcommand = command.options.getSubcommand()
  const behavior = command.options.getString('behavior', subcommand === 'behavior') as ChannelBehavior | null
  const bound = subcommand !== 'unbind' && behavior !== 'off'
  const result = await setApplicationChannelBinding({ channelId: channel.id, bound, application, behavior: behavior ?? undefined, project: command.options.getString('project') ?? undefined })
  if (result instanceof Error) {
    await command.editReply(result.message)
    return
  }
  if (!bound || (behavior && result.changed)) {
    for (const threadId of getRuntimeThreadIdsForChannel(channel.id)) {
      disposeRuntime(threadId, { abortActiveRun: true })
    }
  }
  const active = channelBehavior(resolveChannelPolicy(channel.id))
  await command.editReply(bound
    ? `${result.changed ? 'Bound' : 'Already bound:'} <#${channel.id}> to ${application ? 'this application' : `project **${resolveChannelPolicy(channel.id)?.project}**`}. Behavior: **${active}**.${application ? ` Sessions use \`${application.directory}\`.` : ''}`
    : `${result.changed ? 'Unbound' : 'Already unbound:'} <#${channel.id}>. Behavior: **${active}**. Roadie will not respond here or in its threads. Channel and session history are preserved.`)
}
