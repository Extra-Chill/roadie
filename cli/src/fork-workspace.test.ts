// Unit tests for the fork_workspace provider contract: a matching provider
// provisions automatically, no provider means an ordinary conversation fork,
// and provisioning or binding failures degrade to a shared directory.
import { expect, test, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { addFilter, addAction, resetHooks } from './hooks.js'
import {
  resolveForkWorkspace,
  type ForkWorkspaceProvider,
} from './fork-workspace.js'

beforeEach(() => {
  resetHooks()
})

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
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
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fork-workspace-')))
  temporaryDirectories.push(directory)
  return directory
}

test('without a provider the fork stays in the source directory', async () => {
  const source = await makeTempDir()
  const result = await resolveForkWorkspace(requestInput(source))
  expect(result.binding).toBeNull()
  expect(result.request.requestId).toBeTruthy()
  expect(result.request.sourceSessionId).toBe('session-1')
})

test('a matching provider provisions automatically', async () => {
  const source = await makeTempDir()
  const target = await makeTempDir()
  const hostProvider = {
    provision: async () => ({
      workingDirectory: target,
      projectDirectory: source,
      label: 'fork-branch',
      kind: 'git-worktree' as const,
    }),
  }
  addFilter('fork_workspace', () => hostProvider)
  const result = await resolveForkWorkspace(requestInput(source))
  expect(result.binding?.workingDirectory).toBe(target)
  expect(result.binding?.label).toBe('fork-branch')
})

test.each([
  ['provision returns Error', 'fixture allocation failed', false],
  ['provision throws', 'delayed setup failed', false],
  ['filter returns Error', 'Multiple coding repositories', false],
  ['filter throws', 'host unavailable', false],
  ['invalid provider', 'provider is invalid', false],
  ['invalid binding', 'invalid workspace binding', true],
  ['missing directory', 'did not return a workspace directory', true],
  ['source binding', 'resolved to the source directory', true],
  ['unavailable directory', 'ENOENT', true],
] as const)('%s falls back to sharing the source', async (scenario, reason, allocated) => {
  const source = await makeTempDir()
  const abandoned: unknown[] = []
  addAction('fork_workspace_abandoned', (context) => { abandoned.push(context) })
  addFilter('fork_workspace', () => {
    if (scenario === 'filter throws') throw new Error(reason)
    if (scenario === 'filter returns Error') return new Error(reason)
    if (scenario === 'invalid provider') return {} as ForkWorkspaceProvider
    return { provision: async () => {
      if (scenario === 'provision throws') throw new Error(reason)
      if (scenario === 'provision returns Error') return new Error(reason)
      if (scenario === 'missing directory') return {} as never
      return {
        workingDirectory: scenario === 'source binding' ? source : scenario === 'unavailable directory' ? path.join(source, 'missing') : 'relative/path',
        projectDirectory: source, label: 'fork-branch', kind: 'git-worktree' as const,
      }
    } }
  })
  const result = await resolveForkWorkspace(requestInput(source))
  expect(result.binding).toBeNull()
  expect(result.degradationReason).toContain(reason)
  expect(result.notice).toContain(`sharing the source directory \`${source}\``)
  expect(result.notice).toContain(reason)
  expect(abandoned).toHaveLength(allocated ? 1 : 0)
})
