// Retired sessions (#177). A thread bound to a session the agent backend does
// not own (e.g. one from a retired backend) starts a new session on
// its next prompt. The new session gets one context-only message built here: the
// thread's recent chat history, bounded, plus a note that the earlier
// session's tool state did not carry over.

import type { ChatHistoryMessage, ChatThread } from '../chat-platform/types.js'
import type { AgentBackend } from '../agent-backend/types.js'
import { agentBackendLabel } from '../agent-backend/registry.js'
import { asSubtext } from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.SESSION)

/** Seed a replacement session and notify the thread; failures never stop the turn. */
export async function seedFromRetiredSession(
  client: AgentBackend,
  chat: ChatThread,
  threadId: string,
  directory: string,
  sessionId: string,
  retiredSessionId: string,
  sourceMessageId?: string,
): Promise<void> {
  const backend = agentBackendLabel()
  const history = await chat.readRecentMessages?.(RETIRED_SEED_HISTORY_LIMIT)
  if (history instanceof Error) {
    logger.warn(`[RETIRED SESSION] Cannot read thread ${threadId} history: ${history.message}`)
  }
  const seeded = await client.sessions.prompt({
    sessionId,
    directory,
    parts: [{
      kind: 'text',
      synthetic: true,
      text: buildRetiredSessionSeed({ retiredSessionId, history, excludeMessageId: sourceMessageId }),
    }],
    noReply: true,
  })
  if (seeded instanceof Error) {
    logger.warn(`[RETIRED SESSION] Cannot seed ${sessionId} from thread ${threadId}: ${seeded.message}`)
  }
  logger.log(`[RETIRED SESSION] Thread ${threadId} moved from retired session ${retiredSessionId} to ${backend} session ${sessionId}`)
  await chat.sendNotice(asSubtext(
    `This thread's earlier session can't be resumed, so it moved to a new ${backend} session that starts from this thread's recent messages.`,
  ))
}

/** Messages read from the thread for the seed. */
export const RETIRED_SEED_HISTORY_LIMIT = 60
/** Character budget for the history part of the seed; the newest messages win. */
export const RETIRED_SEED_MAX_CHARS = 16_000
/** One message's share of the budget; longer messages are cut. */
const MESSAGE_MAX_CHARS = 2_000

export function buildRetiredSessionSeed({
  retiredSessionId,
  history,
  excludeMessageId,
  maxChars = RETIRED_SEED_MAX_CHARS,
}: {
  retiredSessionId: string
  history: ChatHistoryMessage[] | Error | undefined
  /** The message that triggered this turn; it arrives as the prompt itself. */
  excludeMessageId?: string
  maxChars?: number
}): string {
  const header = [
    `[Session moved] This thread was running session ${retiredSessionId}, which the current agent backend cannot resume. This is a new session.`,
    `Files, tool results, todos and the earlier session's full transcript did not carry over; only the chat messages below did. Re-read files before relying on them.`,
  ]
  const lines: string[] = []
  let used = 0
  const messages = Array.isArray(history) ? history : []
  for (const message of [...messages].reverse()) {
    if (message.id === excludeMessageId) continue
    const text = message.text.trim()
    if (!text) continue
    const clipped = text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS)}…` : text
    const line = `${message.fromBot ? 'assistant' : message.author}: ${clipped}`
    if (used + line.length > maxChars) break
    lines.unshift(line)
    used += line.length
  }
  if (lines.length === 0) {
    header.push(history instanceof Error || history === undefined
      ? 'The thread history could not be read; ask the user for context if the request depends on it.'
      : 'The thread has no earlier messages.')
    return header.join('\n')
  }
  const omitted = lines.length < messages.filter((m) => m.id !== excludeMessageId && m.text.trim()).length
  header.push(`Recent thread messages, oldest first${omitted ? ' (older ones omitted)' : ''}:`)
  return [...header, '', ...lines].join('\n')
}
