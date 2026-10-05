// Coding scope comes from successful tool calls persisted by the backend, not
// chat text or a new directory binding on the original conversation.
import path from 'node:path'
import type { OpencodeClient, Part } from '@opencode-ai/sdk/v2'
import { OpenCodeSdkError } from './errors.js'

export function codingPathsFromParts({ parts, directory }: { parts: Part[]; directory: string }): string[] {
  const paths = new Set<string>()
  const record = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return
    const absolute = path.resolve(directory, value)
    // Keep the last successful activity in each location last. The host can
    // choose the latest checkout within one repository, never between repos.
    paths.delete(absolute)
    paths.add(absolute)
  }
  for (const part of parts) {
    if (part.type !== 'tool' || part.state.status !== 'completed') continue
    const tool = part.tool.split('.').at(-1)
    const input = part.state.input
    if (tool === 'bash' && input.hasSideEffect === true) {
      // Bash reports non-zero command exits as completed tool calls.
      const exit = part.state.metadata.exit ?? part.state.metadata.exitCode
      if (typeof exit === 'number' && exit !== 0) continue
      record(input.workdir ?? input.cwd)
      continue
    }
    if (tool === 'edit' || tool === 'write') {
      record(input.filePath)
      continue
    }
    if (tool === 'apply_patch') {
      const patch = input.patchText ?? input.patch
      if (typeof patch !== 'string') continue
      for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) record(match[1])
    }
  }
  return [...paths]
}

export async function loadForkCodingPaths({
  client, sessionId, directory, beforeMessageId,
}: {
  client: OpencodeClient
  sessionId: string
  directory: string
  beforeMessageId?: string
}): Promise<string[] | Error> {
  const history = await client.session.messages({ sessionID: sessionId, directory })
    .catch((cause) => new OpenCodeSdkError({ operation: 'read fork coding scope', cause }))
  if (history instanceof Error) return history
  if (history.error) return new OpenCodeSdkError({ operation: 'read fork coding scope', cause: history.error })
  if (!history.data) return new OpenCodeSdkError({ operation: 'read fork coding scope', cause: new Error('Session history was unavailable; the fork was not started.') })
  const cutoff = beforeMessageId ? history.data.findIndex((message) => message.info.id === beforeMessageId) : history.data.length
  if (cutoff === -1) return new OpenCodeSdkError({ operation: 'read fork coding scope', cause: new Error('Fork history boundary was not found; choose an existing source message.') })
  return codingPathsFromParts({ parts: history.data.slice(0, cutoff).flatMap((message) => message.parts), directory })
}
