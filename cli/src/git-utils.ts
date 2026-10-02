// Git and working-directory helpers.
//
// Roadie does not create or merge git worktrees (host tooling
// does). It only needs to run git, recognize a repository root, and validate
// a directory a thread is asked to run in (`roadie send --cwd`).

import fs from 'node:fs'
import path from 'node:path'
import { GitCommandError } from './errors.js'
import { execAsync } from './exec-async.js'

export { execAsync } from './exec-async.js'

export async function git(
  dir: string,
  args: string | string[],
  opts?: { timeout?: number },
): Promise<GitCommandError | string> {
  const command = Array.isArray(args)
    ? { command: 'git', args: ['-C', dir, ...args] }
    : `git -C "${dir}" ${args}`
  const commandLabel = Array.isArray(args)
    ? ['git', '-C', dir, ...args].join(' ')
    : `git -C "${dir}" ${args}`
  const result = await execAsync(
    command,
    opts ? { timeout: opts.timeout } : undefined,
  ).catch((e) => new GitCommandError({ command: commandLabel, cause: e }))
  if (result instanceof Error) return result
  return result.stdout.trim()
}

export async function isGitRepositoryRoot(directory: string): Promise<boolean> {
  const topLevel = await git(directory, 'rev-parse --show-toplevel')
  if (topLevel instanceof Error) return false
  return path.resolve(topLevel) === path.resolve(directory)
}

/**
 * Validate that a directory is a git worktree of the given project.
 * Parses `git worktree list --porcelain` from the project directory and
 * checks that the candidate path appears as one of the listed worktrees.
 * Returns the resolved absolute path on success, or an Error on failure.
 */
export async function validateWorktreeDirectory({
  projectDirectory,
  candidatePath,
}: {
  projectDirectory: string
  candidatePath: string
}): Promise<string | Error> {
  const absoluteCandidate = path.resolve(candidatePath)

  if (!fs.existsSync(absoluteCandidate)) {
    return new Error(`Directory does not exist: ${absoluteCandidate}`)
  }

  const result = await git(projectDirectory, 'worktree list --porcelain')
  if (result instanceof Error) return new Error('Failed to list git worktrees', { cause: result })

  const worktreePaths = result
    .split('\n')
    .filter((line) => {
      return line.startsWith('worktree ')
    })
    .map((line) => {
      return line.slice('worktree '.length)
    })

  if (!worktreePaths.includes(absoluteCandidate)) {
    return new Error(
      `Directory is not a git worktree of ${projectDirectory}: ${absoluteCandidate}`,
    )
  }

  return absoluteCandidate
}

export type SessionWorkingDirectory = {
  kind: 'project' | 'worktree'
  directory: string
}

function isSameOrInsideDirectory({
  parentDirectory,
  candidateDirectory,
}: {
  parentDirectory: string
  candidateDirectory: string
}) {
  const relativePath = path.relative(parentDirectory, candidateDirectory)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  )
}

export async function resolveSessionWorkingDirectory({
  projectDirectory,
  candidatePath,
}: {
  projectDirectory: string
  candidatePath: string
}): Promise<SessionWorkingDirectory | Error> {
  const absoluteProjectDirectory = path.resolve(projectDirectory)
  const absoluteCandidate = path.resolve(candidatePath)

  const stat = await fs.promises.stat(absoluteCandidate).catch((error) => {
    return new Error(`Directory does not exist: ${absoluteCandidate}`, {
      cause: error,
    })
  })
  if (stat instanceof Error) return stat
  if (!stat.isDirectory()) {
    return new Error(`Path is not a directory: ${absoluteCandidate}`)
  }

  if (
    isSameOrInsideDirectory({
      parentDirectory: absoluteProjectDirectory,
      candidateDirectory: absoluteCandidate,
    })
  ) {
    return { kind: 'project', directory: absoluteCandidate }
  }

  const worktreeResult = await validateWorktreeDirectory({
    projectDirectory: absoluteProjectDirectory,
    candidatePath: absoluteCandidate,
  })
  if (worktreeResult instanceof Error) {
    return new Error(
      `Working directory must be inside ${absoluteProjectDirectory} or a git worktree of it: ${absoluteCandidate}`,
      { cause: worktreeResult },
    )
  }

  return { kind: 'worktree', directory: worktreeResult }
}
