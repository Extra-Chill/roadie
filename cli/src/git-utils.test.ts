// Tests for git-utils: thread working-directory validation (`roadie send --cwd`)
// and repository root detection.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { execAsync, isGitRepositoryRoot, resolveSessionWorkingDirectory } from './git-utils.js'

const GIT_TIMEOUT_MS = 60_000

async function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}): Promise<string> {
  const command = `git ${args
    .map((arg) => {
      return JSON.stringify(arg)
    })
    .join(' ')}`

  const result = await execAsync(command, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  })
  return result.stdout.trim()
}

function createTestRoot(): string {
  const tmpRoot = path.resolve(process.cwd(), 'tmp')
  fs.mkdirSync(tmpRoot, { recursive: true })
  return fs.mkdtempSync(path.join(tmpRoot, 'worktrees-test-'))
}

describe('git-utils', () => {
  test('isGitRepositoryRoot is true only at the repository root', async () => {
    const sandbox = createTestRoot()
    try {
      const projectDirectory = path.join(sandbox, 'project')
      const subfolder = path.join(projectDirectory, 'nested')
      fs.mkdirSync(subfolder, { recursive: true })
      expect(await isGitRepositoryRoot(projectDirectory)).toBe(false)
      await git({ cwd: projectDirectory, args: ['init', '-b', 'main'] })
      expect(await isGitRepositoryRoot(projectDirectory)).toBe(true)
      expect(await isGitRepositoryRoot(subfolder)).toBe(false)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('resolveSessionWorkingDirectory accepts the project root', async () => {
    const sandbox = createTestRoot()
    try {
      const projectDirectory = path.join(sandbox, 'project')
      fs.mkdirSync(projectDirectory, { recursive: true })

      const result = await resolveSessionWorkingDirectory({
        projectDirectory,
        candidatePath: projectDirectory,
      })

      if (result instanceof Error) {
        throw result
      }
      expect({
        kind: result.kind,
        relativeDirectory: path.relative(projectDirectory, result.directory),
      }).toMatchInlineSnapshot(`
        {
          "kind": "project",
          "relativeDirectory": "",
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('resolveSessionWorkingDirectory accepts project subfolders', async () => {
    const sandbox = createTestRoot()
    try {
      const projectDirectory = path.join(sandbox, 'project')
      const subfolder = path.join(projectDirectory, 'restricted-task')
      fs.mkdirSync(subfolder, { recursive: true })

      const result = await resolveSessionWorkingDirectory({
        projectDirectory,
        candidatePath: subfolder,
      })

      if (result instanceof Error) {
        throw result
      }
      expect({
        kind: result.kind,
        relativeDirectory: path.relative(projectDirectory, result.directory),
      }).toMatchInlineSnapshot(`
        {
          "kind": "project",
          "relativeDirectory": "restricted-task",
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('resolveSessionWorkingDirectory accepts project worktrees', async () => {
    const sandbox = createTestRoot()
    const projectDirectory = path.join(sandbox, 'project')
    const worktreeDirectory = path.join(sandbox, 'feature-worktree')

    try {
      fs.mkdirSync(projectDirectory, { recursive: true })
      await git({ cwd: projectDirectory, args: ['init', '-b', 'main'] })
      await git({
        cwd: projectDirectory,
        args: ['config', 'user.email', 'roadie-tests@example.com'],
      })
      await git({
        cwd: projectDirectory,
        args: ['config', 'user.name', 'Roadie Tests'],
      })
      fs.writeFileSync(
        path.join(projectDirectory, 'README.md'),
        'project\n',
        'utf-8',
      )
      await git({ cwd: projectDirectory, args: ['add', 'README.md'] })
      await git({ cwd: projectDirectory, args: ['commit', '-m', 'init'] })
      await git({
        cwd: projectDirectory,
        args: ['worktree', 'add', '-b', 'feature', worktreeDirectory],
      })

      const result = await resolveSessionWorkingDirectory({
        projectDirectory,
        candidatePath: worktreeDirectory,
      })

      if (result instanceof Error) {
        throw result
      }
      expect({
        kind: result.kind,
        relativeDirectory: path.relative(sandbox, result.directory),
      }).toMatchInlineSnapshot(`
        {
          "kind": "worktree",
          "relativeDirectory": "feature-worktree",
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('resolveSessionWorkingDirectory rejects unrelated directories', async () => {
    const sandbox = createTestRoot()
    try {
      const projectDirectory = path.join(sandbox, 'project')
      const siblingDirectory = path.join(sandbox, 'other-project')
      fs.mkdirSync(projectDirectory, { recursive: true })
      fs.mkdirSync(siblingDirectory, { recursive: true })
      await git({ cwd: projectDirectory, args: ['init', '-b', 'main'] })

      const result = await resolveSessionWorkingDirectory({
        projectDirectory,
        candidatePath: siblingDirectory,
      })

      expect(result).toBeInstanceOf(Error)
      const message = result instanceof Error ? result.message : ''
      expect(
        message
          .replace(projectDirectory, '<project>')
          .replace(siblingDirectory, '<sibling>'),
      ).toMatchInlineSnapshot(
        `"Working directory must be inside <project> or a git worktree of it: <sibling>"`,
      )
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
