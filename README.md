<div align='center' class='hidden'>
    <br/>
    <br/>
    <h3>roadie</h3>
    <p>Run coding agents from your team chat</p>
    <br/>
    <br/>
</div>

Roadie is a **chat-to-agent bridge**. It connects a team chat (**Discord** or **Slack**) to a coding agent ([Pi](https://github.com/badlogic/pi-mono)) running on your machine or server. Each **channel is a project**, each **thread is a session**: send a message and an agent works in that project, streaming its progress back into the thread.

Roadie is built to be run by a host. Everything a deployment needs to decide (who may talk to the bot, which channels map to which directories, what context and permissions each session gets, how the install is upgraded) is configurable through files, environment variables and plugins, without patching Roadie.

Roadie is a fork of [Kimaki](https://github.com/remorses/kimaki).

## How it works

```diagram
                            ┌──────────────────────────────────────────────────┐
   Discord or Slack         │  Your machine                                    │
  ┌──────────────────┐      │                                                  │
  │ #web-app ────────┼──────┼──▶ /code/web-app   ──▶ agent session (thread)    │
  │ #api ────────────┼──────┼──▶ /code/api       ──▶ agent session (thread)    │
  │ #docs ───────────┼──────┼──▶ /code/docs      ──▶ agent session (thread)    │
  └──────────────────┘      │        ▲                                         │
        │ thread = session  │        │  reads, edits, runs commands            │
        ▼                   │        ▼  in the project directory               │
     agent replies  ◀───────┼──── coding agent (any model, your subscriptions) │
  └──────────────────┘      └──────────────────────────────────────────────────┘
```

- **Channels are projects.** A channel is bound to a project directory. Several channels can share one project and still keep their own audience, response rules and sessions.
- **Threads are sessions.** A message in a project channel starts a thread and an agent session; replies continue it. Search, resume and fork any session later.
- **Two seams keep it generic.** The session runtime talks to an *agent backend* (Pi) and a *chat platform* (Discord, Slack) through interfaces, so neither is hard-wired into the core. See [Agent backend](docs/agent-backend.md).

## Quick start

Install the latest release (Node 22+). Replace `<version>` with the version on the [latest release](https://github.com/Extra-Chill/roadie/releases/latest):

```bash
npm i -g https://github.com/Extra-Chill/roadie/releases/latest/download/extrachill-roadie-<version>.tgz
```

**Discord:** create a bot at [discord.com/developers](https://discord.com/developers/applications), then run `roadie`. The CLI walks you through connecting the bot; bind channels to project directories with a [channel configuration file](#channels-and-projects). Roadie runs sessions on [Pi](#agent-backend), so install the `pi` binary first. Keep it running; it is the bridge between Discord and your machine.

**Slack:** run `roadie --platform slack` with a Slack app's credentials. See [Native Slack](docs/native-slack.md) for the app setup, scopes and receiver.

For a long-running install, see [Running as a service](#running-as-a-service).

## Features

- **All your models, including subscriptions.** Run `/login` to add an API key or an existing Claude Pro/Max or ChatGPT/Codex subscription to a credential pool. Add several accounts and Roadie rotates between them on rate limits.
- **Credential pools.** Roadie's own rotation: ordered pools of API keys (any models.dev provider, or a custom endpoint) and Claude Pro/Max subscriptions exposed as `roadie/<rotation>` models, with per-person routing so each session bills to its owner's accounts. Manage everything from Discord with `/credentials`. See [Credential pools](docs/credential-pools.md) for modes, thread billing, the identity hook's `credential_pool`, and the security limits.
- **Live streaming.** Assistant text, tool calls, context usage and a footer with the model and agent stream into the thread as the run happens.
- **Interactive turns.** Permission requests, questions, action buttons and file requests from the agent become native buttons, selects and dialogs.
- **Conversation intake.** Configure mention/command starts, natural participant follow-ups, and context-only messages with the same [intake policy](docs/conversation-intake.md) on Discord and Slack.
- **Fork.** `/fork` branches the session into a new thread while the original keeps working. Add `prompt:` to start the fork on something, or `from:` to branch from an earlier message. The title agent generates each fork's title from only its new task prompt (or its first message when created without a prompt). Naming runs in the background and never delays task startup. Title requests exclude parent history, tools and coding instructions, bound input to 2,048 characters and output to 96 tokens, and time out after 15 seconds. It runs on the same model routing as any other agent: its own `agent.title.model` when set, otherwise the default model rotation. The source link stays in the conversation; later messages preserve the fork's task title.
- **Subagents.** When a session delegates to a child session, Roadie tracks it and reports it to plugins (see [Subagents](#subagents)).
- **Scheduled tasks.** Run a prompt at a future time or on a cron schedule with `roadie send --send-at`; manage them with `/tasks` or `roadie task list`. Sessions can also sleep and wake themselves later.
- **Thread working directories.** `roadie send --cwd <path>` runs a session in a project subfolder or an existing git worktree, and the thread keeps that folder across restarts. Creating and merging checkouts is left to your own tooling.
- **Images and files** in both directions.
- **Project commands, skills and MCP prompts** become slash commands (Pi's own, plus OpenCode-format `opencode.json` / `.opencode/` config; see [Agent backend](docs/agent-backend.md)). Switch agents with `/<name>-agent`.
- **Shell commands.** Prefix a message with `!` to run it in the thread's working directory.

### How messages reach a busy session

A message sent during an active run **never interrupts it**. The agent picks it up at its **next step boundary**, as soon as the current tool call finishes, and carries on with it in context. A long build, rebase or deploy is never killed halfway because someone typed. While the message waits, it carries a ⏳ reaction.

To stop a run, use `/abort`. To have something done after the current task, say so in the message ("after you finish, run the tests").

## Platforms

### Discord

Roadie registers its slash commands in each server it is invited to. Channels are linked to project directories only through a [channel configuration file](#channels-and-projects); Roadie does not create project channels. Long prompts can be sent as a file attachment ("Send message as file"); Roadie reads attachments as the message.

Without a channel configuration file, Discord access works like this. A user needs **one** of:

- **Server Owner**, **Manage Server** or **Administrator**
- **A role named "Roadie"** (case-insensitive), the recommended way to grant team access

A role named **"no-roadie"** blocks a user, even a server owner. Other bots are ignored unless they have the "Roadie" role. A dedicated Discord server for your agents keeps sessions and permissions separate from everything else.

### Slack

The Slack path talks directly to Slack's Events API, Web API and Block Kit and shares the same runtime, queue, scheduler, permission policy and host hooks as Discord. Sessions are Slack threads; the `/roadie` slash command covers session commands (`new`, `abort`, `model`, `agent`, `session`, `fork`). Access is governed by the [channel configuration](#channels-and-projects) and the host's identity layer.

Some Discord features have no direct Slack equivalent yet (thread titles, a bot typing indicator, native login dialogs). [docs/native-slack.md](docs/native-slack.md) covers setup, the receiver endpoints, scopes and the remaining differences.

## Channels and projects

A deployment can describe its channels in one file, passed with `--channels-config` or `ROADIE_CHANNELS_CONFIG` (YAML or JSON). It works the same for Discord and Slack:

```yaml
projects:
  shared-site:
    directory: /srv/shared-site
    context: shared-site-agent   # opaque id handed to your context hook
    agent: build
channels:
  "123456789012345678":          # channel id, category id, or "*"
    project: shared-site
    who: [owner, "role:team", "person:<host id>"]   # or "everyone"
    respond: always              # always | mention | never
    threads: per-message         # per-message | existing-only | none
  "*":
    respond: never
```

Channels can also set `directory`, `agent`, `model`, `verbosity`, `capabilities` and `permissions` directly. Resolution walks thread → channel → category → `"*"`, the most specific value winning. With a config file, a channel that resolves to no policy is not answered, and an invalid file keeps the last valid one in effect (or answers nothing). The file is reloaded when it changes.

`threads` decides where a conversation lives. `per-message` (the default) starts a thread for each new conversation. `existing-only` never starts one, so only existing threads are answered. `none` answers inline: the channel itself is the conversation, with one long-running session keyed by the channel, so context carries across messages the way it does in a thread. Each turn's first reply is anchored to the message that started it, the channel is never renamed from a session title, and `/abort` works in the channel. Pair it with `respond: mention` so only mentions start turns; other messages are ignored unless an explicit `intake` policy makes them context. `threads: none` is Discord-only for now; Slack channels keep per-message threads.

## Agent backend

Sessions run on **Pi**. Roadie needs the `pi` binary (1.x or newer) on `PATH` or in `ROADIE_PI_BIN`; if it is missing or too old, startup fails with an error. Pi-related variables: `ROADIE_PI_BIN` (executable, default `pi`), `ROADIE_PI_MODEL`, `ROADIE_PI_TITLE_MODEL`, `ROADIE_PI_SESSION_DIR`.

A thread bound to a session Pi does not own (for example one started on the removed OpenCode backend) continues in a new Pi session on its next message, seeded with the thread's recent chat history. See [Agent backend](docs/agent-backend.md) for the details.

## Running as a service

### Configuration

Service installs configure Roadie through the environment; nothing needs to touch the data directory or Roadie's internal modules. Every secret also accepts a `_FILE` variant holding the value, so it can live in a file with restricted permissions instead of a unit file. An unreadable or empty `_FILE` is a startup error.

| Variable | Purpose |
|---|---|
| `ROADIE_PLATFORM` | `discord` (default) or `slack`. Same as `--platform`. |
| `ROADIE_BOT_TOKEN` | Discord bot token. Saved on startup; the application ID is derived from it. |
| `ROADIE_SLACK_BOT_TOKEN`, `ROADIE_SLACK_SIGNING_SECRET` | Slack app credentials (see [Native Slack](docs/native-slack.md) for the rest). |
| `ROADIE_CHANNELS_CONFIG` | The [channel and project file](#channels-and-projects). |
| `ROADIE_SERVICE_TOKEN` | Send token (any secret string). Lets other OS users send through the running bot. Unset, the send endpoint is off. |
| `ROADIE_DATA_DIR` | Data directory (default `~/.roadie`). Same as `--data-dir`. |
| `ROADIE_LOCK_PORT` | Port of the local endpoint (bound to `127.0.0.1`). |
| `ROADIE_MANAGED` | `1`: the host owns installation and upgrades. |
| `ROADIE_PLUGINS` | Plugins to load (comma-separated). Same as `--plugin`. |
| `ROADIE_SHELL_ENV` | Extra agent tool-shell variables as a JSON object of `NAME=template` pairs (see [Shell env](#shell-env)). Same as `--shell-env`. |

### Sending from other users and processes

A user that holds the send token but cannot open the data directory can still run `roadie send`. It posts the options to the running bot (`POST /roadie/send` on the local endpoint), which runs the send as the bot user and streams the output back; `--file` attachments are uploaded with the request. Grant access by sharing the token file, for example through a group with read permission.

The send token only sends. It cannot open the bot's database, so it cannot read stored credentials. A prompt still drives the agent and its tools, so share it as deliberately as shell access. `--pre-run`, which runs a shell command directly, is not available over the endpoint.

### Service contract

| | |
|---|---|
| Single instance | The bot binds `127.0.0.1:<lock port>`. A second bot on the same data directory takes over from the first. |
| Health | `GET http://127.0.0.1:<lock port>/health` returns `{"status":"ok","pid":…,"chatPlatform":"discord","chatReady":true,…}`. No auth. `chatReady` is false until the chat connection is up. |
| Stop | `SIGTERM` (or `SIGINT`). Shutdown is bounded at 15 seconds. |
| Graceful restart | `SIGUSR2` restarts in place under the `roadie` wrapper; a supervisor restart (`systemctl restart`) works the same way. |
| Managed install | With `ROADIE_MANAGED=1`, Roadie never upgrades itself. If a plugin registers a `host_upgrade` handler, `roadie upgrade` and `/upgrade-and-restart` run the host's upgrade and report its result; otherwise `roadie upgrade` refuses and `/upgrade-and-restart` is not registered. |
| Logs | `roadie.log` in the data directory. |

Restart behavior is built in, so the unit needs no pre- or post-start scripts:

- **Orphan cleanup.** The bot records the pid of the agent server it spawns. If a previous run died without cleaning up, the next start stops that leftover server first. A recorded pid that now belongs to another program is left alone.
- **Restart continuation.** On shutdown the bot records which threads had a run in progress. The next start posts a notice in each one and gives the session a continuation turn. Records older than 15 minutes only get the notice. Disable with `ROADIE_RESUME_INTERRUPTED=0`.

## Extending Roadie

### Plugins and hooks

Plugins add **filters** (change a value) and **actions** (react to an event). Load them with `--plugin <path-or-package>` (repeatable) or `ROADIE_PLUGINS`. Each plugin exports `register(roadie)`:

```js
export function register(roadie) {
  // Add host memory to every turn.
  roadie.addFilter('context_sections', async (sections, request) => [
    ...sections,
    { id: 'memory', content: await lookupMemory(request.sessionId) },
  ])
  roadie.addAction('session_idle', ({ sessionId }) => console.log('done', sessionId))
}
```

Lower `priority` runs first (default 10); equal priorities run in registration order. A callback that throws is logged and skipped, so a filter's value passes through unchanged. A plugin that fails to load stops startup instead of silently changing behavior.

| Filter | Value | Context |
|---|---|---|
| `agent_backend` | the agent backend provider (default: Pi) | — |
| `person` | the person behind a chat user, or `null` | `{ actor, context }` |
| `channel_policy` | a channel's policy (`undefined` = built-in, `null` = don't answer) | `{ channelId }` |
| `system_prompt_sections` | system prompt sections, in order | `{ sessionId }` |
| `context_sections` | host context sections for a session start or turn | the context request |
| `agent_providers` | providers and models offered to users (hide, rename, reorder) | `{ directory }` |
| `agent_definitions` | agents offered to users and validated against | `{ directory }` |
| `permission_rules` | a session's permission rules (`{ permission, pattern, action }`, last match wins) | `{ directory, phase }` |
| `host_upgrade` | managed installs only: `null`, or `async ({ trigger }) => ({ ok, message })` that upgrades the install (the host restarts Roadie itself) | `{}` |

| Action | Context |
|---|---|
| `ready` | — |
| `session_idle` | `{ sessionId, threadId, parentSessionId? }` |
| `session_error` | `{ sessionId, threadId, message, parentSessionId? }` |
| `child_session_started` | `{ parentSessionId, childSessionId, agent?, description?, status?, threadId }` |
| `child_session_finished` | `{ parentSessionId, childSessionId, agent?, description?, status?, threadId }` |

Hosts that prefer external commands to code can use the flags `--identity-hook`, `--channels-config`, `--prompt-config` and `--context-provider`. They supply the starting value that filters then refine.

Every turn's tool shells also receive `ROADIE_ACTOR_*`, `ROADIE_THREAD_ID`, `ROADIE_CHANNEL_ID` and `ROADIE_PERSON_ID`, so scripts the agent runs know who they are acting for.

### Shell env

Hosts can export extra environment variables into every agent tool shell, with `--shell-env <NAME=template>` (repeatable) or `ROADIE_SHELL_ENV` as a JSON object. A template can mix literal text with `{field}` placeholders:

```bash
roadie --shell-env 'ROADIE_DEPLOY_HOOK=https://ops.example/hook/{session_id}' \
       --shell-env 'ROADIE_SESSION_LABEL={platform}:{thread_id}'
```

```bash
ROADIE_SHELL_ENV='{"ROADIE_DEPLOY_HOOK": "https://ops.example/hook/{session_id}"}' roadie
```

Names come only from your configuration; Roadie never adds variables on its own behalf and does not know who reads them. Templates are built from the session fields Roadie already knows when it builds the shell environment:

| Field | Value |
|---|---|
| `{session_id}` | The agent session id (unset only in a shell outside any session) |
| `{thread_id}` | The chat thread bound to the session |
| `{channel_id}` | The parent channel of that thread |
| `{platform}` | Chat platform of the current turn's speaker |
| `{actor_id}` | Platform user id of the current turn's speaker |
| `{person_id}` | Host person id from the identity hook, recorded with the actor |

There is no `{thread_url}`: building one needs platform-specific context (a Discord guild id, a Slack workspace) that Roadie does not track per turn. An invalid variable name or an unknown field stops startup with an error rather than exporting a wrong value, and a field with no value for a turn (no channel yet, a turn without a human speaker) leaves that variable unset.

### Subagents

A session can delegate to a child session (the task tool). The agent backend reports this as `child_session_started` / `child_session_finished` (`status` is `completed` or `error`). `parentSessionId` on `session_idle` and `session_error` is the session that spawned this one: the main session for a delegated child, or the session passed to `roadie send --parent-session` for a thread started that way. Together these let an orchestrator plugin track delegated work without knowing which backend runs it.

## Commands

The most common Discord slash commands (Slack exposes the session commands through `/roadie <command>`):

| Command | Description |
|---|---|
| `/abort` | Stop the current run |
| `/fork [prompt] [from]` | Branch the session into a new thread; the original keeps running |
| `/model`, `/agent` | Change the model or agent for this channel or session |
| `/login` | Authenticate a provider (subscription or API key) |
| `/new-session`, `/last-sessions` | Start a session in this project; list recent ones |
| `/compact`, `/context-usage` | Compact the context; show how much is in use |
| `/run-shell-command` | Run a shell command in the thread's working directory |
| `/mcp` | List and manage MCP servers for this project |

The CLI covers the same ground for scripts and other agents: `roadie send` (start or continue sessions, schedule tasks, attach files), `roadie session` (`list`, `read`, `search`, `wait`, `archive`), `roadie project`, `roadie task` and `roadie upload-to-chat`. Run `roadie --help` or `roadie <command> --help` for the details.

## Troubleshooting

If sessions stop responding or the bot misbehaves (crashes, messages not picked up, threads not created), restart it: `/upgrade-and-restart` on a self-managed install, or the service manager on a managed one. Check `roadie.log` in the data directory for the cause.
