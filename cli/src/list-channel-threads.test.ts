import { ChannelType } from 'discord.js'
import { describe, expect, test } from 'vitest'
import type { REST } from 'discord.js'
import {
  listDiscordChannelThreads,
  mergeDiscordChannelThreads,
  parseDiscordThreadPayload,
} from './list-channel-threads.js'

describe('list-channel-threads', () => {
  test('parses public threads and skips other channel types', () => {
    const parsed = parseDiscordThreadPayload({
      payload: {
        id: 'thread-1',
        name: 'Fix auth timeout',
        type: ChannelType.PublicThread,
        parent_id: 'channel-1',
        guild_id: 'guild-1',
        last_message_id: 'msg-9',
        thread_metadata: { archived: false },
      },
      parentId: 'channel-1',
      guildId: 'guild-1',
    })

    expect(parsed).toMatchInlineSnapshot(`
      {
        "archiveState": "active",
        "archived": false,
        "guildId": "guild-1",
        "id": "thread-1",
        "lastMessageId": "msg-9",
        "name": "Fix auth timeout",
        "parentId": "channel-1",
      }
    `)

    expect(
      parseDiscordThreadPayload({
        payload: {
          id: 'not-a-thread',
          name: 'website',
          type: ChannelType.GuildText,
          parent_id: 'category-1',
        },
        parentId: 'channel-1',
        guildId: 'guild-1',
      }),
    ).toBe(null)
  })

  test('keeps active threads first and drops duplicate ids', () => {
    const merged = mergeDiscordChannelThreads({
      threads: [
        {
          id: 'thread-old',
          name: 'Old work',
          parentId: 'channel-1',
          guildId: 'guild-1',
          archived: true,
          archiveState: 'archived',
          lastMessageId: '2',
        },
        {
          id: 'thread-new',
          name: 'New work',
          parentId: 'channel-1',
          guildId: 'guild-1',
          archived: false,
          archiveState: 'active',
          lastMessageId: '1',
        },
        {
          id: 'thread-new',
          name: 'New work duplicate',
          parentId: 'channel-1',
          guildId: 'guild-1',
          archived: false,
          archiveState: 'active',
          lastMessageId: '9',
        },
      ],
    })

    expect(merged.map((thread) => thread.id)).toMatchInlineSnapshot(`
      [
        "thread-new",
        "thread-old",
      ]
    `)
  })

  test('pages archived threads with the archive timestamp as the before cursor', async () => {
    const requests: Array<{ route: string; query?: URLSearchParams }> = []
    const archivedPages = [
      {
        threads: [
          {
            id: 'thread-2',
            name: 'Newer',
            type: ChannelType.PublicThread,
            parent_id: 'channel-1',
            thread_metadata: { archived: true, archive_timestamp: '2026-10-02T00:00:00.000Z' },
          },
          {
            id: 'thread-elsewhere',
            name: 'Other channel',
            type: ChannelType.PublicThread,
            parent_id: 'channel-2',
            thread_metadata: { archived: true, archive_timestamp: '2026-10-01T00:00:00.000Z' },
          },
        ],
        has_more: true,
      },
      {
        threads: [
          {
            id: 'thread-1',
            name: 'Older',
            type: ChannelType.PublicThread,
            parent_id: 'channel-1',
            thread_metadata: { archived: true, archive_timestamp: '2026-09-01T00:00:00.000Z' },
          },
        ],
        has_more: false,
      },
    ]
    const rest = {
      get: async (route: string, options?: { query?: URLSearchParams }) => {
        requests.push({ route, query: options?.query })
        if (route === '/channels/channel-1') {
          return { id: 'channel-1', type: ChannelType.GuildText, guild_id: 'guild-1' }
        }
        if (route === '/guilds/guild-1/threads/active') {
          return { threads: [], has_more: false }
        }
        return archivedPages.shift()
      },
    } as unknown as REST

    const result = await listDiscordChannelThreads({ rest, channelId: 'channel-1' })

    expect(result.ok && result.threads.map(({ id }) => id)).toEqual(['thread-2', 'thread-1'])
    const archivedRequests = requests.slice(2)
    expect(archivedRequests).toHaveLength(2)
    expect(archivedRequests[0]?.query?.get('limit')).toBe('100')
    expect(archivedRequests[0]?.query?.has('before')).toBe(false)
    // The cursor is the last raw entry's archive timestamp, never a thread ID.
    expect(archivedRequests[1]?.query?.get('before')).toBe('2026-10-01T00:00:00.000Z')
  })

  test('names the failing route in Discord API errors', async () => {
    const rest = {
      get: async () => {
        throw Object.assign(new Error('Invalid Form Body'), { status: 400 })
      },
    } as unknown as REST

    const result = await listDiscordChannelThreads({ rest, channelId: 'channel-1' })

    expect(result.ok).toBe(false)
    expect(!result.ok && String(result.error.message + JSON.stringify(result.error))).toContain('/channels/channel-1')
  })
})
