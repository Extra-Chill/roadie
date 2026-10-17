// Person-scoped commands (/link, /connect, /start and their buttons) are
// answered in unbound channels of a guild this machine serves (#301), while
// unserved guilds and agent commands keep the silent multi-machine skip.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import { closeDb } from './db.js'
import { initDatabase, setChannelDirectory } from './database.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { LINK_NOT_AVAILABLE_MESSAGE } from './identity-link.js'
import { registerInteractionHandler } from './interaction-handler.js'
import { linkButtonCustomId } from './commands/link.js'

const ownerId = '100000000000000555'
const servedGuildId = '100000000000000111'
const otherGuildId = '100000000000000222'
const boundChannelId = '100000000000000333'
const generalChannelId = '100000000000000334'
const otherChannelId = '100000000000000444'
let directory: string
let discord: DigitalDiscord
let client: Client

beforeEach(async () => {
  const root = path.resolve('tmp/person-scoped-interactions')
  fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'run-'))
  setDataDir(directory)
  setChannelsConfigPath(null)
  await closeDb()
  await initDatabase()
  discord = new DigitalDiscord({
    dbUrl: `file:${path.join(directory, 'discord.db')}`,
    users: [{ id: ownerId, username: 'server-owner' }],
    guilds: [
      { id: servedGuildId, name: 'Served', ownerId, channels: [
        { id: boundChannelId, name: 'project', type: ChannelType.GuildText },
        { id: generalChannelId, name: 'general', type: ChannelType.GuildText },
      ] },
      { id: otherGuildId, name: 'Elsewhere', ownerId, channels: [
        { id: otherChannelId, name: 'general', type: ChannelType.GuildText },
      ] },
    ],
  })
  await discord.start()
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { api: discord.restUrl, version: '10' },
  })
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()))
  await client.login(discord.botToken)
  await ready
  registerInteractionHandler({ discordClient: client, appId: discord.botUserId })
})

afterEach(async () => {
  setChannelsConfigPath(undefined)
  await client?.destroy()
  await discord?.stop()
  await closeDb()
  fs.rmSync(directory, { recursive: true, force: true })
})

async function expectNeverAcknowledged(channelId: string, interactionId: string) {
  const channel = discord.channel(channelId)
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await channel.getInteractionResponse(interactionId))?.acknowledged ?? false).toBe(false)
  }
}

async function expectLinkAnswered(channelId: string, interactionId: string) {
  const channel = discord.channel(channelId)
  await channel.waitForInteractionAck({ interactionId })
  await channel.waitForBotReply()
  expect(await channel.text()).toContain(LINK_NOT_AVAILABLE_MESSAGE)
}

function bindInConfig() {
  const file = path.join(directory, 'channels.yaml')
  fs.writeFileSync(file, `projects:\n  site:\n    directory: ${directory}\nchannels:\n  "${boundChannelId}":\n    project: site\n`)
  setChannelsConfigPath(file)
}

describe('person-scoped interactions in unbound channels', () => {
  test('/link is answered in an unbound channel of a guild bound in the local directories', async () => {
    // Legacy rows carry no guild id: the guild is resolved through Discord.
    await setChannelDirectory({ channelId: boundChannelId, directory, channelType: 'text' })
    const { id } = await discord.channel(generalChannelId).user(ownerId).runSlashCommand({ name: 'link' })
    await expectLinkAnswered(generalChannelId, id)
  })

  test('/link is answered in an unbound channel of a guild bound only in the channels config', async () => {
    bindInConfig()
    const { id } = await discord.channel(generalChannelId).user(ownerId).runSlashCommand({ name: 'link' })
    await expectLinkAnswered(generalChannelId, id)
  })

  test('/link in a guild this machine does not serve is left for the owning machine', async () => {
    await setChannelDirectory({ channelId: boundChannelId, directory, channelType: 'text', guildId: servedGuildId })
    bindInConfig()
    const { id } = await discord.channel(otherChannelId).user(ownerId).runSlashCommand({ name: 'link', guildId: otherGuildId })
    await expectNeverAcknowledged(otherChannelId, id)
  })

  test('/link is not answered anywhere when nothing is bound', async () => {
    const { id } = await discord.channel(generalChannelId).user(ownerId).runSlashCommand({ name: 'link' })
    await expectNeverAcknowledged(generalChannelId, id)
  })

  test('a Link button in an unbound channel of a served guild is answered', async () => {
    bindInConfig()
    const channel = discord.channel(generalChannelId)
    const prompt = await channel.user(ownerId).sendMessage({ content: 'link prompt' })
    const { id } = await channel.user(ownerId).clickButton({
      messageId: prompt.id,
      customId: linkButtonCustomId({ guildId: servedGuildId }),
    })
    const ack = await channel.waitForInteractionAck({ interactionId: id })
    expect(ack.type).toBe(5) // deferred, ephemeral reply for the clicker only
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const response = await channel.getInteractionResponse(id)
      const message = (await channel.getMessages()).find((m) => m.id === response?.messageId)
      if (message?.content.includes(LINK_NOT_AVAILABLE_MESSAGE)) return
    }
    throw new Error('Link button reply was never updated')
  })

  test('/connect and /start pass the unbound channel policy and answer privately', async () => {
    // The config ignores channels it does not list; that must not swallow these.
    bindInConfig()
    const channel = discord.channel(generalChannelId)
    for (const [name, reply] of [
      ['connect', 'Per-person services are not configured on this server.'],
      ['start', "I'm Roadie, an AI agent for this server."],
    ] as const) {
      const { id } = await channel.user(ownerId).runSlashCommand({ name })
      const ack = await channel.waitForInteractionAck({ interactionId: id })
      expect(ack.type).toBe(4)
      expect((await channel.getInteractionResponse(id))?.data).toContain(reply)
    }
  })

  test('agent commands in an unbound channel of a served guild stay ignored', async () => {
    bindInConfig()
    await setChannelDirectory({ channelId: boundChannelId, directory, channelType: 'text', guildId: servedGuildId })
    for (const name of ['new-session', 'abort', 'model']) {
      const { id } = await discord.channel(generalChannelId).user(ownerId).runSlashCommand({ name })
      await expectNeverAcknowledged(generalChannelId, id)
    }
  })
})
