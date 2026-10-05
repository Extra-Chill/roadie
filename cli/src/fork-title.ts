// Fork naming uses only the new task prompt. No history reads, model requests,
// temporary sessions or additional user turns are involved.
import * as orm from 'drizzle-orm'
import { getDb } from './database.js'
import * as schema from './schema.js'
import type { AgentBackend } from './agent-backend/types.js'
import type { AgentSession } from './agent-backend/events.js'

export function forkTaskTitle(prompt: string): string | null {
  const text = prompt.replace(/\s+/gu, ' ').trim()
  if (!text) return null
  const chars = Array.from(text)
  return chars.length > 100 ? `${chars.slice(0, 99).join('')}…` : text
}

export async function markPendingForkTitle(session: Pick<AgentSession, 'id' | 'title'>): Promise<void> {
  await (await getDb()).insert(schema.pending_fork_titles).values({ session_id: session.id, inherited_title: session.title }).onConflictDoNothing()
}

export async function applyPendingForkTitle({ session, prompt, backend, directory }: {
  session: Pick<AgentSession, 'id' | 'title'>
  prompt: string
  backend: AgentBackend
  directory: string
}): Promise<string | null | Error> {
  const title = forkTaskTitle(prompt)
  if (!title || !backend.sessions.setTitle) return null
  const db = await getDb()
  const pending = await db.select().from(schema.pending_fork_titles).where(orm.eq(schema.pending_fork_titles.session_id, session.id)).limit(1)
  const row = pending[0]
  if (!row) return null
  // A user explicitly renamed this session before its first message. Keep it.
  if (session.title !== row.inherited_title) {
    await db.delete(schema.pending_fork_titles).where(orm.eq(schema.pending_fork_titles.session_id, session.id))
    return null
  }
  const result = await backend.sessions.setTitle({ sessionId: session.id, directory, title })
  if (result instanceof Error) return result
  await db.delete(schema.pending_fork_titles).where(orm.eq(schema.pending_fork_titles.session_id, session.id))
  return title
}
