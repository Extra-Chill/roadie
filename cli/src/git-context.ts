// Git branch context for the model: which branch (or detached HEAD) a
// session's checkout is on, and when that changed since it was last announced.
// Used by the Pi backend for project context.

import { FilesystemOperationError } from './errors.js'
import { execAsync } from './exec-async.js'

export type GitState = {
  key: string
  kind: 'branch' | 'detached-head' | 'detached-submodule'
  label: string
  warning: string | null
}

export function shouldInjectBranch({
  previousGitState,
  currentGitState,
}: {
  previousGitState: GitState | undefined
  currentGitState: GitState | null
}): { inject: false } | { inject: true; text: string } {
  if (!currentGitState) {
    return { inject: false }
  }
  if (previousGitState && previousGitState.key === currentGitState.key) {
    return { inject: false }
  }
  // Trailing newline so this synthetic part does not fuse with the next text
  // part when the model concatenates message parts.
  const base = currentGitState.warning || `\n[current git branch is ${currentGitState.label}]`
  return { inject: true, text: `${base}\n` }
}

export async function resolveGitState({
  directory,
}: {
  directory: string
}): Promise<GitState | null> {
  const branchResult = await execAsync('git symbolic-ref --short HEAD', { cwd: directory })
    .catch((e) => new FilesystemOperationError({ operation: 'gitBranch', cause: e }))
  if (!(branchResult instanceof Error)) {
    const branch = branchResult.stdout.trim()
    if (branch) {
      return {
        key: `branch:${branch}`,
        kind: 'branch',
        label: branch,
        warning: null,
      }
    }
  }

  const shaResult = await execAsync('git rev-parse --short HEAD', { cwd: directory })
    .catch((e) => new FilesystemOperationError({ operation: 'gitRevParse', cause: e }))
  if (shaResult instanceof Error) return null

  const shortSha = shaResult.stdout.trim()
  if (!shortSha) {
    return null
  }

  const superprojectResult = await execAsync('git rev-parse --show-superproject-working-tree', {
    cwd: directory,
  }).catch((e) => new FilesystemOperationError({ operation: 'gitSuperproject', cause: e }))
  const superproject =
    superprojectResult instanceof Error ? '' : superprojectResult.stdout.trim()
  if (superproject) {
    return {
      key: `detached-submodule:${shortSha}`,
      kind: 'detached-submodule',
      label: `detached submodule @ ${shortSha}`,
      warning:
        `\n[warning: submodule is in detached HEAD at ${shortSha}. ` +
        'create or switch to a branch before committing.]',
    }
  }

  return {
    key: `detached-head:${shortSha}`,
    kind: 'detached-head',
    label: `detached HEAD @ ${shortSha}`,
    warning:
      `\n[warning: repository is in detached HEAD at ${shortSha}. ` +
      'create or switch to a branch before committing.]',
  }
}
