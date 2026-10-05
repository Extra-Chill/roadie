// Bind a normal fork to an existing native workspace. The host provisions the
// Git worktree; syncList discovers it and warp moves only the copied session.
// copyChanges:false avoids copying dirty files or replaying the conversation.
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { OpenCodeSdkError } from '../errors.js'
import fs from 'node:fs/promises'
import { createLogger } from '../logger.js'
const logger = createLogger('FORK')

export async function forkOpenCodeSession({
  client, sessionId, sourceDirectory, targetDirectory, targetProjectDirectory, messageId,
}: {
  client: OpencodeClient
  sessionId: string
  sourceDirectory: string
  targetDirectory?: string
  targetProjectDirectory?: string
  messageId?: string
}): Promise<{ data?: { id: string; title: string; directory: string }; error?: unknown }> {
  if (!targetDirectory) return client.session.fork({ sessionID: sessionId, directory: sourceDirectory, ...(messageId ? { messageID: messageId } : {}) })
  const discoveryDirectory = targetProjectDirectory ?? sourceDirectory
  const synced = await client.experimental.workspace.syncList({ directory: discoveryDirectory }).catch((cause) => new OpenCodeSdkError({ operation: 'workspace.syncList', cause }))
  if (synced instanceof Error) return { error: synced }
  if (synced.error) return { error: new OpenCodeSdkError({ operation: 'workspace.syncList', cause: synced.error }) }
  const listed = await client.experimental.workspace.list({ directory: discoveryDirectory }).catch((cause) => new OpenCodeSdkError({ operation: 'workspace.list', cause }))
  if (listed instanceof Error) return { error: listed }
  if (listed.error) return { error: new OpenCodeSdkError({ operation: 'workspace.list', cause: listed.error }) }
  const canonical = await fs.realpath(targetDirectory).catch((cause) => new Error('Could not resolve the host worktree directory', { cause }))
  if (canonical instanceof Error) return { error: canonical }
  const candidates = await Promise.all((listed.data ?? []).map(async (item) => ({ item, directory: item.directory ? await fs.realpath(item.directory).catch(() => null) : null })))
  const workspace = candidates.find((item) => item.item.type === 'worktree' && item.directory === canonical)?.item
  if (!workspace) {
    logger.warn('Native workspace discovery did not find target', { targetDirectory, sourceDirectory, discovered: candidates.map((candidate) => ({ id: candidate.item.id, directory: candidate.directory })) })
    return { error: new Error('The host worktree is not available as a native OpenCode workspace. Separate forks require a discoverable Git worktree and OPENCODE_EXPERIMENTAL_WORKSPACES=true on the backend.') }
  }
  const forked = await client.session.fork({ sessionID: sessionId, directory: sourceDirectory, ...(messageId ? { messageID: messageId } : {}) })
  if (!forked.data) return forked
  const forkedSessionId = forked.data.id
  const abandon = async (error: unknown) => {
    const deleted = await client.session.delete({ sessionID: forkedSessionId, directory: sourceDirectory })
      .catch((cause) => new OpenCodeSdkError({ operation: 'delete unused fork', cause }))
    if (deleted instanceof Error || deleted.error) logger.warn('Could not delete unused fork', forkedSessionId, deleted)
    return { error }
  }
  const warped = await client.experimental.workspace.warp({ directory: sourceDirectory, id: workspace.id, sessionID: forkedSessionId, copyChanges: false })
    .catch((cause) => new OpenCodeSdkError({ operation: 'workspace.warp', cause }))
  if (warped instanceof Error) return abandon(warped)
  if (warped.error) return abandon(new OpenCodeSdkError({ operation: 'workspace.warp', cause: warped.error }))
  const saved = await client.session.get({ sessionID: forkedSessionId, directory: targetDirectory }).catch((cause) => new OpenCodeSdkError({ operation: 'verify fork workspace', cause }))
  if (saved instanceof Error) return abandon(saved)
  if (saved.error) return abandon(new OpenCodeSdkError({ operation: 'verify fork workspace', cause: saved.error }))
  if (!saved.data || saved.data.workspaceID !== workspace.id) return abandon(new Error('The backend did not persist the fork workspace binding; no prompt was run.'))
  return { data: saved.data }
}
