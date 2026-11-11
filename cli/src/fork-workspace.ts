// The host owns workspace creation and cleanup. Workspace isolation is best
// effort: failures never prevent the ordinary conversation copy.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { applyFiltersAsync, doAction } from './hooks.js'
import { createLogger, formatErrorChain, LogPrefix } from './logger.js'

const forkLogger = createLogger(LogPrefix.FORK)

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
  provision(request: ForkWorkspaceRequest): Promise<ForkWorkspaceBinding | Error>
}
export type ForkWorkspaceResult = {
  request: ForkWorkspaceRequest
  binding: ForkWorkspaceBinding | null
  degradationReason?: string
  notice?: string
}

export async function resolveForkWorkspace(
  input: Omit<ForkWorkspaceRequest, 'requestId'>,
): Promise<ForkWorkspaceResult> {
  const request: ForkWorkspaceRequest = { ...input, requestId: crypto.randomUUID() }
  let binding: ForkWorkspaceBinding | null = null
  try {
    const provider = await applyFiltersAsync('fork_workspace', null, request, {
      onError: (cause) => { throw cause },
    })
    if (provider instanceof Error) throw provider
    if (!provider) return { request, binding: null }
    if (typeof provider.provision !== 'function')
      throw new Error('Host fork workspace provider is invalid.')
    const provisioned = await provider.provision(request)
    if (provisioned instanceof Error) throw provisioned
    binding = provisioned
    if (
      !binding ||
      typeof binding.workingDirectory !== 'string' ||
      typeof binding.projectDirectory !== 'string'
    ) throw new Error('Host did not return a workspace directory.')
    if (
      !path.isAbsolute(binding.workingDirectory) ||
      !path.isAbsolute(binding.projectDirectory) ||
      !binding.label ||
      !['git-worktree', 'directory'].includes(binding.kind)
    ) throw new Error('Host returned an invalid workspace binding.')
    const source = await fs.realpath(input.sourceDirectory)
    const target = await fs.realpath(binding.workingDirectory)
    if (source === target)
      throw new Error('Host workspace resolved to the source directory.')
    if (!(await fs.stat(target)).isDirectory())
      throw new Error('Host workspace is not a directory.')
    binding = { ...binding, workingDirectory: target }
    return { request, binding, notice: forkWorkspaceNotice(binding) }
  } catch (cause) {
    if (binding) await doAction('fork_workspace_abandoned', { request, binding })
    const degradationReason = cause instanceof Error ? cause.message : String(cause)
    forkLogger.warn(`Fork workspace unavailable (source thread ${request.sourceThreadId}, ${input.sourceDirectory}): ${formatErrorChain(cause)}`)
    return {
      request,
      binding: null,
      degradationReason,
      notice: `Fork workspace: sharing the source directory \`${input.sourceDirectory}\` because a separate workspace was unavailable: ${degradationReason}`,
    }
  }
}

export function forkWorkspaceNotice(binding: ForkWorkspaceBinding): string {
  return `Fork workspace: \`${binding.workingDirectory}\`\nBranch/workspace: \`${binding.label}\`${binding.baseRef ? ` · committed base: \`${binding.baseRef}\`` : ''}\nUncommitted edits from the source checkout are not copied.`
}
