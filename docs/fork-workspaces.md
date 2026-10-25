# Fork workspaces

When the host supplies a `fork_workspace` provider, `/fork` automatically works
in a freshly provisioned independent host workspace. There is no user-facing
workspace choice:

```text
/fork prompt:Investigate caching
```

Without a matching provider the fork stays an ordinary conversation fork in the
source directory. With `/fork channel:<text channel>`, the thread instead starts
in that channel's Roadie project. The target must have `projectDirectory`
metadata. Its channel ID and project directory are sent to `fork_workspace`;
`sourceDirectory` always remains the source thread's working directory. Without
a provider, the fork works directly in the target project. Cross-channel forks
use the target channel defaults and regenerate the system prompt.

The `fork_workspace` filter supplies a provider with `provision(request)`. The
request contains a unique request ID, source session, thread, project
directory, source working directory, chat attribution and the new prompt. The
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

A conversation can live at a WordPress site root while its active coding task
owns a separate checkout. Roadie supplies the source session ID to the host;
repository selection performs no transcript read, tool-history inspection or
prompt parsing.

The wp-coding-agents shell adapter exports an opaque source-session reference
as `HOMEBOY_CALLER_CONTEXT`. Homeboy captures it at original task admission and
persists the task's controller checkout authority. The host reads
`homeboy agent-task active-scope --context <reference>`, a bounded indexed
projection of queued/running task ownership. Existing lifecycle transitions
remove terminal tasks from that projection. The immutable admission context
survives detachment, retry and restart; a new fork's task uses its own session ID.

One active checkout selects the repository. Multiple active checkouts or pending
allocation stop setup with an explanation. With no active task, an existing
Git/worktree-bound conversation uses its own checkout; a non-Git conversation
retains ordinary conversation-fork behavior. `from:` controls the copied
conversation boundary, while repository authority comes from the current task.
The host verifies the selected checkout against its registered Homeboy owner.
An unavailable ownership API fails closed; there is no history-based fallback.

The host owns allocation, lifecycle and cleanup. Roadie validates the directory,
persists the binding, and displays the workspace and committed base. It preserves
conversation history/model preferences and injects the new working directory.
Uncommitted source edits are not copied.

If conversation setup fails after allocation, `fork_workspace_abandoned` informs
the host with the request and binding. A host can retain failure evidence and
record a terminal disposition rather than deleting the workspace immediately.

## Backend binding

Pi binds a fork to the provisioned workspace by copying the session file and
rewriting the forked session's working directory to the binding's
`workingDirectory`; the fork then resumes there. This adds no model calls or
conversation replay and leaves physical worktree ownership with the host. A
backend that cannot bind returns an error and leaves no fork behind.
