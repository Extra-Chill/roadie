// The component route table (#311): every custom-id prefix routes to exactly
// one entry, and a component whose prefix is not in the table gets a private
// "no longer available" reply instead of silence.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import { closeDb } from './db.js'
import { initDatabase, setChannelDirectory } from './database.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { COMPONENT_ROUTES, UNKNOWN_COMPONENT_MESSAGE } from './component-routes.js'
import { registerInteractionHandler } from './interaction-handler.js'

describe('component route table', () => {
  const prefixes = COMPONENT_ROUTES.map((route) => route.prefix)

  test('every prefix is unique', () => {
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })

  test('no prefix shadows another', () => {
    const shadowed = prefixes.flatMap((prefix, index) =>
      prefixes
        .filter((other, otherIndex) => otherIndex !== index && other.startsWith(prefix))
        .map((other) => `${prefix} shadows ${other}`))
    expect(shadowed).toEqual([])
  })

  test('every prefix ends with the custom-id separator', () => {
    expect(prefixes.filter((prefix) => !prefix.endsWith(':'))).toEqual([])
  })
})

describe('unknown component prefixes', () => {
  const userId = '100000000000000555'
  const guildId = '100000000000000111'
  const channelId = '100000000000000333'
  let directory: string | undefined
  let discord: DigitalDiscord | undefined
  let client: Client | undefined

  afterEach(async () => {
    setChannelsConfigPath(undefined)
    await client?.destroy()
    await discord?.stop()
    await closeDb()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  })

  test('a click on an unknown prefix gets a private "no longer available" reply', async () => {
    const root = path.resolve('tmp/component-routes')
    fs.mkdirSync(root, { recursive: true })
    directory = fs.mkdtempSync(path.join(root, 'run-'))
    setDataDir(directory)
    setChannelsConfigPath(null)
    await closeDb()
    await initDatabase()
    await setChannelDirectory({ channelId, directory, channelType: 'text' })
    discord = new DigitalDiscord({
      dbUrl: `file:${path.join(directory, 'discord.db')}`,
      users: [{ id: userId, username: 'clicker' }],
      guilds: [{ id: guildId, name: 'Served', ownerId: userId, channels: [
        { id: channelId, name: 'project', type: ChannelType.GuildText },
      ] }],
    })
    await discord.start()
    client = new Client({
      intents: [GatewayIntentBits.Guilds],
      rest: { api: discord.restUrl, version: '10' },
    })
    const ready = new Promise<void>((resolve) => client!.once(Events.ClientReady, () => resolve()))
    await client.login(discord.botToken)
    await ready
    registerInteractionHandler({ discordClient: client, appId: discord.botUserId })

    const channel = discord.channel(channelId)
    const message = await channel.user(userId).sendMessage({ content: 'old buttons' })
    const { id } = await channel.user(userId).clickButton({
      messageId: message.id,
      customId: 'retired_feature:abc',
    })

    const ack = await channel.waitForInteractionAck({ interactionId: id })
    expect(ack.type).toBe(4) // ChannelMessageWithSource
    const response = await channel.getInteractionResponse(id)
    expect(response?.data).toContain(UNKNOWN_COMPONENT_MESSAGE)
    const reply = (await channel.getMessages()).find((m) => m.id === response?.messageId)
    expect((reply?.flags ?? 0) & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral)
  }, 20_000)
})
