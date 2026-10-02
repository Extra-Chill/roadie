// Welcome message for the default roadie channel, posted once when the
// channel is first created.

import type { TextChannel } from 'discord.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.CHANNEL)

function buildWelcomeText({ mentionUserId }: { mentionUserId?: string }): string {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : ''
  return `${mention}**Roadie** connects this server to a coding agent. Send a message in a project channel to start a session in its own thread.
- \`/add-project\` links a channel to a project directory
- Upload images and files; the agent can send files back`
}

export async function sendWelcomeMessage({
  channel,
  mentionUserId,
}: {
  channel: TextChannel
  mentionUserId?: string
}): Promise<void> {
  try {
    await channel.send(buildWelcomeText({ mentionUserId }))
    logger.log(`Sent welcome message to #${channel.name}`)
  } catch (error) {
    logger.warn(
      `Failed to send welcome message to #${channel.name}: ${error instanceof Error ? error.stack : String(error)}`,
    )
  }
}
