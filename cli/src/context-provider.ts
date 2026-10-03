// Host context provider: a generic memory/context API.
//
// Roadie ships no memory system. A host command (ROADIE_CONTEXT_PROVIDER or
// --context-provider) supplies context sections for a session, so any memory
// provider can plug in. It receives one JSON object on stdin and prints one
// JSON object on stdout:
//
//   stdin  { "version": 1, "event": "session_start" | "turn",
//            "session_id": "...", "thread_id": "...", "channel_id": "...",
//            "directory": "...",
//            "actor": { "platform": "discord", "id": "...", "name": "..." },
//            "person_id": "..." }
//   stdout { "sections": [ { "id": "user-memory", "title": "...", "content": "..." } ] }
//
// session_start sections are appended once to the session's pinned system
// prompt. turn sections are attached to that turn only, and the provider is
// asked again only when the speaker (actor/person) differs from the previous
// turn, so shared threads get each speaker's context without busting the
// prompt cache.
//
// Read-only: writing memory stays with the agent, through the provider's own
// tools. Fails open: a provider error, timeout or invalid output means no
// injected context for that call, logged, never a blocked message.

import { applyFiltersAsync, hasFilter } from './hooks.js'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { getRoadieEnv } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.SESSION)

export const CONTEXT_PROVIDER_VERSION = 1
const TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_SECTION_CHARS = 64 * 1024
const MAX_TOTAL_CHARS = 128 * 1024

export type ContextEvent = 'session_start' | 'turn'

export type ContextRequest = {
  event: ContextEvent
  sessionId: string
  threadId?: string
  channelId?: string
  directory?: string
  actor?: { platform: string; id: string; name?: string }
  personId?: string
}

export type ContextSection = { id: string; title?: string; content: string }

const outputSchema = z.object({
  sections: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        title: z.string().max(200).optional(),
        content: z.string(),
      }),
    )
    .max(50),
})

let commandOverride: string | null | undefined

/** Set or clear the provider command (CLI flag, tests). `undefined` = use env. */
export function setContextProviderCommand(command: string | null | undefined) {
  commandOverride = command
}

export function getContextProviderCommand(): string | undefined {
  if (commandOverride !== undefined) return commandOverride ?? undefined
  return getRoadieEnv('ROADIE_CONTEXT_PROVIDER')?.trim() || undefined
}

/** True when a context provider command or a `context_sections` filter is in place. */
export function isContextProviderConfigured(): boolean {
  return Boolean(getContextProviderCommand()) || hasFilter('context_sections')
}

/** Ask the host for context. Returns [] when unconfigured or on any failure. */
export async function requestContext(request: ContextRequest): Promise<ContextSection[]> {
  const fromCommand = await requestCommandContext(request)
  const sections = await applyFiltersAsync('context_sections', fromCommand, request)
  return boundSections(sections)
}

async function requestCommandContext(request: ContextRequest): Promise<ContextSection[]> {
  const command = getContextProviderCommand()
  if (!command) return []
  const input = JSON.stringify({
    version: CONTEXT_PROVIDER_VERSION,
    event: request.event,
    session_id: request.sessionId,
    ...(request.threadId ? { thread_id: request.threadId } : {}),
    ...(request.channelId ? { channel_id: request.channelId } : {}),
    ...(request.directory ? { directory: request.directory } : {}),
    ...(request.actor ? { actor: request.actor } : {}),
    ...(request.personId ? { person_id: request.personId } : {}),
  })
  const raw = await execProvider({ command, input }).catch((e: unknown) =>
    e instanceof Error ? e : new Error(String(e)),
  )
  if (raw instanceof Error) {
    logger.warn(`[CONTEXT] provider failed for ${request.event} ${request.sessionId}: ${raw.message}`)
    return []
  }
  let parsed: z.infer<typeof outputSchema>
  try {
    const result = outputSchema.safeParse(JSON.parse(raw))
    if (!result.success) throw new Error(result.error.issues[0]?.message || 'invalid output')
    parsed = result.data
  } catch (e) {
    logger.warn(
      `[CONTEXT] provider returned invalid output for ${request.event} ${request.sessionId}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return []
  }
  return parsed.sections
}

function boundSections(sections: ContextSection[]): ContextSection[] {
  const out: ContextSection[] = []
  let total = 0
  for (const section of sections) {
    const content = section.content.trim()
    if (!content) continue
    const clipped =
      content.length > MAX_SECTION_CHARS ? `${content.slice(0, MAX_SECTION_CHARS)}\n…[truncated]` : content
    if (total + clipped.length > MAX_TOTAL_CHARS) {
      logger.warn(`[CONTEXT] dropping sections after "${section.id}": context exceeds ${MAX_TOTAL_CHARS} chars`)
      break
    }
    total += clipped.length
    out.push({ ...section, content: clipped })
  }
  return out
}

/** Render sections as a block for the system prompt or a turn part. */
export function renderContextSections(sections: ContextSection[]): string {
  if (sections.length === 0) return ''
  const body = sections
    .map((section) => {
      const title = section.title ? ` title="${section.title.replaceAll('"', '&quot;')}"` : ''
      return `<context id="${section.id.replaceAll('"', '&quot;')}"${title}>\n${section.content}\n</context>`
    })
    .join('\n\n')
  return `\n<host-context>\n${body}\n</host-context>\n`
}

/** Stable key for "who is speaking" so per-turn context is only refetched on change. */
export function speakerKey(request: Pick<ContextRequest, 'actor' | 'personId'>): string {
  if (request.personId) return `person:${request.personId}`
  if (request.actor) return `${request.actor.platform}:${request.actor.id}`
  return 'none'
}

function execProvider({ command, input }: { command: string; input: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)))
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish(() => reject(new Error('output too large')))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString('utf8')
    })
    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(`exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`))
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
