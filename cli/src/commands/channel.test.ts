import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { ChannelType } from 'discord.js'
import { handleChannelAutocomplete, handleChannelCommand, isApplicationGuild } from './channel.js'
import { parseChannelsConfig, resolveChannelPolicy, setChannelsConfigPath } from '../channel-policy.js'
import type { CommandContext } from './types.js'

vi.mock('../discord-utils.js', () => ({ hasRoadieAdminPermission: () => true }))
vi.mock('../session-handler/runtime-registry.js', () => ({ getRuntimeThreadIdsForChannel: () => [], disposeRuntime: vi.fn() }))

let directory: string
let file: string
afterEach(() => {
  setChannelsConfigPath(null)
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})
function setup(application = false, multiple = false) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-command-'))
  file = path.join(directory, 'channels.yaml')
  fs.writeFileSync(file, `# retain operator comment\n${JSON.stringify({
    ...(application ? { application: { channel: 'source', directory: '/srv/app' } } : {}),
    projects: { one: { directory: '/srv/one' }, ...(multiple ? { two: { directory: '/srv/two' } } : {}) },
    channels: { source: { project: 'one', respond: 'always', threads: 'per-message', who: ['owner'] }, '*': { respond: 'never' } },
  })}`)
  setChannelsConfigPath(file)
}
function command(subcommand: string, behavior: string | null = null, project: string | null = null) {
  return {
    guildId: 'guild', channelId: 'new', member: {}, guild: {},
    client: { channels: { fetch: vi.fn(async (id: string) => ({ id, type: ChannelType.GuildText, guildId: 'guild' })) } },
    options: { getSubcommand: () => subcommand, getChannel: () => null,
      getString: (name: string) => name === 'behavior' ? behavior : project },
    deferReply: vi.fn(), editReply: vi.fn(),
  } as unknown as CommandContext['command']
}
for (const application of [false, true]) {
  test(`${application ? 'application' : 'projects'} config supports bind, behavior and unbind`, async () => {
    setup(application)
    const bind = command('bind')
    await handleChannelCommand({ command: bind } as CommandContext)
    expect(resolveChannelPolicy('new')).toMatchObject({ project: 'one', respond: 'always', threads: 'per-message', directory: application ? '/srv/app' : '/srv/one' })
    expect(resolveChannelPolicy('new')?.who).toEqual(application ? ['owner'] : undefined)
    await handleChannelCommand({ command: command('behavior', 'listen') } as CommandContext)
    expect(resolveChannelPolicy('new')).toMatchObject({ respond: 'mention', threads: 'none' })
    await handleChannelCommand({ command: command('unbind') } as CommandContext)
    expect(resolveChannelPolicy('new')?.respond).toBe('never')
    expect(fs.readFileSync(file, 'utf8')).toContain('# retain operator comment')
    expect(parseChannelsConfig(fs.readFileSync(file, 'utf8'))).not.toBeInstanceOf(Error)
  })
}
test('multiple projects require a choice, validate it, and persist the selected project', async () => {
  setup(false, true)
  const missing = command('bind')
  await handleChannelCommand({ command: missing } as CommandContext)
  expect(missing.editReply).toHaveBeenCalledWith(expect.stringContaining('Choose a project'))
  const invalid = command('bind', null, 'absent')
  await handleChannelCommand({ command: invalid } as CommandContext)
  expect(invalid.editReply).toHaveBeenCalledWith(expect.stringContaining('Unknown project'))
  await handleChannelCommand({ command: command('bind', null, 'two') } as CommandContext)
  expect(resolveChannelPolicy('new')).toMatchObject({ project: 'two', directory: '/srv/two' })
  await handleChannelCommand({ command: command('behavior', 'mention') } as CommandContext)
  expect(resolveChannelPolicy('new')).toMatchObject({ project: 'two', respond: 'mention' })
  await handleChannelCommand({ command: command('unbind') } as CommandContext)
  expect(resolveChannelPolicy('new')?.respond).toBe('never')
})
test('project autocomplete filters configured names', async () => {
  setup(false, true)
  const interaction = { options: { getFocused: () => 'TW' }, respond: vi.fn() }
  await handleChannelAutocomplete(interaction as never)
  expect(interaction.respond).toHaveBeenCalledWith([{ name: 'two', value: 'two' }])
})
test('guild ownership accepts categories but not wildcard or other guilds', async () => {
  setup()
  const interaction = command('bind')
  vi.mocked(interaction.client.channels.fetch).mockResolvedValue({ type: ChannelType.GuildCategory, guildId: 'guild' } as never)
  expect(await isApplicationGuild(interaction)).toBe(true)
  vi.mocked(interaction.client.channels.fetch).mockResolvedValue({ type: ChannelType.GuildCategory, guildId: 'other' } as never)
  expect(await isApplicationGuild(interaction)).toBe(false)
  fs.writeFileSync(file, 'projects: { one: { directory: /srv/one } }\nchannels: { "*": { respond: never } }')
  setChannelsConfigPath(file)
  expect(await isApplicationGuild(interaction)).toBe(false)
})
test('missing configuration names the missing blocks', async () => {
  setup()
  fs.writeFileSync(file, 'channels: {}')
  setChannelsConfigPath(file)
  const interaction = command('bind')
  await handleChannelCommand({ command: interaction } as CommandContext)
  expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('no projects or application block'))
})
