// Session-to-markdown renderer for sharing.
// Generates shareable markdown from OpenCode sessions, formatting
// user messages, assistant responses, tool calls, and reasoning blocks.

import type { AgentMessage, AgentPart } from './agent-backend/events.js'
import type { AgentBackend } from './agent-backend/types.js'
import YAML from 'yaml'
import { formatDateTime } from './utils.js'
import { extractNonXmlContent } from './xml.js'
import { SessionNotFoundError, MessagesNotFoundError } from './errors.js'

const TOOL_OUTPUT_MAX_CHARS = 30_000
export const DEFAULT_TOOL_INPUT_MAX_CHARS = 80

export type SessionMarkdownOptions = {
  compactTools: boolean
  includeThinking: boolean
  toolInputMaxChars: number
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
type ToolInput = Record<string, JsonValue>

function stringifyToolValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function truncateChars(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (maxChars <= 0) return ''
  if (collapsed.length <= maxChars) return collapsed
  if (maxChars === 1) return '…'
  return `${collapsed.slice(0, maxChars - 1)}…`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function messageCreatedAt(message: { time?: { created?: number } }): number | undefined {
  const created = message.time?.created
  return typeof created === 'number' ? created : undefined
}

function messageEndedAt(message: {
  time?: { created?: number; completed?: number }
}): number | undefined {
  const completed = message.time?.completed
  if (typeof completed === 'number') return completed
  return messageCreatedAt(message)
}

/** User sent → last assistant finished, until the next user message. */
export function userPromptDurationMs({
  messages,
  userIndex,
}: {
  messages: Array<{ info: { role?: string; time?: { created?: number; completed?: number } } }>
  userIndex: number
}): number | undefined {
  const userCreated = messageCreatedAt(messages[userIndex]?.info ?? {})
  if (userCreated === undefined) return undefined

  let end = userCreated
  for (let i = userIndex + 1; i < messages.length; i++) {
    const info = messages[i]?.info
    if (info?.role === 'user') break
    if (info?.role !== 'assistant') continue
    const ended = messageEndedAt(info)
    if (ended !== undefined && ended > end) end = ended
  }
  const ms = end - userCreated
  return ms > 0 ? ms : undefined
}

export function fileBaseName(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  return segments[segments.length - 1] || filePath
}

function readTaskSessionId(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const sessionId = metadata.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

function taskChildSessionId({
  input,
  metadata,
}: {
  input?: ToolInput
  metadata?: JsonValue
}): string | undefined {
  const sessionId = readTaskSessionId(metadata)
  if (sessionId) return sessionId
  const taskId = input?.task_id
  if (typeof taskId === 'string' && taskId.startsWith('ses')) return taskId
  return undefined
}

/** Compact tool input for session markdown. Keep this greppable and short. */
export function formatCompactToolSummary({
  tool,
  input,
  maxChars = DEFAULT_TOOL_INPUT_MAX_CHARS,
  metadata,
}: {
  tool: string
  input?: ToolInput
  maxChars?: number
  metadata?: JsonValue
}): string {
  const record = input ?? {}
  if (tool === 'read') {
    const path = record.filePath ?? record.path
    return typeof path === 'string' && path.length > 0 ? fileBaseName(path) : ''
  }
  if (tool === 'task') {
    const description = typeof record.description === 'string' ? record.description : ''
    const sessionId = taskChildSessionId({ input: record, metadata })
    if (!sessionId) return truncateChars(description, maxChars)
    const separator = description.trim() ? 1 : 0
    const descBudget = Math.max(0, maxChars - sessionId.length - separator)
    const desc = truncateChars(description, descBudget)
    return [desc, sessionId].filter(Boolean).join(' ')
  }
  if (tool === 'bash') {
    const command = typeof record.command === 'string' ? record.command : ''
    const collapsedCommand = command.replace(/\s+/g, ' ').trim()
    if (collapsedCommand.length > 0 && collapsedCommand.length <= maxChars) {
      return collapsedCommand
    }
    const description = typeof record.description === 'string' ? record.description : ''
    return truncateChars(description || collapsedCommand, maxChars)
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(record)) {
    parts.push(`${key}=${stringifyToolValue(value)}`)
  }
  return truncateChars(parts.join(' '), maxChars)
}

/** OpenCode-era timing shape `userPromptDurationMs` reads. */
function timedInfo(message: AgentMessage) {
  return {
    role: message.role,
    time: {
      created: message.createdAt,
      ...(message.completedAt !== undefined && { completed: message.completedAt }),
    },
  }
}

export class ShareMarkdown {
  constructor(private backend: Pick<AgentBackend, 'sessions'>) {}

  /**
   * Generate a markdown representation of a session
   * @param options Configuration options
   * @returns Error or markdown string
   */
  async generate(options: {
    sessionID: string
    includeSystemInfo?: boolean
    lastAssistantOnly?: boolean
    /** When true (default), tool calls show a compact one-liner with line count instead of full output. */
    compactTools?: boolean
    /** When true, include reasoning parts. Off by default. */
    includeThinking?: boolean
    /** Max characters for compact tool input. Default 80. */
    toolInputMaxChars?: number
  }): Promise<SessionNotFoundError | MessagesNotFoundError | string> {
    const {
      sessionID,
      includeSystemInfo,
      lastAssistantOnly,
      compactTools = true,
      includeThinking = false,
      toolInputMaxChars = DEFAULT_TOOL_INPUT_MAX_CHARS,
    } = options

    // Get session info. Any failure reads as not found, as before.
    const session = await this.backend.sessions.get({ sessionId: sessionID }).catch(() => undefined)
    if (!session || session instanceof Error) {
      return new SessionNotFoundError({ sessionId: sessionID })
    }

    // Get all messages
    const messages = await this.backend.sessions.messages({ sessionId: sessionID }).catch(() => undefined)
    if (!messages || messages instanceof Error) {
      return new MessagesNotFoundError({ sessionId: sessionID })
    }

    // If lastAssistantOnly, filter to only the last assistant message
    const messagesToRender = lastAssistantOnly
      ? messages.filter((m) => m.message.role === 'assistant').slice(-1)
      : messages

    // Build markdown
    const lines: string[] = []

    // Only include header and session info if not lastAssistantOnly
    if (!lastAssistantOnly) {
      // Header
      lines.push(`# ${session.title || 'Untitled Session'}`)
      lines.push('')

      // Session metadata
      if (includeSystemInfo === true) {
        lines.push('## Session Information')
        lines.push('')
        lines.push(
          `- **Created**: ${formatDateTime(new Date(session.createdAt ?? 0))}`,
        )
        lines.push(
          `- **Updated**: ${formatDateTime(new Date(session.updatedAt ?? 0))}`,
        )
        if (session.version) {
          lines.push(`- **OpenCode Version**: v${session.version}`)
        }
        lines.push('')
      }

      // Process messages
      lines.push('## Conversation')
      lines.push('')
    }

    for (const [index, message] of messagesToRender.entries()) {
      const messageLines = this.renderMessage(message.message, message.parts, {
        compactTools,
        includeThinking,
        toolInputMaxChars,
      })
      lines.push(...messageLines)
      lines.push('')

      const nextRole = messagesToRender[index + 1]?.message.role
      if (message.message.role !== 'assistant' || nextRole === 'assistant') continue

      for (let userIndex = index - 1; userIndex >= 0; userIndex--) {
        if (messagesToRender[userIndex]?.message.role !== 'user') continue
        const durationMs = userPromptDurationMs({
          messages: messagesToRender.map((entry) => ({ info: timedInfo(entry.message) })),
          userIndex,
        })
        if (durationMs !== undefined) {
          lines.push(`duration: ${formatDuration(durationMs)}`)
          lines.push('')
        }
        break
      }
    }

    return lines.join('\n')
  }

  private renderMessage(message: AgentMessage, parts: AgentPart[], opts: SessionMarkdownOptions): string[] {
    const lines: string[] = []

    if (message.role === 'user') {
      lines.push('### user')
      lines.push('')

      for (const part of parts) {
        if (part.kind === 'text' && part.text) {
          const cleanedText = extractNonXmlContent(part.text)
          if (cleanedText.trim()) {
            lines.push(cleanedText)
            lines.push('')
          }
        } else if (part.kind === 'file') {
          lines.push(`file: ${part.filename || 'unnamed file'}`)
          if (part.url) {
            lines.push(`   - URL: ${part.url}`)
          }
          lines.push('')
        }
      }
    } else if (message.role === 'assistant') {
      const filteredParts = parts.filter((part) => {
        if (part.kind === 'step-start' || part.kind === 'step-finish') return false
        if (part.kind === 'other' && (part.type === 'snapshot' || part.type === 'patch')) return false
        if (part.kind === 'text' && (part.synthetic === true || !part.text)) return false
        if (part.kind === 'tool' && part.tool === 'todoread') return false
        if (
          part.kind === 'tool' &&
          (part.status === 'pending' || part.status === 'running')
        )
          return false
        return true
      })

      const body: string[] = []
      for (const part of filteredParts) {
        body.push(
          ...(opts.compactTools
            ? this.renderPartCompact(part, opts)
            : this.renderPart(part, opts)),
        )
      }
      if (body.length === 0) return lines

      const modelId =
        [message.model?.providerId, message.model?.modelId].filter(Boolean).join('/') ||
        'unknown model'
      lines.push(`### assistant (${modelId})`)
      lines.push('')
      lines.push(...body)
    }

    return lines
  }

  private renderPart(part: AgentPart, opts: SessionMarkdownOptions): string[] {
    const lines: string[] = []

    switch (part.kind) {
      case 'text':
        if (part.text) {
          lines.push(part.text)
          lines.push('')
        }
        break

      case 'reasoning':
        if (opts.includeThinking && part.text) {
          lines.push('thinking:')
          lines.push('')
          lines.push(part.text)
          lines.push('')
        }
        break

      case 'tool':
        if (part.status === 'completed') {
          const output: string = part.output || ''
          const isOversized = output.length > TOOL_OUTPUT_MAX_CHARS

          if (isOversized) {
            lines.push(
              `> Large tool output (${output.length.toLocaleString()} chars, truncated to ${TOOL_OUTPUT_MAX_CHARS.toLocaleString()})`,
            )
            lines.push('')
          }

          lines.push(`#### tool: ${part.tool}`)
          lines.push('')

          // Render input parameters in YAML
          if (part.input && Object.keys(part.input).length > 0) {
            lines.push('**Input:**')
            lines.push('```yaml')
            lines.push(YAML.stringify(part.input, null, { lineWidth: 0 }))
            lines.push('```')
            lines.push('')
          }

          // Render output, truncated if too large
          if (output) {
            lines.push('**Output:**')
            lines.push('```')
            lines.push(
              isOversized
                ? output.slice(0, TOOL_OUTPUT_MAX_CHARS) +
                    '\n...(truncated)'
                : output,
            )
            lines.push('```')
            lines.push('')
          }
        } else if (part.status === 'error') {
          lines.push(`#### tool-error: ${part.tool}`)
          lines.push('')
          lines.push('```')
          lines.push(part.error || 'Unknown error')
          lines.push('```')
          lines.push('')
        }
        break
    }

    return lines
  }

  /** Compact rendering: tool calls become a single line with line count instead of full output. */
  private renderPartCompact(part: AgentPart, opts: SessionMarkdownOptions): string[] {
    if (part.kind !== 'tool') {
      return this.renderPart(part, opts)
    }

    const lines: string[] = []

    if (part.status === 'completed') {
      const output: string = part.output || ''
      const lineCount = output ? output.split('\n').length : 0
      const inputSummary = formatCompactToolSummary({
        tool: part.tool,
        input: part.input as ToolInput,
        maxChars: opts.toolInputMaxChars,
        metadata: part.metadata as JsonValue | undefined,
      })
      const outputLabel = lineCount > 0 ? `(${lineCount} lines)` : ''
      const parts = [inputSummary, outputLabel].filter(Boolean).join(' ')
      lines.push(`tool: ${part.tool}${parts ? ` ${parts}` : ''}`)
      lines.push('')
    } else if (part.status === 'error') {
      const errorText = (part.error || 'Unknown error').split('\n')[0]!.slice(0, 120)
      lines.push(`tool-error: ${part.tool} ${errorText}`)
      lines.push('')
    }

    return lines
  }
}
