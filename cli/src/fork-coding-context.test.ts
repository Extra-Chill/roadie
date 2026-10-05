import { expect, test } from 'vitest'
import type { ToolPart } from '@opencode-ai/sdk/v2'
import { codingPathsFromParts } from './fork-coding-context.js'

function completed(tool: string, input: Record<string, unknown>): ToolPart {
  return {
    id: 'part', sessionID: 'session', messageID: 'message', type: 'tool', callID: 'call', tool,
    state: { status: 'completed', input, output: '', title: tool, metadata: {}, time: { start: 1, end: 2 } },
  }
}

test('successful edits and explicitly mutating shells identify coding scope; reads and failures do not', () => {
  const failed: ToolPart = { ...completed('write', { filePath: '/unrelated/failure.ts' }), state: { status: 'error', input: { filePath: '/unrelated/failure.ts' }, error: 'failed', time: { start: 1, end: 2 } } }
  const failedShell = completed('bash', { workdir: '/unrelated/failed-shell', hasSideEffect: true })
  if (failedShell.state.status === 'completed') failedShell.state.metadata.exit = 1
  expect(codingPathsFromParts({ directory: '/home/site', parts: [
    completed('read', { filePath: '/unrelated/reference.ts' }),
    completed('bash', { workdir: '/unrelated/read-only', hasSideEffect: false }),
    completed('bash', { command: 'git -C /unrelated/in-command status', hasSideEffect: true }),
    completed('edit', { filePath: '/code/project/file.ts' }),
    completed('functions.bash', { workdir: '/code/project-worktree', hasSideEffect: true }),
    completed('write', { filePath: 'local.txt' }),
    failed,
    failedShell,
  ] })).toEqual(['/code/project/file.ts', '/code/project-worktree', '/home/site/local.txt'])
})

test('successful patches record concrete file operations, including moves and deletions', () => {
  expect(codingPathsFromParts({ directory: '/home/site', parts: [completed('apply_patch', { patchText: [
    '*** Begin Patch',
    '*** Add File: /code/project/added.ts',
    '+content',
    '*** Update File: /code/project/old.ts',
    '*** Move to: /code/project/new.ts',
    '*** Delete File: /code/project/removed.ts',
    '*** End Patch',
  ].join('\n') })] })).toEqual(['/code/project/added.ts', '/code/project/old.ts', '/code/project/new.ts', '/code/project/removed.ts'])
})

test('activity order selects the last used checkout only after the host proves one repository', () => {
  expect(codingPathsFromParts({ directory: '/home/site', parts: [
    completed('bash', { cwd: '/code/worktree-one', hasSideEffect: true }),
    completed('bash', { cwd: '/code/worktree-two', hasSideEffect: true }),
    completed('bash', { cwd: '/code/worktree-one', hasSideEffect: true }),
  ] })).toEqual(['/code/worktree-two', '/code/worktree-one'])
})
