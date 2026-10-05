// Native fork target-directory contract. Source lookup and target binding are
// separate fields; request directory alone cannot move a stored session.
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { z } from 'zod'
import { getOpencodeServerPort, getOpencodeServerAuthHeaders } from '../opencode.js'
import { OpenCodeSdkError } from '../errors.js'

export async function forkOpenCodeSession({
  client,
  sessionId,
  sourceDirectory,
  targetDirectory,
  messageId,
}: {
  client: OpencodeClient
  sessionId: string
  sourceDirectory: string
  targetDirectory?: string
  messageId?: string
}): Promise<{ data?: { id: string; title: string; directory: string }; error?: unknown }> {
  if (!targetDirectory)
    return client.session.fork({
      sessionID: sessionId,
      directory: sourceDirectory,
      ...(messageId ? { messageID: messageId } : {}),
    })
  const port = getOpencodeServerPort()
  if (!port)
    return { error: new Error('The OpenCode backend is unavailable; the fork was not started.') }
  const url = new URL(`/session/${encodeURIComponent(sessionId)}/fork`, `http://127.0.0.1:${port}`)
  url.searchParams.set('directory', sourceDirectory)
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...getOpencodeServerAuthHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ targetDirectory, ...(messageId ? { messageID: messageId } : {}) }),
    signal: AbortSignal.timeout(30_000),
  }).catch((cause) => new OpenCodeSdkError({ operation: 'session.fork targetDirectory', cause }))
  if (response instanceof Error) return { error: response }
  if (!response.ok)
    return {
      error: new Error(
        `OpenCode rejected the fork workspace (${response.status}); the fork was not started.`,
      ),
    }
  const body = await response
    .json()
    .catch((cause) => new OpenCodeSdkError({ operation: 'parse session.fork', cause }))
  if (body instanceof Error) return { error: body }
  const parsed = z
    .object({ id: z.string(), title: z.string(), directory: z.string() })
    .safeParse(body)
  if (!parsed.success)
    return { error: new Error('OpenCode returned an invalid fork workspace binding.') }
  if (parsed.data.directory !== targetDirectory) {
    // Older backends ignore the new body field. Remove the unused fork before
    // exposing it to the runtime; never dispatch against the source directory.
    await client.session.delete({ sessionID: parsed.data.id, directory: sourceDirectory })
    return {
      error: new Error(
        'This OpenCode version does not support fork target directories. Upgrade the backend or choose workspace:shared; no fork prompt was run.',
      ),
    }
  }
  return { data: parsed.data }
}
