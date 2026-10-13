import { ChannelType, type REST } from 'discord.js'
import { describe, expect, test } from 'vitest'
import { DiscordApiError } from './errors.js'
import {
  clampReadLimit,
  formatMessageLine,
  listChannelWebhooks,
  listGuildChannels,
  parseChannelWebhooks,
  readChannelMessages,
  WEBHOOKS_FORBIDDEN_MESSAGE,
} from './discord-channel-reads.js'

function fakeRest(handler: (route: string, query?: URLSearchParams) => unknown) {
  const requests: Array<{ route: string; query?: URLSearchParams }> = []
  const rest = {
    get: async (route: string, options?: { query?: URLSearchParams }) => {
      requests.push({ route, query: options?.query })
      return handler(route, options?.query)
    },
  } as unknown as REST
  return { rest, requests }
}

describe('discord-channel-reads', () => {
  test('lists guild channels grouped under their categories, dropping unknown types', async () => {
    const { rest, requests } = fakeRest(() => [
      { id: '30', name: 'firehose', type: ChannelType.GuildText, parent_id: '10', position: 2 },
      { id: '10', name: 'Ops', type: ChannelType.GuildCategory, position: 0 },
      { id: '20', name: 'roadie', type: ChannelType.GuildText, parent_id: '10', position: 1 },
      { id: '40', name: 'dm-ish', type: 999 },
    ])

    const channels = await listGuildChannels({ rest, guildId: '1' })

    expect(requests[0]?.route).toBe('/guilds/1/channels')
    expect(channels instanceof DiscordApiError).toBe(false)
    expect((channels as Array<{ id: string; type: string }>).map(({ id, type }) => `${id}:${type}`)).toEqual([
      '10:category',
      '20:text',
      '30:text',
    ])
  })

  test('reads messages oldest first with webhook, embed and attachment fields', async () => {
    const { rest, requests } = fakeRest(() => [
      {
        id: '2',
        timestamp: '2026-10-13T20:00:00.000Z',
        author: { id: '99', username: 'GitHub', bot: true },
        webhook_id: '777',
        content: '',
        embeds: [{ title: 'Deploy succeeded', url: 'https://github.com/x/actions/runs/1' }],
        attachments: [],
      },
      {
        id: '1',
        timestamp: '2026-10-13T19:00:00.000Z',
        author: { id: '5', username: 'chubes', global_name: 'Chris' },
        content: 'hello',
        embeds: [],
        attachments: [{ url: 'https://cdn.discordapp.com/a.png' }],
      },
    ])

    const messages = await readChannelMessages({ rest, channelId: '42', limit: 500, before: '9' })

    expect(requests[0]?.route).toBe('/channels/42/messages')
    expect(requests[0]?.query?.get('limit')).toBe('100')
    expect(requests[0]?.query?.get('before')).toBe('9')
    expect(messages instanceof DiscordApiError).toBe(false)
    const list = messages as Exclude<typeof messages, DiscordApiError>
    expect(list.map(({ id }) => id)).toEqual(['1', '2'])
    expect(list[0]).toMatchObject({ author: 'Chris', bot: false, webhookId: null, attachments: ['https://cdn.discordapp.com/a.png'] })
    expect(list[1]).toMatchObject({ author: 'GitHub', bot: true, webhookId: '777' })
    expect(formatMessageLine(list[1]!)).toContain('GitHub [webhook]')
    expect(formatMessageLine(list[1]!)).toContain('[embed] Deploy succeeded | https://github.com/x/actions/runs/1')
  })

  test('clamps the read limit to Discord bounds', () => {
    expect(clampReadLimit(undefined)).toBe(20)
    expect(clampReadLimit(0)).toBe(1)
    expect(clampReadLimit(250)).toBe(100)
  })

  test('never exposes webhook tokens or execution URLs', async () => {
    const raw = [
      {
        id: '777',
        type: 1,
        name: 'GitHub',
        channel_id: '42',
        token: 'SECRET-TOKEN',
        url: 'https://discord.com/api/webhooks/777/SECRET-TOKEN',
        user: { username: 'chubes' },
      },
    ]
    const parsed = parseChannelWebhooks(raw)
    expect(parsed).toEqual([
      { id: '777', name: 'GitHub', type: 'incoming', channelId: '42', creator: 'chubes', applicationId: null },
    ])
    expect(JSON.stringify(parsed)).not.toContain('SECRET-TOKEN')

    const { rest } = fakeRest(() => raw)
    const listed = await listChannelWebhooks({ rest, channelId: '42' })
    expect(JSON.stringify(listed)).not.toContain('SECRET-TOKEN')
  })

  test('explains a missing Manage Webhooks permission', async () => {
    const { rest } = fakeRest(() => {
      throw Object.assign(new Error('Missing Permissions'), { status: 403 })
    })
    const listed = await listChannelWebhooks({ rest, channelId: '42' })
    expect(listed instanceof DiscordApiError).toBe(true)
    expect((listed as DiscordApiError).message).toContain(WEBHOOKS_FORBIDDEN_MESSAGE)
  })

  test('names the failing route in other Discord errors', async () => {
    const { rest } = fakeRest(() => {
      throw Object.assign(new Error('Unknown Channel'), { status: 404 })
    })
    const read = await readChannelMessages({ rest, channelId: '42' })
    expect((read as DiscordApiError).message).toContain('/channels/42/messages')
  })
})
