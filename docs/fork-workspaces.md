# Fork workspaces

Forks can share the source directory or request an independent host workspace:

```text
/fork prompt:Investigate caching workspace:separate
/fork prompt:Discuss the architecture workspace:shared
```

Slack uses `/roadie fork <thread timestamp> --workspace separate <prompt>` or
`--workspace shared`. Omission follows the host provider's default; without a
provider it remains shared.

The `fork_workspace` filter supplies a provider with `defaultMode` and
`provision(request)`. The request contains a unique request ID, source session,
thread, project directory, source working directory, chat attribution and the
new prompt. The provider returns:

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

The host owns allocation, lifecycle and cleanup. Roadie validates the directory,
persists the binding, and displays the workspace and committed base. It preserves
conversation history/model preferences and injects the new working directory.
Uncommitted source edits are not copied. Explicit sharing performs no allocation.

If conversation setup fails after allocation, `fork_workspace_abandoned` informs
the host with the request and binding. A host can retain failure evidence and
record a terminal disposition rather than deleting the workspace immediately.

## Backend prerequisite

Separate Git worktree forks use OpenCode's existing experimental workspace APIs,
verified against released OpenCode 1.18.31. Set
`OPENCODE_EXPERIMENTAL_WORKSPACES=true` in the backend's startup environment and
restart the backend when activating this feature.

After host allocation, Roadie calls `workspace.syncList` and `workspace.list` to
find the exact canonical Git worktree directory, forks the conversation normally,
then calls `workspace.warp` with `copyChanges: false`. It verifies the saved native
`workspaceID` before dispatching the task. This adds no model calls or conversation
replay and leaves physical worktree ownership with the host.

Passing only the request `directory` is insufficient: OpenCode routes an existing
session through its persisted directory/workspace binding. Missing workspace
support, a disabled flag, an undiscoverable target, or a failed warp stops setup
before a task prompt runs. An unused fork is removed when binding fails.

The default released-backend fork suite enables the workspace flag in its isolated
fixture. It executes real tools in two Git worktrees, checks the unchanged source
and dirty-file boundary, and reconstructs runtimes to verify persistence. It also
proves that an ordinary unregistered directory cannot run the task in the source.

The proposed native `targetDirectory` extension (anomalyco/opencode#53389) is not
a prerequisite for this Git worktree workflow.
