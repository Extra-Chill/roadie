// Project registration and Discord channel management terminal commands.
// `project add` / `project create` are removed: the channels config
// (--channels-config / ROADIE_CHANNELS_CONFIG) is the only source of
// channel-to-directory bindings. They stay registered only to point users
// there instead of failing with an unknown-command error.
import { goke } from 'goke'
import path from 'node:path'
import { Routes } from 'discord.js'
import { spawn } from 'node:child_process'
import { createLogger, LogPrefix } from '../logger.js'
import { initDatabase } from '../discord-bot.js'
import { getDefaultRoadieDirectory } from '../channel-management.js'
import {
  getBotTokenWithMode,
  getDb,
  deleteChannelDirectoryById,
  findChannelsByDirectory,
  listGuildCategoryIds,
} from '../database.js'
import { createDiscordRest } from '../discord-urls.js'
import { EXIT_NO_RESTART } from '../cli-runner.js'
import {
  AGENT_PROJECTS_PATH,
  AGENT_PROJECT_REMOVE_PATH,
  AGENT_PROJECT_OPEN_IN_DISCORD_PATH,
  projectListQuery,
  projectOpenInDiscordBody,
  projectRemoveBody,
  resolveAgentCredentials,
  runAgentCommand,
} from '../agent-remote.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

cli
  .command(
    'project add [directory]',
    'Removed: channels are bound to directories by --channels-config (ROADIE_CHANNELS_CONFIG)',
  )
  .alias('add-project')
  .option(
    '-g, --guild <guildId>',
    'Removed: channels are bound to directories by the channels config',
  )
  .option(
    '-a, --app-id <appId>',
    'Removed: channels are bound to directories by the channels config',
  )
  .action(async () => {
    cliLogger.error(
      '`roadie project add` was removed: Roadie no longer creates project channels. Bind the channel to its directory in the channels config file (--channels-config or ROADIE_CHANNELS_CONFIG).',
    )
    process.exit(EXIT_NO_RESTART)
  })

cli
  .command('project list', 'List all registered projects with their Discord channels')
  .option('--json', 'Output as JSON')
  .option('--all', 'Include remote projects from other machines (scans Roadie groups in Discord)')
  .option(
    '-g, --guild <guildId>',
    'Discord guild/server ID to scan (used with --all when no local projects exist)',
  )
  .option('--prune', 'Remove stale entries whose Discord channel no longer exists')
  .action(async (options) => {
    // Agent tool shells hold a per-session token, not database credentials;
    // the running bot executes the listing and streams the same output back.
    // (--prune is not reachable in agent mode.)
    const agent = resolveAgentCredentials()
    if (!(agent instanceof Error)) {
      const exitCode = await runAgentCommand({
        agent,
        request: {
          method: 'GET',
          path: AGENT_PROJECTS_PATH,
          query: projectListQuery(options),
        },
      })
      process.exit(exitCode)
    }

    await initDatabase()

    const db = await getDb()
    const channels = await db.query.channel_directories.findMany({
      where: { channel_type: 'text' },
      orderBy: { created_at: 'desc' },
    })

    // Fetch Discord channel names and guild IDs via REST API
    const botRow = await getBotTokenWithMode()
    const rest = botRow ? createDiscordRest(botRow.token) : null

    const localChannelIds = new Set(channels.map((ch) => ch.channel_id))

    const enriched = await Promise.all(
      channels.map(async (ch) => {
        let channelName = ''
        let guildId = ''
        let deleted = false
        if (rest) {
          try {
            const data = (await rest.get(Routes.channel(ch.channel_id))) as {
              name?: string
              guild_id?: string
            }
            channelName = data.name || ''
            guildId = data.guild_id || ''
          } catch (error) {
            // Only mark as deleted for Unknown Channel (10003) or 404,
            // not transient errors like rate limits or 5xx.
            // Gateway-proxy must return Discord 404 for unknown channels, not 403.
            const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
            const status = error instanceof Error ? Reflect.get(error, 'status') : undefined
            const isUnknownChannel = code === 10003 || status === 404
            deleted = isUnknownChannel
          }
        }
        return { ...ch, channelName, guildId, deleted, isLocal: true as boolean }
      }),
    )

    // Fetch guild names for unique guild IDs (deduplicated to save API calls)
    const guildNameMap = new Map<string, string>()
    // Collect guild IDs from local channels + explicit --guild flag
    const guildIdsFromChannels = enriched.map((ch) => ch.guildId).filter(Boolean)
    if (options.guild) {
      guildIdsFromChannels.push(options.guild)
    }
    const uniqueGuildIds = [...new Set(guildIdsFromChannels)]
    if (rest) {
      await Promise.all(
        uniqueGuildIds.map(async (guildId) => {
          try {
            const data = (await rest.get(Routes.guild(guildId))) as { name?: string }
            guildNameMap.set(guildId, data.name || '')
          } catch (error) {
            cliLogger.debug(
              `Failed to fetch guild ${guildId}:`,
              error instanceof Error ? error.stack : String(error),
            )
          }
        }),
      )
    }

    // When --all is passed, scan each guild's channels to find Roadie category
    // text channels not in our local DB (projects from other machines).
    // Fail explicitly when prerequisites are missing so the user doesn't
    // confuse "scan never ran" with "no remote projects found".
    let remoteEntries: typeof enriched = []
    if (options.all) {
      if (!rest) {
        cliLogger.error(
          'Discord credentials are required to scan remote projects. Run `roadie` first.',
        )
        process.exit(EXIT_NO_RESTART)
      }
      if (uniqueGuildIds.length === 0) {
        cliLogger.error(
          'Cannot determine which Discord server to scan. Pass `--guild <guildId>` or register a local project first.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      let guildScanFailures = 0
      const storedCategoryIds = new Set(await listGuildCategoryIds())
      for (const guildId of uniqueGuildIds) {
        try {
          const guildChannels = (await rest.get(Routes.guildChannels(guildId))) as Array<{
            id: string
            name: string
            type: number
            parent_id: string | null
          }>

          // Roadie groups: name still starts with Roadie, or this machine stored the id
          // after a rename. Other machines' renamed groups cannot be found by name.
          const roadieCategoryIds = new Set(
            guildChannels
              .filter(
                (ch) =>
                  ch.type === 4 && (/^roadie(\s|$)/i.test(ch.name) || storedCategoryIds.has(ch.id)),
              )
              .map((ch) => ch.id),
          )

          // Find text channels (type 0) in Roadie categories that are not in our local DB
          for (const ch of guildChannels) {
            if (
              ch.type === 0 &&
              ch.parent_id &&
              roadieCategoryIds.has(ch.parent_id) &&
              !localChannelIds.has(ch.id)
            ) {
              remoteEntries.push({
                channel_id: ch.id,
                directory: '',
                channel_type: 'text' as const,
                guild_id: guildId,
                created_at: null,
                channelName: ch.name,
                guildId,
                deleted: false,
                isLocal: false,
              })
            }
          }
        } catch (error) {
          guildScanFailures++
          cliLogger.warn(
            `Failed to scan guild ${guildNameMap.get(guildId) || guildId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (guildScanFailures === uniqueGuildIds.length) {
        cliLogger.error('Failed to scan all guilds. Check bot permissions or try again.')
        process.exit(EXIT_NO_RESTART)
      }
    }

    // Build final enriched entries with guild names resolved
    const allEntries = [...enriched, ...remoteEntries]
    const enrichedWithGuild = allEntries.map((ch) => ({
      ...ch,
      guildName: ch.guildId ? guildNameMap.get(ch.guildId) || '' : '',
    }))

    // Warn on stderr if the same directory appears in multiple channels (multi-guild duplicates)
    const directoryCounts = new Map<string, number>()
    for (const ch of enrichedWithGuild) {
      if (!ch.deleted && ch.directory) {
        directoryCounts.set(ch.directory, (directoryCounts.get(ch.directory) || 0) + 1)
      }
    }
    for (const [dir, count] of directoryCounts) {
      if (count > 1) {
        cliLogger.warn(
          `Directory "${dir}" is registered in ${count} channels. Use channel_id to disambiguate.`,
        )
      }
    }

    // Prune stale entries if requested
    let finalEntries = enrichedWithGuild
    if (options.prune) {
      // Skip default roadie directory tombstones — those are preserved
      // intentionally so the tutorial channel isn't recreated after deletion.
      const defaultDir = getDefaultRoadieDirectory()
      const stale = finalEntries.filter(
        (ch) => ch.deleted && ch.isLocal && ch.directory !== defaultDir,
      )
      if (stale.length === 0) {
        cliLogger.log('No stale channels to prune')
      } else {
        for (const ch of stale) {
          await deleteChannelDirectoryById(ch.channel_id)
          cliLogger.log(`Pruned stale channel ${ch.channel_id} (${path.basename(ch.directory)})`)
        }
        cliLogger.log(`Pruned ${stale.length} stale channel(s)`)
      }
      finalEntries = finalEntries.filter((ch) => !ch.deleted)
      if (finalEntries.length === 0) {
        cliLogger.log('No projects registered')
        process.exit(0)
      }
    }

    if (finalEntries.length === 0) {
      cliLogger.log('No projects registered')
      process.exit(0)
    }

    if (options.json) {
      const output = finalEntries.map((ch) => ({
        channel_id: ch.channel_id,
        channel_name: ch.channelName,
        guild_id: ch.guildId,
        guild_name: ch.guildName,
        directory: ch.directory || null,
        folder_name: ch.directory ? path.basename(ch.directory) : null,
        deleted: ch.deleted,
        is_local: ch.isLocal,
      }))
      console.log(JSON.stringify(output, null, 2))
      process.exit(0)
    }

    for (const ch of finalEntries) {
      const deletedTag = ch.deleted ? ' (deleted from Discord)' : ''
      const remoteTag = !ch.isLocal ? ' [remote]' : ''
      const channelLabel = ch.channelName ? `#${ch.channelName}` : ch.channel_id
      const guildLabel = ch.guildName || ch.guildId || ''
      const guildSuffix = guildLabel ? ` (${guildLabel})` : ''
      console.log(`\n${channelLabel}${guildSuffix}${deletedTag}${remoteTag}`)
      if (ch.isLocal && ch.directory) {
        const folderName = path.basename(ch.directory)
        console.log(`   Folder: ${folderName}`)
        console.log(`   Directory: ${ch.directory}`)
      } else if (!ch.isLocal) {
        console.log(`   (Not registered on this machine)`)
      }
      console.log(`   Channel ID: ${ch.channel_id}`)
      if (ch.guildId) {
        console.log(`   Guild ID: ${ch.guildId}`)
      }
    }

    process.exit(0)
  })

cli
  .command(
    'project remove <channelId>',
    'Remove a project channel mapping from the local database (does not delete the Discord channel)',
  )
  .action(async (channelId: string) => {
    // Agent tool shells hold a per-session token, not database credentials;
    // the running bot removes the mapping and streams the same output back.
    const agent = resolveAgentCredentials()
    if (!(agent instanceof Error)) {
      const exitCode = await runAgentCommand({
        agent,
        request: {
          method: 'POST',
          path: AGENT_PROJECT_REMOVE_PATH,
          body: projectRemoveBody({ channelId }),
        },
      })
      process.exit(exitCode)
    }

    await initDatabase()

    const db = await getDb()
    const row = await db.query.channel_directories.findFirst({
      where: { channel_id: channelId },
    })

    if (!row) {
      cliLogger.error(`No channel mapping found for channel ID: ${channelId}`)
      process.exit(EXIT_NO_RESTART)
    }

    const removed = await deleteChannelDirectoryById(channelId)
    if (!removed) {
      cliLogger.error(`Channel mapping disappeared before it could be removed: ${channelId}`)
      process.exit(EXIT_NO_RESTART)
    }
    cliLogger.log(`Removed channel mapping:`)
    cliLogger.log(`  Channel ID: ${channelId}`)
    cliLogger.log(`  Directory: ${row.directory}`)
    cliLogger.log(`  Type: ${row.channel_type}`)
    process.exit(0)
  })

cli
  .command(
    'project open-in-discord [directory]',
    'Open a project channel in Discord (defaults to the current project)',
  )
  .action(async (directory: string | undefined) => {
    // Agent tool shells hold a per-session token, not database credentials;
    // the running bot resolves the channel and streams the same output back.
    const agent = resolveAgentCredentials()
    if (!(agent instanceof Error)) {
      // The bot's child process runs from the home directory, so the
      // caller's project directory (cwd default) is resolved here.
      const exitCode = await runAgentCommand({
        agent,
        request: {
          method: 'POST',
          path: AGENT_PROJECT_OPEN_IN_DISCORD_PATH,
          body: projectOpenInDiscordBody({ directory: path.resolve(directory || '.') }),
        },
      })
      process.exit(exitCode)
    }

    await initDatabase()

    const botRow = await getBotTokenWithMode()
    if (!botRow) {
      cliLogger.error('No bot configured. Run `roadie` first.')
      process.exit(EXIT_NO_RESTART)
    }

    const { token: botToken } = botRow
    const absolutePath = path.resolve(directory || '.')

    // Walk up parent directories to find a matching channel
    const findChannelForPath = async (
      dirPath: string,
    ): Promise<{ channel_id: string; directory: string } | undefined> => {
      const channels = await findChannelsByDirectory({
        directory: dirPath,
        channelType: 'text',
      })
      return channels[0]
    }

    let existingChannel: { channel_id: string; directory: string } | undefined
    let searchPath = absolutePath
    do {
      existingChannel = await findChannelForPath(searchPath)
      if (existingChannel) {
        break
      }
      const parent = path.dirname(searchPath)
      if (parent === searchPath) {
        break
      }
      searchPath = parent
    } while (true)

    if (!existingChannel) {
      cliLogger.error(`No project channel found for ${absolutePath}`)
      process.exit(EXIT_NO_RESTART)
    }

    // Fetch channel from Discord to get guild_id
    const rest = createDiscordRest(botToken)
    const channelData = (await rest.get(Routes.channel(existingChannel.channel_id))) as {
      id: string
      guild_id: string
    }

    const channelUrl = `https://discord.com/channels/${channelData.guild_id}/${channelData.id}`
    cliLogger.log(channelUrl)

    // Open in browser if running in a TTY
    if (process.stdout.isTTY) {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', channelUrl], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      } else {
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
        spawn(openCmd, [channelUrl], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      }
    }

    process.exit(0)
  })

cli
  .command(
    'project create <name>',
    'Removed: channels are bound to directories by --channels-config (ROADIE_CHANNELS_CONFIG)',
  )
  .option(
    '-g, --guild <guildId>',
    'Removed: channels are bound to directories by the channels config',
  )
  .option(
    '--projects-dir <path>',
    'Removed: channels are bound to directories by the channels config',
  )
  .action(async () => {
    cliLogger.error(
      '`roadie project create` was removed: Roadie no longer creates project folders or project channels. Create the folder yourself and bind a channel to its directory in the channels config file (--channels-config or ROADIE_CHANNELS_CONFIG).',
    )
    process.exit(EXIT_NO_RESTART)
  })

export default cli
