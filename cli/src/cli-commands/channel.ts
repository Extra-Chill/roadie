// Read-only channel commands (roadie#202): list a guild's channels, read recent
// messages, and inspect the webhooks that post into a channel. Agent tool
// shells relay through the running bot; the bot token never leaves it.
import { goke } from 'goke'
import { z } from 'zod'
import { createLogger, LogPrefix } from '../logger.js'
import { initDatabase } from '../discord-bot.js'
import { createDiscordRest } from '../discord-urls.js'
import { EXIT_NO_RESTART, resolveBotCredentials } from '../cli-runner.js'
import { DiscordApiError } from '../errors.js'
import {
  CHANNEL_READ_DEFAULT_LIMIT,
  formatMessageLine,
  listChannelWebhooks,
  listGuildChannels,
  readChannelMessages,
} from '../discord-channel-reads.js'
import {
  AGENT_CHANNEL_MESSAGES_PATH,
  AGENT_CHANNEL_WEBHOOKS_PATH,
  AGENT_CHANNELS_PATH,
  channelListQuery,
  channelReadQuery,
  channelWebhooksQuery,
  resolveAgentCredentials,
  runAgentCommand,
  type AgentCommandRequest,
} from '../agent-remote.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

type Exit = (code: number) => never

/** Relay through the bot when running in an agent tool shell; returns only in operator shells. */
async function relayIfAgent(request: AgentCommandRequest, exit: Exit): Promise<void> {
  const agent = resolveAgentCredentials()
  if (agent instanceof Error) return
  exit(await runAgentCommand({ agent, request }))
}

async function operatorRest() {
  await initDatabase()
  const { token } = await resolveBotCredentials({})
  return createDiscordRest(token)
}

function failOn<T>(result: T | DiscordApiError, exit: Exit): T {
  if (result instanceof DiscordApiError) {
    cliLogger.error(result.message)
    exit(EXIT_NO_RESTART)
  }
  return result as T
}

function requireOption(value: string | undefined, message: string, exit: Exit): string {
  if (!value) {
    cliLogger.error(message)
    exit(EXIT_NO_RESTART)
  }
  return value as string
}

function reportError(error: unknown, exit: Exit): never {
  cliLogger.error('Error:', error instanceof Error ? error.stack : String(error))
  return exit(EXIT_NO_RESTART)
}

cli
  .command('channel list', 'List the channels and categories in a Discord guild the bot is in.')
  .option('-g, --guild <guildId>', 'Discord guild (server) ID')
  .option('--json', 'Output as JSON')
  .example('roadie channel list --guild 123456789012345678')
  .action(async (options, { console, process }) => {
    const exit = process.exit as Exit
    try {
      const guild = requireOption(options.guild, 'Guild ID is required. Use --guild <guildId>.', exit)
      await relayIfAgent(
        { method: 'GET', path: AGENT_CHANNELS_PATH, query: channelListQuery({ guild, json: options.json }) },
        exit,
      )
      const channels = failOn(await listGuildChannels({ rest: await operatorRest(), guildId: guild }), exit)
      if (options.json) {
        console.log(
          JSON.stringify(
            channels.map((channel) => ({
              channel_id: channel.id,
              name: channel.name,
              type: channel.type,
              parent_id: channel.parentId,
            })),
            null,
            2,
          ),
        )
        return exit(0)
      }
      if (channels.length === 0) {
        console.log(`No channels visible in guild ${guild}`)
        return exit(0)
      }
      for (const channel of channels) {
        const indent = channel.type === 'category' || !channel.parentId ? '' : '  '
        const label = channel.type === 'category' ? channel.name.toUpperCase() : `#${channel.name}`
        console.log(`${indent}${channel.id} | ${label} (${channel.type})`)
      }
      return exit(0)
    } catch (error) {
      reportError(error, exit)
    }
  })

cli
  .command('channel read', 'Read recent messages in a Discord channel or thread (oldest first).')
  .option('-c, --channel <channelId>', 'Discord channel or thread ID')
  .option(
    '--limit <n>',
    z.number().default(CHANNEL_READ_DEFAULT_LIMIT).describe('Messages to read (1-100)'),
  )
  .option('--before <messageId>', 'Only read messages older than this message ID')
  .option('--json', 'Output as JSON')
  .example('roadie channel read --channel 123456789012345678 --limit 10')
  .action(async (options, { console, process }) => {
    const exit = process.exit as Exit
    try {
      const channel = requireOption(options.channel, 'Channel ID is required. Use --channel <channelId>.', exit)
      await relayIfAgent(
        {
          method: 'GET',
          path: AGENT_CHANNEL_MESSAGES_PATH,
          query: channelReadQuery({
            channel,
            limit: options.limit,
            before: options.before,
            json: options.json,
          }),
        },
        exit,
      )
      const messages = failOn(
        await readChannelMessages({
          rest: await operatorRest(),
          channelId: channel,
          limit: options.limit,
          before: options.before,
        }),
        exit,
      )
      if (options.json) {
        console.log(
          JSON.stringify(
            messages.map((message) => ({
              message_id: message.id,
              timestamp: message.timestamp,
              author: message.author,
              author_id: message.authorId,
              bot: message.bot,
              webhook_id: message.webhookId,
              application_id: message.applicationId,
              content: message.content,
              embeds: message.embeds,
              attachments: message.attachments,
            })),
            null,
            2,
          ),
        )
        return exit(0)
      }
      if (messages.length === 0) {
        console.log(`No messages found in channel ${channel}`)
        return exit(0)
      }
      for (const message of messages) console.log(formatMessageLine(message))
      return exit(0)
    } catch (error) {
      reportError(error, exit)
    }
  })

cli
  .command(
    'channel webhooks',
    'List the webhooks that post into a Discord channel (name, creator, type). Never prints webhook tokens or URLs. Needs Manage Webhooks.',
  )
  .option('-c, --channel <channelId>', 'Discord channel ID')
  .option('--json', 'Output as JSON')
  .example('roadie channel webhooks --channel 123456789012345678')
  .action(async (options, { console, process }) => {
    const exit = process.exit as Exit
    try {
      const channel = requireOption(options.channel, 'Channel ID is required. Use --channel <channelId>.', exit)
      await relayIfAgent(
        {
          method: 'GET',
          path: AGENT_CHANNEL_WEBHOOKS_PATH,
          query: channelWebhooksQuery({ channel, json: options.json }),
        },
        exit,
      )
      const webhooks = failOn(
        await listChannelWebhooks({ rest: await operatorRest(), channelId: channel }),
        exit,
      )
      if (options.json) {
        console.log(
          JSON.stringify(
            webhooks.map((webhook) => ({
              webhook_id: webhook.id,
              name: webhook.name,
              type: webhook.type,
              channel_id: webhook.channelId,
              creator: webhook.creator,
              application_id: webhook.applicationId,
            })),
            null,
            2,
          ),
        )
        return exit(0)
      }
      if (webhooks.length === 0) {
        console.log(`No webhooks in channel ${channel}`)
        return exit(0)
      }
      for (const webhook of webhooks) {
        const creator = webhook.creator ? `, created by ${webhook.creator}` : ''
        console.log(`${webhook.id} | ${webhook.name} (${webhook.type}${creator})`)
      }
      return exit(0)
    } catch (error) {
      reportError(error, exit)
    }
  })

export default cli
