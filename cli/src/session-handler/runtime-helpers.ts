// Stateless helpers used by ThreadSessionRuntime.

import * as errore from 'errore'
import type { AgentError, AgentUsage } from '../agent-backend/events.js'
import type { AgentPromptPart } from '../agent-backend/types.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import type { WorkingDirectoryInfo } from '../system-message.js'
import type { QueuedMessage } from './thread-runtime-state.js'

const DETERMINISTIC_CONTEXT_LIMIT = 100_000
const TOAST_SESSION_ID_REGEX = /\b(ses_[A-Za-z0-9]+)\b\s*$/u

export function extractToastSessionId({ message }: { message: string }): string | undefined {
  const match = message.match(TOAST_SESSION_ID_REGEX)
  return match?.[1]
}

export function stripToastSessionId({ message }: { message: string }): string {
  return message.replace(TOAST_SESSION_ID_REGEX, '').trimEnd()
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function getTimestampFromSnowflake(snowflake: string): number | undefined {
  const discordEpochMs = 1_420_070_400_000n
  const snowflakeIdResult = errore.try(
    { try: () => {
      return BigInt(snowflake)
    }, catch: () => {
      return new Error('Invalid Discord snowflake')
    } },
  )
  if (snowflakeIdResult instanceof Error) return undefined
  const timestampBigInt = (snowflakeIdResult >> 22n) + discordEpochMs
  const timestampMs = Number(timestampBigInt)
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return undefined
  }
  return timestampMs
}

export function toPromptFilePart(file: DiscordFileAttachment): AgentPromptPart {
  return {
    kind: 'file',
    mime: file.mime,
    url: file.url,
    ...(file.filename && { filename: file.filename }),
  }
}

export function getTokenTotal(usage: AgentUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

export function parseQueuedMessagePayload({
  queueId,
  payloadJson,
}: {
  queueId: string
  payloadJson: string
}): QueuedMessage | Error {
  return errore.try(
    { try: () => {
      const parsed = JSON.parse(payloadJson) as QueuedMessage
      if (!parsed || typeof parsed !== 'object') {
        return new Error('Queued message payload is not an object')
      }
      if (typeof parsed.prompt !== 'string') {
        return new Error('Queued message payload is missing prompt')
      }
      if (typeof parsed.userId !== 'string') {
        return new Error('Queued message payload is missing userId')
      }
      if (typeof parsed.username !== 'string') {
        return new Error('Queued message payload is missing username')
      }
      return { ...parsed, queueId }
    }, catch: (error) => {
      return new Error('Failed to parse queued message payload', { cause: error })
    } },
  )
}

export function getWorkingDirectoryPromptKey(dir: WorkingDirectoryInfo | undefined): string | null {
  if (!dir) {
    return null
  }
  return [dir.workingDirectory, dir.label, dir.projectDirectory].join('::')
}

export function getFallbackContextLimit({
  providerID,
}: {
  providerID: string
}): number | undefined {
  if (providerID === 'deterministic-provider') {
    return DETERMINISTIC_CONTEXT_LIMIT
  }
  return undefined
}

/** Format a session error from event properties for display. */
export function formatSessionErrorFromProps(error?: AgentError): string {
  if (!error) {
    return 'Unknown error'
  }
  const parts: string[] = []
  // A backend error without a message carries only its name as the message.
  if (error.message && error.message !== error.name) {
    parts.push(error.message)
  }
  if (error.statusCode) {
    parts.push(`(${error.statusCode})`)
  }
  if (error.provider) {
    parts.push(`[${error.provider}]`)
  }
  return parts.length > 0 ? parts.join(' ') : error.name || 'Unknown error'
}

export function truncateSessionErrorMessage(message: string): string {
  const maxLength = 400
  if (message.length <= maxLength) {
    return message
  }
  return `${message.slice(0, maxLength - 1)}…`
}
