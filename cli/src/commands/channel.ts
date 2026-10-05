import { ChannelType, MessageFlags } from 'discord.js'
import type { CommandContext } from './types.js'
import { applicationBinding, setApplicationChannelBinding } from '../channel-policy.js'
import { hasRoadieAdminPermission } from '../discord-utils.js'
import { disposeRuntime, getRuntimeThreadIdsForChannel } from '../session-handler/thread-session-runtime.js'

/** Bootstrap only in the guild already owned by the application's default. */
export async function isApplicationGuild(interaction: Pick<CommandContext['command'], 'client' | 'guildId'>): Promise<boolean> {
  const application = applicationBinding()
  if (!application || !interaction.guildId) return false
  const channel = await interaction.client.channels.fetch(application.channel).catch(() => null)
  return channel?.type === ChannelType.GuildText && channel.guildId === interaction.guildId
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
  if (!application || !(await isApplicationGuild(command))) {
    await command.editReply('This server is not configured for this Roadie application')
    return
  }
  const id = command.options.getChannel('channel')?.id ?? command.channelId
  const channel = await command.client.channels.fetch(id).catch(() => null)
  if (channel?.type !== ChannelType.GuildText || channel.guildId !== command.guildId) {
    await command.editReply('Choose an existing text channel in this server, or run the command in that channel')
    return
  }
  const bound = command.options.getSubcommand() === 'bind'
  const result = await setApplicationChannelBinding({ channelId: channel.id, bound, application })
  if (result instanceof Error) {
    await command.editReply(result.message)
    return
  }
  if (!bound) {
    for (const threadId of getRuntimeThreadIdsForChannel(channel.id)) {
      disposeRuntime(threadId, { abortActiveRun: true })
    }
  }
  await command.editReply(bound
    ? `${result.changed ? 'Bound' : 'Already bound:'} <#${channel.id}> to this application. Sessions use \`${application.directory}\` and the application default context.`
    : `${result.changed ? 'Unbound' : 'Already unbound:'} <#${channel.id}>. Roadie will not respond here or in its threads. Channel and session history are preserved.`)
}
