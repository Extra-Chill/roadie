// Pending interactive UI owned by thread runtimes: tracked permission
// requests and the per-thread cleanup run on dispose/delete.

import type { AgentPermissionRequest } from '../agent-backend/events.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import { pendingPermissionContexts } from '../commands/permissions.js'
import { cancelPendingQuestion } from '../commands/ask-question.js'
import { cancelPendingActionButtons } from '../commands/action-buttons.js'
import { cancelPendingFileUpload } from '../commands/file-upload.js'
import { cancelHtmlActionsForThread } from '../html-actions.js'

// Track multiple pending permissions per thread (keyed by permission ID).
// OpenCode handles blocking/sequencing — we just need to track all pending
// permissions to avoid duplicates and properly clean up on reply/teardown.
// The runtime is the sole owner of pending permissions per thread.
export const pendingPermissions = new Map<
  string, // threadId
  Map<
    string,
    {
      permission: AgentPermissionRequest
      messageId: string
      directory: string
      contextHash: string
      dedupeKey: string
    }
  > // permissionId -> data
>()

// ── Pending UI cleanup ───────────────────────────────────────────
// Clears all pending interactive UI state for a thread on dispose/delete.
// Uses existing cancel functions which handle upstream replies (so OpenCode
// doesn't hang waiting for answers that will never come).

export function cleanupPendingUiForThread(threadId: string): void {
  // Permissions: reject each pending permission so OpenCode doesn't hang,
  // then delete the per-thread tracking map.
  const threadPerms = pendingPermissions.get(threadId)
  if (threadPerms) {
    for (const [, entry] of threadPerms) {
      const ctx = pendingPermissionContexts.get(entry.contextHash)
      if (ctx) {
        const client = getAgentBackendProvider().getBackend(ctx.directory)
        if (client) {
          const requestIds: string[] = ctx.requestIds.length > 0
            ? ctx.requestIds
            : [ctx.permission.id]
          void Promise.all(
            requestIds.map((requestId) => {
              return client.sessions.replyPermission({
                requestId,
                directory: ctx.directory,
                reply: 'reject',
              })
            }),
          ).catch(() => {})
        }
        pendingPermissionContexts.delete(entry.contextHash)
      }
    }
    pendingPermissions.delete(threadId)
  }

  // Questions: cancel deletes pending context without replying to OpenCode.
  void cancelPendingQuestion(threadId)

  // Action buttons: resolves context and clears timer.
  cancelPendingActionButtons(threadId)

  // File uploads: resolves with empty files so OpenCode unblocks.
  void cancelPendingFileUpload(threadId)

  // HTML actions: clears registered action callbacks for this thread.
  cancelHtmlActionsForThread(threadId)
}

export function buildPermissionDedupeKey({
  permission,
  directory,
}: {
  permission: AgentPermissionRequest
  directory: string
}): string {
  const normalizedPatterns = [...permission.patterns].sort((a, b) => {
    return a.localeCompare(b)
  })
  return `${directory}::${permission.permission}::${normalizedPatterns.join('|')}`
}
