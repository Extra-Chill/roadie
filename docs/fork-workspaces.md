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

Independent directory binding requires the native OpenCode `targetDirectory`
fork contract tracked by https://github.com/anomalyco/opencode/issues/53385.
Native implementation: https://github.com/anomalyco/opencode/pull/53389.
Passing only the request `directory` is insufficient: OpenCode routes by the
source session's persisted directory.

Roadie sends the explicit target and verifies the returned session directory
before dispatch. An older backend that ignores that field has its unused fork
removed and reports an upgrade requirement; no task prompt runs in the source.
Workspace-adapter sessions retain their own native backend routing contract.

Local activation waits for that native capability to be installed. The default
released-backend suite verifies fail-closed behavior. The real isolation scenario
runs against the linked native repair with `ROADIE_TEST_FORK_TARGET_DIRECTORY=1`.
It executes real tools in two Git worktrees, checks the unchanged source and
dirty-file boundary, and reconstructs runtimes to verify persistence.
