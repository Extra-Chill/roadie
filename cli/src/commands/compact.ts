// /compact command - Trigger context compaction (summarization) for the current session.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import { AgentRequestError } from '../agent-backend/types.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.COMPACT)

export async function handleCompactCommand({
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

  const { projectDirectory, workingDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Ensure server is running for the base project directory
  const provider = getAgentBackendProvider()
  const getBackend = await provider.initializeForDirectory(projectDirectory)
  if (getBackend instanceof Error) {
    await command.reply({
      content: `Failed to compact: ${getBackend.message}`,
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const client = provider.getBackend(workingDirectory)
  if (!client?.sessions.summarize) {
    await command.reply({
      content: 'Failed to get OpenCode client',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Defer reply since compaction may take a moment
  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    // Get session messages to find the model from the last user message
    const messagesResult = await client.sessions.messages({
      sessionId,
      directory: workingDirectory,
    })
    // A transport failure was thrown into the catch below before; keep that.
    if (messagesResult instanceof Error && !(messagesResult instanceof AgentRequestError)) {
      throw messagesResult
    }
    if (messagesResult instanceof Error) {
      logger.error('[COMPACT] Failed to get messages:', messagesResult)
      await command.editReply({
        content: 'Failed to compact: Could not retrieve session messages',
      })
      return
    }

    // Find the last user message to get the model
    const lastUserMessage = [...messagesResult]
      .reverse()
      .map((entry) => entry.message)
      .find((message) => message.role === 'user')

    if (!lastUserMessage?.model) {
      await command.editReply({
        content: 'Failed to compact: No user message found in session',
      })
      return
    }

    const result = await client.sessions.summarize({
      sessionId,
      directory: workingDirectory,
      model: { providerId: lastUserMessage.model.providerId, modelId: lastUserMessage.model.modelId },
    })
    if (result instanceof Error && !(result instanceof AgentRequestError)) {
      throw result
    }
    if (result instanceof Error) {
      logger.error('[COMPACT] Error:', result)
      await command.editReply({
        content: `Failed to compact: ${result.message}`,
      })
      return
    }

    await command.editReply({
      content: `📦 Session **compacted** successfully`,
    })
    logger.log(`Session ${sessionId} compacted by user`)
  } catch (error) {
    logger.error('[COMPACT] Error:', error)
    await command.editReply({
      content: `Failed to compact: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
