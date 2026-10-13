// Read-only Discord lookups the agent can run through the bot (roadie#202):
// list a guild's channels, read recent messages, and inspect the webhooks that
// post into a channel. The bot token stays in the bot process; webhook tokens
// and execution URLs are dropped here and never reach CLI output.
import { ChannelType, Routes, type REST } from 'discord.js'
import { DiscordApiError } from './errors.js'

export const CHANNEL_READ_DEFAULT_LIMIT = 20
export const CHANNEL_READ_MAX_LIMIT = 100

export type DiscordGuildChannel = {
  id: string
  name: string
  type: string
  parentId: string | null
  position: number
}

export type DiscordReadMessage = {
  id: string
  timestamp: string
  author: string
  authorId: string | null
  bot: boolean
  webhookId: string | null
  applicationId: string | null
  content: string
  embeds: Array<{ title?: string; url?: string; description?: string }>
  attachments: string[]
}

export type DiscordChannelWebhook = {
  id: string
  name: string
  type: string
  channelId: string | null
  creator: string | null
  applicationId: string | null
}

const CHANNEL_TYPE_NAMES: Partial<Record<number, string>> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'media',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildStageVoice]: 'stage',
}

const WEBHOOK_TYPE_NAMES: Record<number, string> = {
  1: 'incoming',
  2: 'channel-follower',
  3: 'application',
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

async function getJson({
  rest,
  route,
  query,
}: {
  rest: REST
  route: `/${string}`
  query?: URLSearchParams
}): Promise<unknown | DiscordApiError> {
  return rest.get(route, query ? { query } : undefined).catch((cause) => {
    return new DiscordApiError({
      status: String(Reflect.get(cause, 'status') ?? 'unknown'),
      body: `${route}: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    })
  })
}

export function parseGuildChannels(payload: unknown): DiscordGuildChannel[] {
  if (!Array.isArray(payload)) return []
  return payload
    .flatMap((raw) => {
      const channel = asRecord(raw)
      const id = asString(channel.id)
      const type = typeof channel.type === 'number' ? CHANNEL_TYPE_NAMES[channel.type] : undefined
      if (!id || !type) return []
      return [
        {
          id,
          name: asString(channel.name) ?? id,
          type,
          parentId: asString(channel.parent_id),
          position: typeof channel.position === 'number' ? channel.position : 0,
        },
      ]
    })
    .sort((left, right) => {
      // Categories first, then channels grouped under their category.
      const leftKey = left.type === 'category' ? left.id : (left.parentId ?? '')
      const rightKey = right.type === 'category' ? right.id : (right.parentId ?? '')
      if (leftKey !== rightKey) return leftKey.localeCompare(rightKey)
      if ((left.type === 'category') !== (right.type === 'category')) {
        return left.type === 'category' ? -1 : 1
      }
      return left.position - right.position
    })
}

export function parseChannelMessages(payload: unknown): DiscordReadMessage[] {
  if (!Array.isArray(payload)) return []
  return payload.flatMap((raw) => {
    const message = asRecord(raw)
    const id = asString(message.id)
    if (!id) return []
    const author = asRecord(message.author)
    const embeds = Array.isArray(message.embeds) ? message.embeds : []
    const attachments = Array.isArray(message.attachments) ? message.attachments : []
    return [
      {
        id,
        timestamp: asString(message.timestamp) ?? '',
        author: asString(author.global_name) ?? asString(author.username) ?? 'unknown',
        authorId: asString(author.id),
        bot: author.bot === true,
        webhookId: asString(message.webhook_id),
        applicationId: asString(message.application_id),
        content: typeof message.content === 'string' ? message.content : '',
        embeds: embeds.map((rawEmbed) => {
          const embed = asRecord(rawEmbed)
          return {
            ...(asString(embed.title) ? { title: asString(embed.title)! } : {}),
            ...(asString(embed.url) ? { url: asString(embed.url)! } : {}),
            ...(asString(embed.description) ? { description: asString(embed.description)! } : {}),
          }
        }),
        attachments: attachments.flatMap((rawAttachment) => {
          const url = asString(asRecord(rawAttachment).url)
          return url ? [url] : []
        }),
      },
    ]
  })
}

/**
 * Webhook records with their secrets removed. Discord returns `token` and
 * `url` (which embeds the token) to callers with Manage Webhooks; either is
 * enough to post as the webhook, so neither may leave this function.
 */
export function parseChannelWebhooks(payload: unknown): DiscordChannelWebhook[] {
  if (!Array.isArray(payload)) return []
  return payload.flatMap((raw) => {
    const webhook = asRecord(raw)
    const id = asString(webhook.id)
    if (!id) return []
    const user = asRecord(webhook.user)
    return [
      {
        id,
        name: asString(webhook.name) ?? id,
        type:
          typeof webhook.type === 'number'
            ? (WEBHOOK_TYPE_NAMES[webhook.type] ?? String(webhook.type))
            : 'unknown',
        channelId: asString(webhook.channel_id),
        creator: asString(user.global_name) ?? asString(user.username),
        applicationId: asString(webhook.application_id),
      },
    ]
  })
}

export async function listGuildChannels({
  rest,
  guildId,
}: {
  rest: REST
  guildId: string
}): Promise<DiscordGuildChannel[] | DiscordApiError> {
  const payload = await getJson({ rest, route: Routes.guildChannels(guildId) })
  if (payload instanceof DiscordApiError) return payload
  return parseGuildChannels(payload)
}

export function clampReadLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CHANNEL_READ_DEFAULT_LIMIT
  return Math.min(CHANNEL_READ_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}

export async function readChannelMessages({
  rest,
  channelId,
  limit,
  before,
}: {
  rest: REST
  channelId: string
  limit?: number
  before?: string
}): Promise<DiscordReadMessage[] | DiscordApiError> {
  const query = new URLSearchParams({ limit: String(clampReadLimit(limit)) })
  if (before) query.set('before', before)
  const payload = await getJson({ rest, route: Routes.channelMessages(channelId), query })
  if (payload instanceof DiscordApiError) return payload
  // Discord returns newest first; print oldest first so output reads like the channel.
  return parseChannelMessages(payload).reverse()
}

export const WEBHOOKS_FORBIDDEN_MESSAGE =
  'The bot cannot list webhooks in this channel: it needs the Manage Webhooks permission there.'

export async function listChannelWebhooks({
  rest,
  channelId,
}: {
  rest: REST
  channelId: string
}): Promise<DiscordChannelWebhook[] | DiscordApiError> {
  const payload = await getJson({ rest, route: Routes.channelWebhooks(channelId) })
  if (payload instanceof DiscordApiError) {
    if (payload.status === '403') {
      return new DiscordApiError({ status: '403', body: WEBHOOKS_FORBIDDEN_MESSAGE, cause: payload })
    }
    return payload
  }
  return parseChannelWebhooks(payload)
}

export function formatMessageLine(message: DiscordReadMessage): string {
  const via = message.webhookId ? ' [webhook]' : message.bot ? ' [bot]' : ''
  const parts = [message.content.trim()]
  for (const embed of message.embeds) {
    const embedText = [embed.title, embed.description, embed.url].filter(Boolean).join(' | ')
    if (embedText) parts.push(`[embed] ${embedText}`)
  }
  for (const attachment of message.attachments) parts.push(`[file] ${attachment}`)
  const body = parts.filter(Boolean).join('\n  ')
  return `${message.timestamp} ${message.author}${via} (${message.id}):\n  ${body || '(no content)'}`
}
