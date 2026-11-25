// Read a Pi session's history straight from its `.jsonl` file (#477).
//
// Pi's RPC `get_messages` answers with the agent's in-memory messages, which
// Pi builds on load from the session file: the path from the last entry back
// to the root, compaction-aware, with branch summaries, custom messages and
// context edits projected into messages (buildSessionProjection in Pi's
// session-manager). This is the same projection, so a session that is not
// running can be read without starting a `pi --mode rpc` process for it.
//
// Anything this reader does not know how to project exactly (a newer session
// version, an unknown entry type on the active path) is an error, and the
// caller falls back to asking Pi itself.

import fs from 'node:fs'
import * as errore from 'errore'
import type { PiMessage } from './events.js'

/** The session file format version this reader projects (Pi's CURRENT_SESSION_VERSION). */
export const PI_SESSION_VERSION = 3

/** Entry types Pi 3.x writes; only the context-bearing ones produce messages. */
const KNOWN_ENTRY_TYPES = new Set([
  'message',
  'model_change',
  'thinking_level_change',
  'usage',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
  'context_edit',
])

export class PiSessionFileError extends errore.createTaggedError({
  name: 'PiSessionFileError',
  message: '$detail',
}) {}

type Entry = {
  type: string
  id: string
  parentId?: string | null
  timestamp?: string
  [key: string]: unknown
}

function parseEntries(content: string): Entry[] {
  const entries: Entry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as Entry
      if (entry && typeof entry === 'object') entries.push(entry)
    } catch {
      // Pi skips malformed lines too (a torn final write).
    }
  }
  return entries
}

/** v1 → v2: chain entries into a tree; v2 → v3: hookMessage became custom. Mutates in place, like Pi. */
function migrate(entries: Entry[], version: number): void {
  if (version < 2) {
    let previous: string | null = null
    let next = 0
    for (const entry of entries) {
      if (entry.type === 'session') continue
      entry.id = `v1-${next++}`
      entry.parentId = previous
      previous = entry.id
      if (entry.type === 'compaction' && typeof entry['firstKeptEntryIndex'] === 'number') {
        const target = entries[entry['firstKeptEntryIndex'] as number]
        if (target && target.type !== 'session') entry['firstKeptEntryId'] = target.id
        delete entry['firstKeptEntryIndex']
      }
    }
  }
  if (version < 3) {
    for (const entry of entries) {
      const message = entry['message'] as { role?: string } | undefined
      if (entry.type === 'message' && message?.role === 'hookMessage') message.role = 'custom'
    }
  }
}

function timeOf(timestamp: unknown): number {
  return new Date(timestamp as string).getTime()
}

/** One entry's messages (Pi's sessionEntryToContextMessages). */
function entryMessages(entry: Entry): PiMessage[] {
  if (entry.type === 'message') {
    const message = entry['message'] as PiMessage & { content?: unknown }
    if (!message || typeof message !== 'object') return []
    if (message.role === 'system' && message.content == null) return [{ ...message, content: '' }]
    if ((message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') && message.content == null) {
      return [{ ...message, content: [] } as PiMessage]
    }
    return [message]
  }
  if (entry.type === 'custom_message') {
    return [{
      role: 'custom',
      customType: entry['customType'],
      content: entry['content'] ?? [],
      display: entry['display'],
      details: entry['details'],
      timestamp: timeOf(entry.timestamp),
    } as PiMessage]
  }
  if (entry.type === 'branch_summary' && entry['summary']) {
    return [{ role: 'branchSummary', summary: entry['summary'], fromId: entry['fromId'], timestamp: timeOf(entry.timestamp) } as PiMessage]
  }
  if (entry.type === 'compaction') {
    const summary = { role: 'compactionSummary', summary: entry['summary'], tokensBefore: entry['tokensBefore'], timestamp: timeOf(entry.timestamp) } as PiMessage
    return entry['systemMessage'] ? [entry['systemMessage'] as PiMessage, summary] : [summary]
  }
  return []
}

/** A context edit's replacement applied to an entry's messages (Pi's projectContextEntry). */
function applyEdit(messages: PiMessage[], edit: Entry | undefined): PiMessage[] {
  if (!edit) return messages
  const replacement = edit['replacement'] as { content?: unknown } | null | undefined
  if (replacement === null) return []
  return messages.map((message) => {
    if (!['user', 'assistant', 'toolResult', 'custom'].includes(message.role)) return message
    const content = (message.role === 'assistant' || message.role === 'toolResult') && typeof replacement?.content === 'string'
      ? [{ type: 'text', text: replacement.content }]
      : replacement?.content
    return { ...message, content } as PiMessage
  })
}

/**
 * The messages Pi's `get_messages` returns for a freshly loaded session file:
 * the active (last-entry) path, compaction-aware, projected to messages.
 */
export function projectPiSessionEntries(content: string): PiMessage[] | PiSessionFileError {
  const entries = parseEntries(content)
  const header = entries.find((entry) => entry.type === 'session')
  if (!header) return new PiSessionFileError({ detail: 'Pi session file has no session header' })
  const version = typeof header['version'] === 'number' ? header['version'] : 1
  if (version > PI_SESSION_VERSION) {
    return new PiSessionFileError({ detail: `Pi session file version ${version} is newer than ${PI_SESSION_VERSION}` })
  }
  migrate(entries, version)
  const body = entries.filter((entry) => entry.type !== 'session')
  const byId = new Map(body.map((entry) => [entry.id, entry]))
  // The active path: from the last entry (Pi's leaf after load) to the root.
  const path: Entry[] = []
  const seen = new Set<Entry>()
  for (let current = body.at(-1); current && !seen.has(current); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current)
    path.push(current)
  }
  path.reverse()
  const unknown = path.find((entry) => !KNOWN_ENTRY_TYPES.has(entry.type))
  if (unknown) return new PiSessionFileError({ detail: `Pi session file has an unknown entry type ${unknown.type}` })
  // Compaction: the latest compaction stands for everything before its first
  // kept entry (Pi's buildContextEntries).
  const compaction = path.findLast((entry) => entry.type === 'compaction')
  let contextEntries = path
  if (compaction) {
    const index = path.indexOf(compaction)
    contextEntries = [compaction]
    let kept = false
    for (const entry of path.slice(0, index)) {
      if (entry.id === compaction['firstKeptEntryId']) kept = true
      const message = entry['message'] as { role?: string } | undefined
      if (kept && !(entry.type === 'message' && message?.role === 'system')) contextEntries.push(entry)
    }
    contextEntries.push(...path.slice(index + 1))
  }
  const edits = new Map<unknown, Entry>()
  for (const entry of contextEntries) {
    if (entry.type === 'context_edit') edits.set(entry['targetId'], entry)
  }
  return contextEntries.flatMap((entry, index) =>
    // Only the newest compaction, at index 0, contributes its summary.
    entry.type === 'compaction' && index > 0 ? [] : applyEdit(entryMessages(entry), edits.get(entry.id)))
}

/** Read and project a Pi session file without starting Pi. */
export function readPiSessionMessages(file: string): PiMessage[] | PiSessionFileError {
  let content: string
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return new PiSessionFileError({ detail: `Could not read Pi session file ${file}`, cause: error })
  }
  return projectPiSessionEntries(content)
}
