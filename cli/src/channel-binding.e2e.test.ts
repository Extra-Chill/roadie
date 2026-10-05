import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, afterAll, expect, test } from 'vitest'
import { ChannelType } from 'discord.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { addFilter } from './hooks.js'
import { getChannelDirectory, getThreadSession, setChannelDirectory } from './database.js'
import { getRuntime } from './session-handler/thread-session-runtime.js'
import { waitForFooterMessage } from './test-utils.js'

const DEFAULT = '200000000000001086'
const DENIED = '200000000000001087'
const ctx = setupQueueAdvancedSuite({ channelId: DEFAULT, channelName: 'application-default', dirName: 'channel-binding-e2e', username: 'binding-owner' })
let file: string
let target: string
let removePerson: () => void

beforeAll(async () => {
  file = path.join(ctx.directories.dataDir, 'channels.json')
  fs.writeFileSync(file, JSON.stringify({ application: { channel: DEFAULT, directory: ctx.directories.projectDirectory }, channels: { [DEFAULT]: { context: 'shared-brain', respond: 'always' } } }))
  setChannelsConfigPath(file)
  const source = await ctx.botClient.channels.fetch(DEFAULT)
  if (source?.type !== ChannelType.GuildText) throw new Error('Missing default channel')
  target = (await source.guild.channels.create({ name: 'new-work', type: ChannelType.GuildText })).id
  await ctx.discord.prisma.user.create({ data: { id: DENIED, username: 'non-admin' } })
  await ctx.discord.prisma.guildMember.create({ data: { guildId: ctx.discord.guildId, userId: DENIED, permissions: '0' } })
  removePerson = addFilter('person', (_person, { actor }) => ({ allowed: true, capabilities: new Set(actor.id === TEST_USER_ID ? ['sessions', 'shell', 'admin'] as const : ['sessions'] as const), permissions: [] }))
})

afterAll(() => { setChannelsConfigPath(null); removePerson?.() })

async function command(channelId: string, subcommand: 'bind' | 'unbind', expected: string, userId = TEST_USER_ID) {
  const channel = ctx.discord.channel(channelId)
  const result = await channel.user(userId).runSlashCommand({ name: 'channel', options: [{ name: subcommand, type: 1 }] })
  await channel.waitForInteractionAck({ interactionId: result.id, timeout: 4_000 })
  return channel.waitForMessage({ timeout: 4_000, predicate: (message) => BigInt(message.id) > BigInt(result.id) && message.author.id === ctx.discord.botUserId && message.content.includes(expected) })
}

test('bind bootstraps messages and slash sessions without a directory row; unbind preserves history and rebind resumes it', async () => {
  const channel = ctx.discord.channel(target)
  expect(await getChannelDirectory(target)).toBeUndefined()
  await channel.user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: before-binding' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(await channel.getThreads()).toHaveLength(0)
  const before = fs.readFileSync(file, 'utf8')
  await command(target, 'bind', 'administrators', DENIED)
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
  await command(target, 'bind', 'Bound')
  const bound = fs.readFileSync(file, 'utf8')
  await command(target, 'bind', 'Already bound')
  expect(fs.readFileSync(file, 'utf8')).toBe(bound)
  await channel.user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: after-binding' })
  const first = await channel.waitForThread({ timeout: 6_000 })
  await waitForFooterMessage({ discord: ctx.discord, threadId: first.id, timeout: 8_000 })
  expect(getRuntime(first.id)?.sdkDirectory).toBe(ctx.directories.projectDirectory)
  const session = await getThreadSession(first.id)
  expect(session).toBeTruthy()
  // A separate slash session uses the explicit application binding as ownership.
  const slash = await channel.user(TEST_USER_ID).runSlashCommand({ name: 'new-session', options: [{ name: 'prompt', type: 3, value: 'Reply with exactly: bound-slash' }] })
  await channel.waitForInteractionAck({ interactionId: slash.id, timeout: 4_000 })
  const second = await channel.waitForThread({ timeout: 6_000, predicate: (thread) => thread.id !== first.id })
  await waitForFooterMessage({ discord: ctx.discord, threadId: second.id, timeout: 8_000 })
  expect(getRuntime(second.id)?.sdkDirectory).toBe(ctx.directories.projectDirectory)
  // An old SQLite mapping must not override the durable unbind policy.
  await setChannelDirectory({ channelId: target, directory: ctx.directories.projectDirectory, channelType: 'text' })
  await command(target, 'unbind', 'Unbound')
  await command(target, 'unbind', 'Already unbound')
  expect(await getThreadSession(first.id)).toBe(session)
  expect(getRuntime(first.id)).toBeUndefined()
  await channel.user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: ignored-after-unbind' })
  const blocked = await channel.user(TEST_USER_ID).runSlashCommand({ name: 'new-session', options: [{ name: 'prompt', type: 3, value: 'Reply with exactly: ignored-slash' }] })
  await channel.waitForInteractionAck({ interactionId: blocked.id, timeout: 4_000 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(await channel.getThreads()).toHaveLength(2)
  await command(target, 'bind', 'Bound')
  const followup = await ctx.discord.thread(first.id).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: resumed-binding' })
  await waitForFooterMessage({ discord: ctx.discord, threadId: first.id, afterMessageId: followup.id, timeout: 8_000 })
  expect(await getThreadSession(first.id)).toBe(session)
  await command(DEFAULT, 'unbind', 'default cannot be unbound')
}, 40_000)

test('an unrelated guild with a legacy local mapping cannot bind itself to the application', async () => {
  const guildId = '200000000000001088'
  const channelId = '200000000000001089'
  await ctx.discord.prisma.guild.create({ data: { id: guildId, name: 'Other server', ownerId: TEST_USER_ID } })
  await ctx.discord.prisma.channel.create({ data: { id: channelId, guildId, name: 'other', type: ChannelType.GuildText } })
  await ctx.discord.prisma.guildMember.create({ data: { guildId, userId: TEST_USER_ID, permissions: '1099511627775' } })
  await setChannelDirectory({ channelId, directory: ctx.directories.projectDirectory, channelType: 'text' })
  const before = fs.readFileSync(file, 'utf8')
  const channel = ctx.discord.channel(channelId)
  const result = await channel.user(TEST_USER_ID).runSlashCommand({ name: 'channel', guildId, options: [{ name: 'bind', type: 1 }] })
  await channel.waitForInteractionAck({ interactionId: result.id, timeout: 4_000 })
  await channel.waitForMessage({ timeout: 4_000, predicate: (message) => message.content.includes('not configured') })
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
})
