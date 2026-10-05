// The host owns workspace creation and cleanup. Roadie only requests and
// validates a binding before it forks/dispatches the conversation.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as errore from 'errore'
import { applyFiltersAsync, doAction } from './hooks.js'

export type ForkWorkspaceMode = 'shared' | 'separate'
export type ForkWorkspaceRequest = {
  requestId: string
  sourceSessionId: string
  sourceThreadId: string
  projectDirectory: string
  sourceDirectory: string
  platform: string
  spaceId?: string
  channelId?: string
  userId: string
  prompt?: string
}
export type ForkWorkspaceBinding = {
  workingDirectory: string
  projectDirectory: string
  label: string
  kind: 'git-worktree' | 'directory'
  workspaceId?: string
  baseRef?: string
}
export type ForkWorkspaceProvider = {
  defaultMode?: ForkWorkspaceMode
  provision(request: ForkWorkspaceRequest): Promise<ForkWorkspaceBinding | Error>
}
export class ForkWorkspaceError extends errore.createTaggedError({
  name: 'ForkWorkspaceError',
  message: '$detail',
}) {}

export async function resolveForkWorkspace(
  input: Omit<ForkWorkspaceRequest, 'requestId'> & { mode?: ForkWorkspaceMode },
): Promise<{ request: ForkWorkspaceRequest; binding: ForkWorkspaceBinding | null } | Error> {
  const request: ForkWorkspaceRequest = { ...input, requestId: crypto.randomUUID() }
  // Explicit sharing is a complete decision, not a provisioning request.
  if (input.mode === 'shared') return { request, binding: null }
  const provider = await applyFiltersAsync('fork_workspace', null, request)
  const mode = input.mode ?? provider?.defaultMode ?? 'shared'
  if (mode !== 'shared' && mode !== 'separate')
    return new ForkWorkspaceError({ detail: 'Host configured an invalid fork workspace mode.' })
  if (mode === 'shared') return { request, binding: null }
  if (!provider)
    return new ForkWorkspaceError({
      detail:
        'No host workspace provider is configured for this project. Choose workspace:shared or configure a separate-workspace provider.',
    })
  if (typeof provider.provision !== 'function')
    return new ForkWorkspaceError({
      detail: 'Host fork workspace provider is invalid; the fork was not started.',
    })
  const binding = await provider
    .provision(request)
    .catch(
      (cause) =>
        new ForkWorkspaceError({
          detail: 'Host workspace provisioning failed; the fork was not started.',
          cause,
        }),
    )
  if (binding instanceof Error) return binding
  if (
    !binding ||
    typeof binding.workingDirectory !== 'string' ||
    typeof binding.projectDirectory !== 'string'
  )
    return new ForkWorkspaceError({
      detail: 'Host did not return a workspace directory; the fork was not started.',
    })
  const invalid = async (detail: string) => {
    await doAction('fork_workspace_abandoned', { request, binding })
    return new ForkWorkspaceError({ detail })
  }
  if (
    !path.isAbsolute(binding.workingDirectory) ||
    !path.isAbsolute(binding.projectDirectory) ||
    !binding.label ||
    !['git-worktree', 'directory'].includes(binding.kind)
  )
    return invalid('Host returned an invalid workspace binding; the fork was not started.')
  const source = await fs
    .realpath(input.sourceDirectory)
    .catch(
      (cause) =>
        new ForkWorkspaceError({ detail: 'Cannot resolve the source working directory.', cause }),
    )
  if (source instanceof Error) return invalid(source.message)
  const target = await fs
    .realpath(binding.workingDirectory)
    .catch(
      (cause) =>
        new ForkWorkspaceError({
          detail: 'Host workspace is unavailable; the fork was not started.',
          cause,
        }),
    )
  if (target instanceof Error) return invalid(target.message)
  if (source === target)
    return invalid('Separate workspace resolved to the source directory; the fork was not started.')
  const stat = await fs
    .stat(target)
    .catch(
      (cause) => new ForkWorkspaceError({ detail: 'Cannot inspect the host workspace.', cause }),
    )
  if (stat instanceof Error) return invalid(stat.message)
  if (!stat.isDirectory())
    return invalid('Host workspace is not a directory; the fork was not started.')
  return { request, binding: { ...binding, workingDirectory: target } }
}

export function forkWorkspaceNotice(binding: ForkWorkspaceBinding): string {
  return `Separate workspace: \`${binding.workingDirectory}\`\nBranch/workspace: \`${binding.label}\`${binding.baseRef ? ` · committed base: \`${binding.baseRef}\`` : ''}\nUncommitted edits from the source checkout are not copied.`
}
