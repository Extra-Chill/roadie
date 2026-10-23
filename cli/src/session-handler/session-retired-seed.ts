// session retired seed operations used by ThreadSessionRuntime.

import { agentBackendLabel } from '../agent-backend/registry.js'
import type { AgentBackend } from '../agent-backend/types.js'
import { createLogger, LogPrefix } from '../logger.js'
import { asSubtext } from '../message-formatting.js'
import {
  buildRetiredSessionSeed,
  RETIRED_SEED_HISTORY_LIMIT,
} from './retired-session-seed.js'
import type { ThreadSessionRuntime } from './thread-session-runtime.js'

const logger = createLogger(LogPrefix.SESSION)

// Explicit dependencies keep orchestration and resource ownership in the runtime.
type RuntimeContext = {
  chat: ThreadSessionRuntime['chat']
  thread: ThreadSessionRuntime['thread']
  sdkDirectory: ThreadSessionRuntime['sdkDirectory']
}

export async function seedFromRetiredSession(
  runtime: Pick<RuntimeContext, 'chat' | 'thread' | 'sdkDirectory'>,
  {
    client,
    sessionId,
    retiredSessionId,
    sourceMessageId,
  }: {
    client: AgentBackend
    sessionId: string
    retiredSessionId: string
    sourceMessageId?: string
  },
): Promise<void> {
  const backend = agentBackendLabel()
  const history = await runtime.chat.readRecentMessages?.(RETIRED_SEED_HISTORY_LIMIT)
  if (history instanceof Error) {
    logger.warn(
      `[RETIRED SESSION] Cannot read thread ${runtime.thread.id} history: ${history.message}`,
    )
  }
  const seeded = await client.sessions.prompt({
    sessionId,
    directory: runtime.sdkDirectory,
    parts: [
      {
        kind: 'text',
        synthetic: true,
        text: buildRetiredSessionSeed({
          retiredSessionId,
          history,
          excludeMessageId: sourceMessageId,
        }),
      },
    ],
    noReply: true,
  })
  if (seeded instanceof Error) {
    logger.warn(
      `[RETIRED SESSION] Cannot seed ${sessionId} from thread ${runtime.thread.id}: ${seeded.message}`,
    )
  }
  logger.log(
    `[RETIRED SESSION] Thread ${runtime.thread.id} moved from retired session ${retiredSessionId} to ${backend} session ${sessionId}`,
  )
  await runtime.chat.sendNotice(
    asSubtext(
      `This thread's earlier session can't be resumed, so it moved to a new ${backend} session that starts from this thread's recent messages.`,
    ),
  )
}
