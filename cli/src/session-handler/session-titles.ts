// session titles operations used by ThreadSessionRuntime.

import * as orm from 'drizzle-orm'
import { getDb, getThreadLastSyncedName } from '../database.js'
import { DISCORD_THREAD_RENAME_TIMEOUT_MS, raceDiscordRename } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as schema from '../schema.js'
import { resolveAutoThreadRename } from './thread-name.js'
import type { ThreadSessionRuntime } from './thread-session-runtime.js'

const logger = createLogger(LogPrefix.SESSION)

// Explicit dependencies keep orchestration and resource ownership in the runtime.
type RuntimeContext = {
  state: ThreadSessionRuntime['state']
  appliedSessionTitle: ThreadSessionRuntime['appliedSessionTitle']
  chat: ThreadSessionRuntime['chat']
  threadId: ThreadSessionRuntime['threadId']
}

export async function handleSessionUpdated(
  runtime: Pick<RuntimeContext, 'state' | 'appliedSessionTitle' | 'chat' | 'threadId'>,
  info: {
    id: string
    title: string
  },
): Promise<void> {
  // Only act on the main session for this thread
  if (info.id !== runtime.state?.sessionId) {
    return
  }
  const normalizedTitle = info.title.trim()
  if (runtime.appliedSessionTitle === normalizedTitle) {
    return
  }
  if (!runtime.chat.capabilities.rename) {
    await (await getDb())
      .update(schema.thread_sessions)
      .set({ last_synced_name: normalizedTitle })
      .where(orm.eq(schema.thread_sessions.thread_id, runtime.threadId))
    const synced = await runtime.chat.syncTitle?.(normalizedTitle)
    if (synced instanceof Error)
      logger.warn('Could not synchronize native chat title:', synced)
    runtime.appliedSessionTitle = normalizedTitle
    return
  }
  const lastSyncedName = await getThreadLastSyncedName(runtime.threadId)
  const desiredName = resolveAutoThreadRename({
    sessionTitle: info.title,
    currentName: runtime.chat.name,
    lastSyncedName,
  })
  // Mark before setName so concurrent session.updated events don't stack
  // renames. Keep the mark on failure — retry is almost always a rate limit.
  runtime.appliedSessionTitle = normalizedTitle
  if (!desiredName) {
    return
  }

  const renameResult = await raceDiscordRename({
    rename: runtime.chat.rename(desiredName).catch(
      (e) =>
        new Error('Failed to rename thread from session title', {
          cause: e,
        }),
    ),
  })

  if (renameResult === 'timeout') {
    logger.warn(
      `[TITLE] setName timed out after ${DISCORD_THREAD_RENAME_TIMEOUT_MS}ms for thread ${runtime.threadId} (likely rate-limited)`,
    )
    return
  }
  if (renameResult instanceof Error) {
    logger.warn(
      `[TITLE] Could not rename thread ${runtime.threadId}: ${renameResult.message}`,
    )
    return
  }
  // Record the name we applied so restarts dedupe against it and manual
  // renames can be detected. Fail soft: the rename itself already succeeded.
  try {
    await (await getDb())
      .update(schema.thread_sessions)
      .set({ last_synced_name: desiredName })
      .where(orm.eq(schema.thread_sessions.thread_id, runtime.threadId))
  } catch (error) {
    logger.warn(
      `[TITLE] Could not record applied name for thread ${runtime.threadId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  logger.log(
    `[TITLE] Renamed thread ${runtime.threadId} to "${desiredName}" from agent session title`,
  )
}
