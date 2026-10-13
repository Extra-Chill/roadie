// /add-project command - Create Discord channels for an existing project.
//
// Project candidates come from backend-neutral sources: directories already
// registered to channels in Roadie's database, plus subdirectories of the
// projects directory. No agent backend has to be running.

import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext, AutocompleteContext } from './types.js'
import { findChannelsByDirectory } from '../database.js'
import { getProjectsDir } from '../config.js'
import { createProjectChannels } from '../channel-management.js'
import { createLogger, LogPrefix } from '../logger.js'
import { abbreviatePath } from '../utils.js'

const logger = createLogger(LogPrefix.ADD_PROJECT)

/** Test scaffolding directories are never offered as projects. */
function isTestProjectDirectory(directory: string): boolean {
  return path.basename(directory).startsWith('opencode-test-')
}

/**
 * Backend-neutral project candidates: channel directories Roadie already
 * knows about, plus subdirectories of the projects directory. Existing
 * directories only, deduplicated, registration order first.
 */
export async function listProjectDirectories(): Promise<string[]> {
  const registeredDirectories = await findChannelsByDirectory({ channelType: 'text' })
    .then((rows) => rows.map((row) => row.directory))
    .catch((error) => {
      logger.warn('[ADD-PROJECT] Could not read registered channel directories:', error)
      return []
    })

  const projectsDir = getProjectsDir()
  const projectsDirEntries = (() => {
    try {
      return fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(projectsDir, entry.name))
    } catch {
      return []
    }
  })()

  const seen = new Set<string>()
  const directories: string[] = []
  for (const directory of [...registeredDirectories, ...projectsDirEntries]) {
    if (seen.has(directory)) continue
    seen.add(directory)
    if (isTestProjectDirectory(directory)) continue
    if (!fs.existsSync(directory)) continue
    directories.push(directory)
  }
  return directories
}

function modifiedTime(directory: string): number {
  try {
    return fs.statSync(directory).mtimeMs
  } catch {
    return 0
  }
}

export async function handleAddProjectCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply()

  const directory = command.options.getString('project', true)
  const guild = command.guild

  if (!guild) {
    await command.editReply('This command can only be used in a guild')
    return
  }

  try {
    // Discord lets users type any value into an autocomplete option, so only
    // accept directories that autocomplete would offer, as the old project-id
    // lookup did.
    if (!(await listProjectDirectories()).includes(directory)) {
      await command.editReply('Project not found')
      return
    }
    if (!fs.existsSync(directory)) {
      await command.editReply(`Directory does not exist: ${directory}`)
      return
    }

    const { textChannelId, channelName } =
      await createProjectChannels({
        guild,
        projectDirectory: directory,
        botName: command.client.user?.username,
      })

    await command.editReply(
      `✅ Created channel for project:\n📝 Text: <#${textChannelId}>\n📁 Directory: \`${directory}\``,
    )

    logger.log(`Created channels for project ${channelName} at ${directory}`)
  } catch (error) {
    logger.error('[ADD-PROJECT] Error:', error)
    await command.editReply(
      `Failed to create channels: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleAddProjectAutocomplete({
  interaction,
}: AutocompleteContext): Promise<void> {
  const focusedValue = interaction.options.getFocused()

  try {
    const projects = (await listProjectDirectories())
      .sort((a, b) => modifiedTime(b) - modifiedTime(a))
      .filter((directory) => {
        const baseName = path.basename(directory)
        const searchText = `${baseName} ${directory}`.toLowerCase()
        return searchText.includes(focusedValue.toLowerCase())
      })
      .filter((directory) => directory.length <= 100)
      .slice(0, 25)
      .map((directory) => {
        const name = `${path.basename(directory)} (${abbreviatePath(directory)})`
        return {
          name: name.length > 100 ? name.slice(0, 99) + '…' : name,
          value: directory,
        }
      })

    await interaction.respond(projects)
  } catch (error) {
    logger.error('[AUTOCOMPLETE] Error fetching projects:', error)
    await interaction.respond([])
  }
}
