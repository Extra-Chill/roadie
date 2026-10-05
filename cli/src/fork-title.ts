// Fork naming uses only the new task prompt in a bounded title-only request.
// The fork's inherited conversation is never read or replayed for naming.
import * as orm from 'drizzle-orm'
import { getDb } from './database.js'
import * as schema from './schema.js'
import type { AgentBackend } from './agent-backend/types.js'
import type { AgentSession } from './agent-backend/events.js'
import { createLogger } from './logger.js'

const logger = createLogger('TITLE')
// In-flight request handles, not session state. The durable pending marker
// owns retry eligibility; this only coalesces concurrent turns for one fork.
const requests = new Map<string, Promise<void>>()

export type ForkTitleTurn = {
  prompt: string
  titlePrompt?: string
  command?: { name: string; arguments: string }
  noReply?: boolean
  contextOnly?: boolean
  isSleepWake?: boolean
  isRestartContinuation?: boolean
}

// Recovery turns continue execution; only an actual task supplies naming input.
export function forkTitlePrompt(input: ForkTitleTurn): string | null {
  if (input.noReply || input.contextOnly || input.isSleepWake || input.isRestartContinuation) return null
  return input.titlePrompt ?? (input.command ? `/${input.command.name} ${input.command.arguments}` : input.prompt)
}

export function schedulePendingForkTitle(input: Parameters<typeof applyPendingForkTitle>[0]): void {
  if (!input.prompt?.trim() || requests.has(input.session.id)) return
  const request = applyPendingForkTitle(input).then((result) => {
    if (result instanceof Error) logger.warn(`Fork ${input.session.id} title generation failed: ${result.message}`)
  }).catch((cause) => logger.warn('Fork title request failed:', cause)).finally(() => {
    requests.delete(input.session.id)
  })
  requests.set(input.session.id, request)
}

export function normalizeGeneratedForkTitle(generated: string): string | null {
  const text = generated.replace(/\s+/gu, ' ').trim()
  if (!text) return null
  const chars = Array.from(text)
  return chars.length > 100 ? `${chars.slice(0, 99).join('')}…` : text
}

export async function markPendingForkTitle(session: Pick<AgentSession, 'id' | 'title'>): Promise<void> {
  await (await getDb()).insert(schema.pending_fork_titles).values({ session_id: session.id, inherited_title: session.title }).onConflictDoNothing()
}

export async function applyPendingForkTitle({ session, prompt, backend, directory }: {
  session: Pick<AgentSession, 'id' | 'title'>
  prompt: string | null
  backend: AgentBackend
  directory: string
}): Promise<string | null | Error> {
  if (!prompt?.trim()) return null
  const db = await getDb()
  const pending = await db.select().from(schema.pending_fork_titles).where(orm.eq(schema.pending_fork_titles.session_id, session.id)).limit(1)
  const row = pending[0]
  if (!row) return null
  // A user explicitly renamed this session before its first message. Keep it.
  if (session.title !== row.inherited_title) {
    await db.delete(schema.pending_fork_titles).where(orm.eq(schema.pending_fork_titles.session_id, session.id))
    return null
  }
  // Claim the first task once, before inference (including unavailable models).
  // A retry after reconstruction must not replace it with a later turn.
  await db.update(schema.pending_fork_titles).set({ task_prompt: prompt }).where(orm.and(
    orm.eq(schema.pending_fork_titles.session_id, session.id),
    orm.isNull(schema.pending_fork_titles.task_prompt),
  ))
  const claimed = await db.select().from(schema.pending_fork_titles).where(orm.eq(schema.pending_fork_titles.session_id, session.id)).limit(1)
  const taskPrompt = claimed[0]?.task_prompt
  if (!taskPrompt || !backend.sessions.setTitle || !backend.sessions.generateTitle) return null
  const generated = await backend.sessions.generateTitle({ directory, prompt: taskPrompt })
  if (generated instanceof Error) return generated
  const cleaned = generated.replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').map((line) => line.trim()).find(Boolean)?.replace(/^['"`]+|['"`]+$/g, '')
  const taskTitle = cleaned ? normalizeGeneratedForkTitle(cleaned) : null
  if (!taskTitle) return new Error('Title model returned no usable title')
  // A title request runs independently of the task. Respect a user rename
  // made while the small model was responding.
  const current = await backend.sessions.get({ sessionId: session.id, directory })
  if (current instanceof Error) return current
  if (!current || current.title !== row.inherited_title) {
    await db.delete(schema.pending_fork_titles).where(orm.eq(schema.pending_fork_titles.session_id, session.id))
    return null
  }
  const result = await backend.sessions.setTitle({ sessionId: session.id, directory, title: taskTitle })
  if (result instanceof Error) return result
  await db.delete(schema.pending_fork_titles).where(orm.eq(schema.pending_fork_titles.session_id, session.id))
  return taskTitle
}
