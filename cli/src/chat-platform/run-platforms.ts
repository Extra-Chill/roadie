// Chat platform service orchestration (#297).
//
// One process, one data dir, one or more chat platforms. The shared services
// every platform depends on — the in-process Hrana server (which also holds
// the single-instance lock port) and the database — start once here; then
// each requested platform connects its own ingress through the registry.
// Sessions, the queue, the scheduler, credential pools, identity and
// `roadie send` are shared across all of them.

import path from 'node:path'
import { getDataDir } from '../config.js'
import { startHranaServer, stopHranaServer } from '../hrana-server.js'
import { closeDatabase, initDatabase } from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  startChatPlatforms,
  stopActiveChatPlatforms,
  type ChatPlatformStartContext,
} from './registry.js'

const logger = createLogger(LogPrefix.CLI)

/**
 * Start shared services, then every requested platform. On success returns
 * the local Hrana URL and a stop handle; on failure shared services are torn
 * down again and the Error is returned. A single platform failing to start
 * is not a failure here: startChatPlatforms (#304) records it for /health
 * and returns an Error only when nothing started or a required platform
 * failed.
 *
 * Shutdown: when Discord is among the platforms, its lifecycle handlers
 * (registerBotLifecycleHandlers) own process signals and stop the other
 * platforms through stopActiveChatPlatforms(). Otherwise a generic SIGTERM /
 * SIGINT handler is installed here, mirroring what the native Slack entry
 * point used to do on its own.
 */
export async function runChatPlatforms(
  context: ChatPlatformStartContext,
): Promise<Error | { url: string; stop(): Promise<void> }> {
  const hrana = await startHranaServer({
    dbPath: path.join(getDataDir(), 'discord-sessions.db'),
  })
  if (hrana instanceof Error) return hrana
  await initDatabase()

  const started = await startChatPlatforms(context)
  if (started instanceof Error) {
    await closeDatabase()
    await stopHranaServer()
    return started
  }

  if (!context.platformIds.includes('discord')) {
    const [{ recordInterruptedSessions }, { snapshotBusyRuntimes }, { stopAgentBackend }] =
      await Promise.all([
        import('../service-lifecycle.js'),
        import('../session-handler/runtime-registry.js'),
        import('../agent-backend/registry.js'),
      ])
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      recordInterruptedSessions(snapshotBusyRuntimes())
      const deadline = setTimeout(() => process.exit(1), 15_000)
      void (async () => {
        await stopActiveChatPlatforms()
        await stopAgentBackend()
        await closeDatabase()
        await stopHranaServer()
        clearTimeout(deadline)
      })().catch((error) => logger.error('Chat platform shutdown failed', error))
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  }

  return { url: hrana, stop: started.stop }
}
