// Upgrade and maintenance terminal commands.
import { hostUpgradeHandler, isManagedInstall, MANAGED_UPGRADE_MESSAGE, runHostUpgrade } from '../service-lifecycle.js'
import { loadPlugins, resolvePluginSpecs } from '../plugins.js'
import { goke } from 'goke'
import { z } from 'zod'
import { note } from '@clack/prompts'
import YAML from 'yaml'
import * as errore from 'errore'
import type { OpencodeClient, Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { Events, ActivityType, type PresenceStatusData, type Guild, Routes } from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createLogger, LogPrefix, initLogFile } from '../logger.js'
import { createDiscordClient, initDatabase, getChannelDirectory, initializeOpencodeForDirectory, createProjectChannels } from '../discord-bot.js'
import { getBotTokenWithMode, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory } from '../database.js'
import { ShareMarkdown } from '../markdown.js'
import { parseSessionSearchPattern, findFirstSessionSearchHit, buildSessionSearchSnippet, getPartSearchTexts } from '../session-search.js'
import type { ThreadStartMarker } from '../system-message.js'
import { buildOpencodeEventLogLine } from '../session-handler/opencode-session-event-log.js'
import { createDiscordRest } from '../discord-urls.js'
import { archiveThread, uploadFilesToDiscord, stripMentions } from '../discord-utils.js'
import { setDataDir, setProjectsDir, getDataDir, getProjectsDir } from '../config.js'
import { execAsync, validateWorktreeDirectory } from '../git-utils.js'
import { upgrade, getCurrentVersion } from '../upgrade.js'
import { getPromptPreview, parseSendAtValue, parseScheduledTaskPayload, serializeScheduledTaskPayload, type ScheduledTaskPayload } from '../task-schedule.js'
import {
  EXIT_NO_RESTART,
  formatMemberLookupUnavailableMessage,
  formatRelativeTime,
  formatTaskScheduleLine,
  isDiscordMemberLookupUnavailable,
  isGuildMemberSearchResult,
  isThreadChannelType,
  printDiscordInstallUrlAndExit,
  resolveBotCredentials,
  resolveDiscordUserOption,
  sendDiscordMessageWithOptionalAttachment,
} from '../cli-runner.js'
import { AGENT_OPERATOR_ONLY_MESSAGE, isAgentMode } from '../agent-remote.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

cli
  .command(
    'upgrade',
    'Upgrade roadie to the latest version and restart the running bot',
  )
  .option('--skip-restart', 'Only upgrade, do not restart the running bot')
  .action(async (options) => {
    // Upgrading is an operator action: agent shells have neither the database
    // credentials nor the daemon lifecycle. The system prompt tells agents to
    // ask the user instead.
    if (isAgentMode()) {
      cliLogger.error(AGENT_OPERATOR_ONLY_MESSAGE)
      process.exit(EXIT_NO_RESTART)
    }
    if (isManagedInstall()) {
      // The host registers its upgrade path from a plugin (ROADIE_PLUGINS).
      const loaded = await loadPlugins(resolvePluginSpecs([]))
      if (loaded instanceof Error) {
        cliLogger.error(loaded.message)
        process.exit(1)
      }
      const handler = hostUpgradeHandler()
      if (!handler) {
        cliLogger.error(MANAGED_UPGRADE_MESSAGE)
        process.exit(1)
      }
      const result = await runHostUpgrade(handler, 'cli')
      if (result.ok) cliLogger.log(result.message)
      else cliLogger.error(result.message)
      process.exit(result.ok ? 0 : 1)
    }
    try {
      const current = getCurrentVersion()
      cliLogger.log(`Current version: v${current}`)

      const newVersion = await upgrade()
      if (!newVersion) {
        cliLogger.log('Already on latest version')
        process.exit(0)
      }

      cliLogger.log(`Upgraded to v${newVersion}`)

      if (options.skipRestart) {
        process.exit(0)
      }

      // Spawn a new roadie process without args (starts the bot with default command).
      // The new process kills the old one via the single-instance lock.
      // No args passed to avoid recursively running `upgrade` again.
      const child = spawn('roadie', [], {
        shell: true,
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
      cliLogger.log('Restarting bot with new version...')
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Upgrade failed:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

export default cli
