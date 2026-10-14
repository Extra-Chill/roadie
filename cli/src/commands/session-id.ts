// /session-id command - Show the current session ID, Discord thread ID and working directory.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.SESSION)

export async function handleSessionIdCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { workingDirectory } = resolved
  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: `No active session in this thread\n**Thread ID:** \`${channel.id}\``,
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.reply({
    content: `**Session ID:** \`${sessionId}\`\n**Thread ID:** \`${channel.id}\`\n**Directory:** \`${workingDirectory}\``,
    flags: SILENT_MESSAGE_FLAGS,
  })
  logger.log(`Session ID shown for thread ${channel.id}: ${sessionId}`)
}
