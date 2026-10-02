// SDK compatibility test: validates that a real discord.js Client can
// connect to the DigitalDiscord server, complete the Gateway handshake,
// and see the seeded guild/channels.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Client, GatewayIntentBits, ChannelType } from 'discord.js'
import { DigitalDiscord } from '../src/index.js'

describe('discord.js SDK compatibility', () => {
  let discord: DigitalDiscord
  let client: Client

  beforeAll(async () => {
    discord = new DigitalDiscord({
      guild: { name: 'Test Server' },
      channels: [
        {
          name: 'general',
          type: ChannelType.GuildText,
          topic: 'roadie:/tmp/test-project',
        },
      ],
      users: [{ username: 'TestUser' }],
    })
    await discord.start()

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: {
        api: discord.restUrl,
        version: '10',
      },
    })

    await client.login(discord.botToken)
    // Wait for READY + GUILD_CREATE to be processed
    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve()
        return
      }
      client.once('ready', () => {
        resolve()
      })
    })
  }, 15000)

  afterAll(async () => {
    client?.destroy()
    await discord?.stop()
  })

  test('client is ready', () => {
    expect(client.isReady()).toBe(true)
  })

  test('client user is the bot', () => {
    expect(client.user?.username).toBe('TestBot')
    expect(client.user?.bot).toBe(true)
  })

  test('client sees one guild', () => {
    expect(client.guilds.cache.size).toBe(1)
    const guild = client.guilds.cache.first()
    expect(guild?.name).toBe('Test Server')
  })

  test('guild has the general channel', () => {
    const guild = client.guilds.cache.first()
    const channel = guild?.channels.cache.find((c) => c.name === 'general')
    expect(channel).toBeDefined()
    expect(channel?.type).toBe(ChannelType.GuildText)
  })

  test('guild has @everyone role', () => {
    const guild = client.guilds.cache.first()
    const everyoneRole = guild?.roles.cache.find((r) => r.name === '@everyone')
    expect(everyoneRole).toBeDefined()
  })

  test('bot user ID matches', () => {
    expect(client.user?.id).toBe(discord.botUserId)
  })
})
