// Unit tests for the fork_workspace provider contract: a matching provider
// provisions automatically, no provider means an ordinary conversation fork,
// and provisioning or binding failures fail closed. The superseded
// `defaultMode` field (still returned by the current host plugin) is ignored.
import { expect, test, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { addFilter, addAction, resetHooks } from './hooks.js'
import {
  resolveForkWorkspace,
  ForkWorkspaceError,
  type ForkWorkspaceProvider,
  type ForkWorkspaceRequest,
} from './fork-workspace.js'

beforeEach(() => {
  resetHooks()
})

function requestInput(sourceDirectory: string) {
  return {
    sourceSessionId: 'session-1',
    sourceThreadId: 'thread-1',
    projectDirectory: sourceDirectory,
    sourceDirectory,
    platform: 'test',
    userId: 'user-1',
  }
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fork-workspace-'))
}

test('without a provider the fork stays in the source directory', async () => {
  const source = await makeTempDir()
  const result = await resolveForkWorkspace(requestInput(source))
  if (result instanceof Error) throw result
  expect(result.binding).toBeNull()
  expect(result.request.requestId).toBeTruthy()
  expect(result.request.sourceSessionId).toBe('session-1')
})

test('a matching provider provisions automatically; the superseded defaultMode field is ignored', async () => {
  const source = await makeTempDir()
  const target = await makeTempDir()
  // Built without a fresh object literal so the extra field typechecks the
  // same way a host plugin written against the old contract would.
  const hostProvider = {
    defaultMode: 'shared',
    provision: async () => ({
      workingDirectory: target,
      projectDirectory: source,
      label: 'fork-branch',
      kind: 'git-worktree' as const,
    }),
  }
  addFilter('fork_workspace', () => hostProvider as ForkWorkspaceProvider)
  const result = await resolveForkWorkspace(requestInput(source))
  if (result instanceof Error) throw result
  expect(result.binding?.workingDirectory).toBe(target)
  expect(result.binding?.label).toBe('fork-branch')
})

test('provisioning failures fail closed without abandoning an unallocated workspace', async () => {
  const source = await makeTempDir()
  const abandoned: unknown[] = []
  addAction('fork_workspace_abandoned', (context) => {
    abandoned.push(context)
  })
  addFilter('fork_workspace', () => ({
    provision: async () => new Error('fixture allocation failed'),
  }))
  const result = await resolveForkWorkspace(requestInput(source))
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toBe('fixture allocation failed')
  expect(abandoned).toHaveLength(0)
})

test('a provider without a provision function fails closed', async () => {
  const source = await makeTempDir()
  const hostProvider = { defaultMode: 'separate' }
  addFilter('fork_workspace', () => hostProvider as unknown as ForkWorkspaceProvider)
  const result = await resolveForkWorkspace(requestInput(source))
  expect(result).toBeInstanceOf(ForkWorkspaceError)
  expect((result as Error).message).toContain('the fork was not started')
})

test('an invalid binding fails closed and notifies fork_workspace_abandoned', async () => {
  const source = await makeTempDir()
  const abandoned: Array<{ request: ForkWorkspaceRequest; binding: { label: string } }> = []
  let seenRequestId = ''
  addAction('fork_workspace_abandoned', (context) => {
    abandoned.push(context)
  })
  addFilter('fork_workspace', () => ({
    provision: async (request) => {
      seenRequestId = request.requestId
      return {
        workingDirectory: 'relative/path',
        projectDirectory: source,
        label: 'fork-branch',
        kind: 'git-worktree' as const,
      }
    },
  }))
  const result = await resolveForkWorkspace(requestInput(source))
  expect(result).toBeInstanceOf(ForkWorkspaceError)
  expect((result as Error).message).toContain('invalid workspace binding')
  expect(abandoned).toHaveLength(1)
  expect(abandoned[0]!.request.requestId).toBe(seenRequestId)
  expect(abandoned[0]!.binding.label).toBe('fork-branch')
})

test('a binding that resolves to the source directory fails closed', async () => {
  const source = await makeTempDir()
  const abandoned: unknown[] = []
  addAction('fork_workspace_abandoned', (context) => {
    abandoned.push(context)
  })
  addFilter('fork_workspace', () => ({
    provision: async () => ({
      workingDirectory: source,
      projectDirectory: source,
      label: 'fork-branch',
      kind: 'git-worktree' as const,
    }),
  }))
  const result = await resolveForkWorkspace(requestInput(source))
  expect(result).toBeInstanceOf(ForkWorkspaceError)
  expect((result as Error).message).toContain('resolved to the source directory')
  expect(abandoned).toHaveLength(1)
})
