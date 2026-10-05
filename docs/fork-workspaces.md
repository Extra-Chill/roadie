# Fork workspaces

When the host supplies a `fork_workspace` provider, `/fork` automatically works
in a freshly provisioned independent host workspace. There is no user-facing
workspace choice:

```text
/fork prompt:Investigate caching
```

Without a matching provider the fork stays an ordinary conversation fork in the
source directory.

The `fork_workspace` filter supplies a provider with `provision(request)`. The
request contains a unique request ID, source session, thread, project
directory, source working directory, `codingPaths`, chat attribution and the new prompt. The
provider returns a binding or an error:

```ts
{
  workingDirectory: '/code/project@fork',
  projectDirectory: '/code/project',
  label: 'fork-branch',
  kind: 'git-worktree',
  workspaceId: 'opaque-host-workspace-id',
  baseRef: 'committed-source-revision'
}
```

A matching provider must provision successfully before the fork or its task
starts. Provisioning and binding failures fail closed: no fork thread is
created and no prompt runs.

## Conversations with a non-Git home

A conversation can live at a WordPress site root while its coding task works
in a separate repository. Roadie derives `codingPaths` from successful tool
calls persisted in the source session: edit/write file paths, patch file
operations, and explicitly mutating shell calls with a `workdir` or `cwd`.
Read-only tools, failed calls, prose, and directories mentioned in shell text
are not coding scope. Forks with `from:` use only activity before that message.
The backend history is the durable source of truth, including after a runtime
restart; Roadie does not maintain a second scope store or move the source home.

The host resolves those paths to repository ownership. The wp-coding-agents
provider uses Homeboy's registered repository-root components automatically.
If the source is already a Git checkout, that checkout takes precedence over
inherited history. Otherwise, one unique coding repository is required; within
that repository the most recent concrete location identifies the source
checkout. Multiple repositories or an unregistered coding repository stop the
fork with an explanation. No coding repository means an ordinary conversation
fork. A host may optionally restrict ownership with its project configuration.

The host owns allocation, lifecycle and cleanup. Roadie validates the directory,
persists the binding, and displays the workspace and committed base. It preserves
conversation history/model preferences and injects the new working directory.
Uncommitted source edits are not copied.

If conversation setup fails after allocation, `fork_workspace_abandoned` informs
the host with the request and binding. A host can retain failure evidence and
record a terminal disposition rather than deleting the workspace immediately.

## Backend prerequisite

Git worktree forks use OpenCode's existing experimental workspace APIs,
verified against released OpenCode 1.18.31. Set
`OPENCODE_EXPERIMENTAL_WORKSPACES=true` in the backend's startup environment and
restart the backend when activating this feature.

After host allocation, Roadie calls `workspace.syncList` and `workspace.list` in
the target repository's project directory, rather than the source conversation's
home, to find the exact canonical Git worktree directory, forks the conversation normally,
then calls `workspace.warp` with `copyChanges: false`. It verifies the saved native
`workspaceID` before dispatching the task. This adds no model calls or conversation
replay and leaves physical worktree ownership with the host.

Passing only the request `directory` is insufficient: OpenCode routes an existing
session through its persisted directory/workspace binding. Missing workspace
support, a disabled flag, an undiscoverable target, or a failed warp stops setup
before a task prompt runs. An unused fork is removed when binding fails.

The default released-backend fork suite enables the workspace flag in its isolated
fixture. It executes real tools in two Git worktrees without any workspace option,
checks the unchanged source and dirty-file boundary, reconstructs runtimes to
verify persistence, forks a workspace-bound session again, and proves that
removing the provider restores ordinary conversation-fork behavior. It also
proves that an ordinary unregistered directory cannot run the task in the source.
The non-Git-home case records a real coding shell call in a separate repository,
disposes the source runtime, forks across projects, and verifies actual writes in
the target worktree, preserved history, and the unchanged source home.

The proposed native `targetDirectory` extension (anomalyco/opencode#53389) is not
a prerequisite for this Git worktree workflow.
