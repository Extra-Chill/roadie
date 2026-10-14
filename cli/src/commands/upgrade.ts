// /upgrade-and-restart command - Upgrade roadie to the latest version and restart the bot.
// Checks GitHub releases for a newer version, installs it globally, then spawns a new roadie process.
// The new process kills the old one on startup (roadie's single-instance lock).
// Agent `roadie upgrade` operator requests run the same bot-side upgrade.

import { hostUpgradeHandler, isManagedInstall, MANAGED_UPGRADE_MESSAGE, runHostUpgrade } from '../service-lifecycle.js'
import type { CommandContext } from './types.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getCurrentVersion, upgrade } from '../upgrade.js'
import { spawn } from 'node:child_process'
import { MessageFlags } from 'discord.js'

const logger = createLogger(LogPrefix.CLI)

/**
 * Outcome of an upgrade run by the bot. `restart` says who restarts Roadie
 * afterwards: the host (managed installs, later and on its own), this bot
 * (`restartBot()`, once the result is posted), or nobody.
 */
export type BotUpgradeResult = { ok: boolean; message: string; restart: 'none' | 'host' | 'self' }

/** Upgrade from inside the running bot. Never throws. */
export async function runBotUpgrade(): Promise<BotUpgradeResult> {
  if (isManagedInstall()) {
    const handler = hostUpgradeHandler()
    if (!handler) return { ok: false, message: MANAGED_UPGRADE_MESSAGE, restart: 'none' }
    logger.log('[UPGRADE] triggering host upgrade')
    const result = await runHostUpgrade(handler, 'command')
    return { ...result, restart: result.ok ? 'host' : 'none' }
  }
  try {
    const currentVersion = getCurrentVersion()
    const newVersion = await upgrade()
    if (!newVersion) {
      return { ok: true, message: `Already on latest version: **v${currentVersion}**`, restart: 'none' }
    }
    return { ok: true, message: `Upgraded roadie **v${currentVersion}** -> **v${newVersion}**.`, restart: 'self' }
  } catch (error) {
    logger.error('[UPGRADE] Failed:', error)
    return { ok: false, message: `Upgrade failed: ${error instanceof Error ? error.message : String(error)}`, restart: 'none' }
  }
}

/**
 * Start the upgraded bot. The upgrade installed the release tarball globally,
 * so bare `roadie` resolves to the new version; it evicts this process through
 * the single-instance lock, whose graceful shutdown records restart continuations.
 */
export function restartBot(): void {
  const child = spawn('roadie', process.argv.slice(2), {
    shell: true,
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  logger.debug('Started new background roadie')
}

export async function handleUpgradeAndRestartCommand({
  command,
}: CommandContext): Promise<void> {
  if (isManagedInstall() && !hostUpgradeHandler()) {
    await command.reply({ content: MANAGED_UPGRADE_MESSAGE, flags: MessageFlags.Ephemeral })
    return
  }
  await command.deferReply()
  logger.log('[UPGRADE] /upgrade-and-restart triggered')
  const result = await runBotUpgrade()
  await command.editReply({
    content: result.restart === 'self' ? `${result.message} Restarting bot...` : result.message,
  })
  if (result.restart === 'self') restartBot()
}
