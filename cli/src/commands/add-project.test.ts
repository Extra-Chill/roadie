// /add-project lists project candidates from backend-neutral sources
// (registered channel directories + the projects directory) and creates
// channels for the picked directory without any agent backend.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js'

vi.mock('../channel-management.js', () => ({
  createProjectChannels: vi.fn(async () => ({ textChannelId: 'chan-1', channelName: 'project' })),
}))

const { handleAddProjectAutocomplete, handleAddProjectCommand, listProjectDirectories } = await import('./add-project.js')
const { createProjectChannels } = await import('../channel-management.js')
const { closeDb } = await import('../db.js')
const { getProjectsDir, setProjectsDir } = await import('../config.js')
const { setChannelDirectory } = await import('../database.js')

const GUILD_ID = 'guild-1'
const originalProjectsDir = getProjectsDir()
const tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'add-project-test-'))
const projectsDir = path.join(tempRoot, 'projects')
fs.mkdirSync(projectsDir, { recursive: true })
setProjectsDir(projectsDir)

afterAll(async () => {
  setProjectsDir(originalProjectsDir)
  await closeDb()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
})

function createCommandStub({ directory }: { directory: string }): ChatInputCommandInteraction {
  return {
    guild: { id: GUILD_ID },
    client: { user: { username: 'Roadie' } },
    options: { getString: () => directory },
    deferReply: vi.fn(async () => ({})),
    editReply: vi.fn(async () => ({})),
  } as unknown as ChatInputCommandInteraction
}

describe('listProjectDirectories', () => {
  test('merges registered channel directories and projects directory entries, skipping missing and test dirs', async () => {
    const registered = fs.mkdtempSync(path.join(tempRoot, 'registered-'))
    const onDisk = path.join(projectsDir, 'on-disk')
    const removed = path.join(projectsDir, 'removed')
    const testScaffold = path.join(projectsDir, 'opencode-test-xyz')
    fs.mkdirSync(onDisk)
    fs.mkdirSync(testScaffold)
    // A registered directory that no longer exists on disk must not be listed.
    await setChannelDirectory({ channelId: 'chan-registered', directory: registered, channelType: 'text', guildId: GUILD_ID })
    await setChannelDirectory({ channelId: 'chan-gone', directory: removed, channelType: 'text', guildId: GUILD_ID })

    const directories = await listProjectDirectories()

    expect(directories).toContain(registered)
    expect(directories).toContain(onDisk)
    expect(directories).not.toContain(removed)
    expect(directories).not.toContain(testScaffold)
    // Registered directories come first.
    expect(directories.indexOf(registered)).toBeLessThan(directories.indexOf(onDisk))
  })
})

describe('handleAddProjectAutocomplete', () => {
  test('offers projects by directory value without any backend', async () => {
    const mine = path.join(projectsDir, 'my-project')
    const other = path.join(projectsDir, 'other-project')
    fs.mkdirSync(mine)
    fs.mkdirSync(other)

    const respond = vi.fn(async (_choices?: Array<{ name: string; value: string }>) => {})
    const interaction = {
      options: { getFocused: () => 'my-proj' },
      respond,
    } as unknown as AutocompleteInteraction

    await handleAddProjectAutocomplete({ interaction, appId: "test-app" })

    expect(respond).toHaveBeenCalledTimes(1)
    const choices = vi.mocked(respond).mock.calls[0]![0] as Array<{ name: string; value: string }>
    expect(choices).toEqual([{ name: `my-project (${mine})`, value: mine }])
  })
})

describe('handleAddProjectCommand', () => {
  test('creates channels for the picked directory', async () => {
    const directory = path.join(projectsDir, 'picked')
    fs.mkdirSync(directory)

    const command = createCommandStub({ directory })
    await handleAddProjectCommand({ command, appId: "test-app" })

    expect(vi.mocked(createProjectChannels)).toHaveBeenCalledWith({
      guild: { id: GUILD_ID },
      projectDirectory: directory,
      botName: 'Roadie',
    })
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining('Created channel for project'))
  })

  test('reports a directory that does not exist', async () => {
    const command = createCommandStub({ directory: path.join(projectsDir, 'missing') })
    await handleAddProjectCommand({ command, appId: "test-app" })

    expect(vi.mocked(createProjectChannels)).not.toHaveBeenCalled()
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining('Directory does not exist'))
  })
})
