// /upgrade-and-restart command - Upgrade roadie to the latest version and restart the bot.
// Checks GitHub releases for a newer version, installs it globally, then spawns a new roadie process.
// The new process kills the old one on startup (roadie's single-instance lock).

import { hostUpgradeHandler, isManagedInstall, MANAGED_UPGRADE_MESSAGE, runHostUpgrade } from '../service-lifecycle.js'
import type { CommandContext } from './types.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getCurrentVersion, upgrade } from '../upgrade.js'
import { spawn } from 'node:child_process'
import { MessageFlags } from 'discord.js'

const logger = createLogger(LogPrefix.CLI)

export async function handleUpgradeAndRestartCommand({
  command,
}: CommandContext): Promise<void> {
  if (isManagedInstall()) {
    const handler = hostUpgradeHandler()
    if (!handler) {
      await command.reply({ content: MANAGED_UPGRADE_MESSAGE, flags: MessageFlags.Ephemeral })
      return
    }
    await command.deferReply()
    logger.log('[UPGRADE] /upgrade-and-restart: triggering host upgrade')
    const result = await runHostUpgrade(handler, 'command')
    await command.editReply({ content: result.message })
    return
  }
  await command.deferReply()

  logger.log('[UPGRADE] /upgrade-and-restart triggered')

  try {
    const currentVersion = getCurrentVersion()
    const newVersion = await upgrade()

    if (!newVersion) {
      await command.editReply({
        content: `Already on latest version: **v${currentVersion}**`,
      })
      return
    }

    await command.editReply({
      content: `Upgraded roadie **v${currentVersion}** -> **v${newVersion}**. Restarting bot...`,
    })

    // The upgrade installed the release tarball globally, so bare `roadie`
    // resolves to the new version.
    const child = spawn('roadie', process.argv.slice(2), {
      shell: true,
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
    logger.debug('Started new background roadie')
  } catch (error) {
    logger.error('[UPGRADE] Failed:', error)
    await command.editReply({
      content: `Upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}
