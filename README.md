<div align='center' class='hidden'>
    <br/>
    <br/>
    <h3>roadie</h3>
    <p>A collaborative agent orchestrator, inside Discord</p>
    <br/>
    <br/>
</div>

Roadie is a **collaborative agent orchestrator** that lets you drive [OpenCode](https://opencode.ai) from Discord. Each Discord **channel is a project**, each **thread is a coding session**. Send a message, an AI agent works in the project on your machine.

Roadie is a fork of [Kimaki](https://github.com/remorses/kimaki), reshaped into a bridge that hosts can configure and extend.

## Quick Start

Install the latest release (Node 22+):

```bash
npm i -g https://github.com/Extra-Chill/roadie/releases/latest/download/extrachill-roadie-<version>.tgz
roadie
```

Replace `<version>` with the version on the [latest release](https://github.com/Extra-Chill/roadie/releases/latest). The CLI walks you through connecting your Discord bot and picking projects.

## What is Roadie?

Roadie turns Discord into the control surface for your coding agents. It connects to [OpenCode](https://opencode.ai), a coding agent similar to Claude Code, and maps your work onto Discord's natural structure:

- **Channels are projects.** Each channel is linked to a project directory on your machine.
- **Threads are sessions.** Every message you send starts a thread that maps to one OpenCode session.

This separation is the whole point. Other Discord/iMessage agent tools cram **everything into a single channel**, so sessions pile on top of each other with no clean way to partition them. Roadie splits **projects into channels** and **sessions into threads**, so each piece of work has its own place. Switch projects by switching channels. Switch tasks by switching threads. Search, resume, and fork any of them later.

```diagram
                            ┌──────────────────────────────────────────────────┐
   Discord server           │  Your machine                                    │
  ┌──────────────────┐      │                                                  │
  │ #web-app ────────┼──────┼──▶ /code/web-app   ──▶ OpenCode session (thread) │
  │ #api ────────────┼──────┼──▶ /code/api       ──▶ OpenCode session (thread) │
  │ #docs ───────────┼──────┼──▶ /code/docs      ──▶ OpenCode session (thread) │
  └──────────────────┘      │        ▲                                         │
        │ thread = session  │        │  reads, edits, runs commands            │
        ▼                   │        ▼  in the project directory               │
     agent replies  ◀───────┼──── AI agent (any model, your subscriptions)     │
  └──────────────────┘      └──────────────────────────────────────────────────┘
```

Think of it as texting your codebase: you describe what you want, the agent does it, and the conversation lives in a thread you can return to.

## All your models, including subscriptions

Roadie gives you access to **every model OpenCode supports**: Anthropic, OpenAI, Google, and more. The best part: you can use your existing **Claude Pro/Max** and **ChatGPT/Codex** subscriptions instead of paying per token.

Run `/login`, pick a provider, choose OAuth, and authenticate with your subscription. Roadie authenticates against the provider the same way the native CLIs do, so subscription inference works and per-token costs show as zero. Add several accounts and Roadie rotates between them on rate limits (via [subrouter](https://www.npmjs.com/package/@subrouter/opencode); disable with `--no-subrouter` or `ROADIE_SUBROUTER=0`).

## Core Features

Roadie adds a layer of orchestration features on top of OpenCode. The ones worth knowing first:

- **Scheduled tasks**: run the bot on a schedule (cron or a future time) with `roadie send --send-at`. Manage them with `/tasks` or `roadie task list`.
- **The queue**: queue a message to send when the current run finishes. Use `/queue`, or end any message with `. queue`.
- **Fork**: `/fork` branches the session into a new thread while the original keeps working. Add `prompt:` to start the fork on something right away, or `from:` to branch from an earlier message.
- **Thread working directories**: `roadie send --cwd <path>` runs a session in a project subfolder or an existing git worktree. Roadie remembers the folder for that thread; creating and merging checkouts is left to your own tooling.
- **Images and files**: attach images or files to your message, and see images the agent produces inline in Discord.
- **OpenCode commands**: your OpenCode commands, skills, and MCP prompts become Discord slash commands.
- **Shell commands**: prefix any message with `!` to run a shell command in the thread's working directory.
- **Quick agent switching**: change agent with a `/<name>-agent` command.

## How messages reach a session

When you send a message during an active run, OpenCode normally queues it to run **after the current tool call**. Roadie adds an interrupt: if the current step is still going after ~3 seconds, Roadie **aborts it and force-sends your message**, then resumes. So a message acts as an interrupt instead of waiting forever behind a long-running command.

## Setup

Create a Discord bot at [discord.com/developers](https://discord.com/developers/applications), install Roadie (see Quick Start), then run `roadie` and follow the interactive prompts.

Keep the CLI running; it's the bridge between Discord and your machine.

### Headless setup

Service installs configure Roadie entirely through the environment; nothing needs to touch the data directory or Roadie's internal modules.

| Variable | Purpose |
|---|---|
| `ROADIE_BOT_TOKEN` / `ROADIE_BOT_TOKEN_FILE` | Discord bot token. Saved on startup; the application ID is derived from it. |
| `ROADIE_SERVICE_TOKEN` / `ROADIE_SERVICE_TOKEN_FILE` | Send token: any secret string. Lets other OS users run `roadie send` through the running bot. Unset, the send endpoint is off. |
| `ROADIE_LOCK_PORT` | Port of that local endpoint (bound to `127.0.0.1`). |

Every secret accepts a `_FILE` variant holding the value, so it can live in a file with restricted permissions instead of a unit file. An unreadable or empty `_FILE` is a startup error.

A user that holds the send token but cannot open the data directory can still run `roadie send`: it posts the options to the running bot (`POST /roadie/send` on the local endpoint), which runs the send itself as the bot user and streams the output back. Attachments (`--file`) are uploaded with the request. No shared file permissions or privilege escalation are needed; grant access by sharing the token file, for example through a group with read permission.

The send token only sends. It does not open the bot's database, so it cannot read stored credentials such as the Discord bot token. Sending a prompt still drives the agent and its tools, so share it as deliberately as shell access. `--pre-run`, which runs a shell command directly, is not available over the endpoint.

### Running as a service

The contract a service manager (systemd, launchd, a container) can rely on:

| | |
|---|---|
| Data directory | `--data-dir` or `ROADIE_DATA_DIR` (default `~/.roadie`). Owned by the service user. |
| Single instance | The bot binds `127.0.0.1:<lock port>` (`ROADIE_LOCK_PORT`). A second bot on the same data directory takes over from the first. |
| Health | `GET http://127.0.0.1:<lock port>/health` returns `{"status":"ok","pid":…,"discordReady":true}`. No auth. `discordReady` is false until the Discord connection is up. |
| Stop | `SIGTERM` (or `SIGINT`). Shutdown is bounded at 15 seconds. |
| Graceful restart | `SIGUSR2` restarts in place under the `roadie` wrapper; a supervisor restart (`systemctl restart`) works the same way. |
| Managed install | `ROADIE_MANAGED=1`: the host owns installation. Roadie never upgrades itself, `roadie upgrade` refuses, and `/upgrade-and-restart` is not registered. |

Restart behavior is built in, so the unit needs no pre- or post-start scripts:

- **Orphan cleanup.** The bot records the pid of the agent server it spawns. If a previous run died without cleaning up, the next start stops that leftover server first. A recorded pid that now belongs to some other program is left alone.
- **Restart continuation.** On shutdown the bot records which threads had a run in progress. The next start posts a notice in each one and gives the session a continuation turn. Records older than 15 minutes only get the notice. Disable with `ROADIE_RESUME_INTERRUPTED=0`.

## Plugins and hooks

Roadie is extended with plugins, which add **filters** (change a value) and **actions** (react to an event). Load plugins with `--plugin <path-or-package>` (repeatable) or `ROADIE_PLUGINS` (comma-separated). Each plugin exports `register(roadie)`:

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
| `agent_backend` | the agent backend provider (default: OpenCode) | — |
| `person` | the person behind a chat user, or `null` | `{ actor, context }` |
| `channel_policy` | a channel's policy (`undefined` = built-in, `null` = don't answer) | `{ channelId }` |
| `system_prompt_sections` | system prompt sections, in order | `{ sessionId }` |
| `context_sections` | host context sections for a session start or turn | the context request |
| `agent_providers` | providers and models offered to users (hide, rename, reorder) | `{ directory }` |
| `agent_definitions` | agents offered to users and validated against | `{ directory }` |

| Action | Context |
|---|---|
| `ready` | — |
| `session_idle` | `{ sessionId, threadId }` |
| `session_error` | `{ sessionId, threadId, message }` |

The flags `--identity-hook`, `--channels-config`, `--prompt-config` and `--context-provider` keep working: they supply the starting value that filters then refine, so hosts that integrate through external commands need no code.

## Commands

Roadie ships a full set of slash commands and a CLI. The most common slash commands:

| Command | Description |
|---|---|
| `/abort` | Stop the current running session |
| `/model` | Change the AI model for this channel or session |
| `/agent` | Change the agent for this channel or session |
| `/login` | Authenticate a provider (OAuth subscription or API key) |
| `/queue <message>` | Queue a message to send after the current response finishes |
| `/fork [prompt] [from]` | Branch the session into a new thread; the original keeps running |
| `/new-session` | Start a session in this project |
| `/last-sessions` | List recent sessions |
| `/compact` | Compact the session's context |
| `/context-usage` | Show how much of the context window is in use |
| `/run-shell-command` | Run a shell command in the thread's working directory |
| `/mcp` | List and manage MCP servers for this project |

The CLI covers the same ground for scripts and other agents: `roadie send` (start or continue sessions, schedule tasks, attach files), `roadie session` (`list`, `read`, `search`, `wait`, `archive`), `roadie project`, `roadie task` and `roadie upload-to-discord`. Run `roadie --help` or `roadie <command> --help` for the details.

## Access Control

Roadie checks Discord permissions before processing any message. Users need **one** of:

- **Server Owner**
- **Manage Server** permission
- **Administrator** permission
- **"Roadie" role** — create a role with this name (case-insensitive) and assign it to trusted users

The "Roadie" role is the recommended approach for team access. Messages from users without any of these are ignored.

- **Blocking access**: create a role named **"no-roadie"** (case-insensitive) to block specific users, even server owners.
- **Multi-agent orchestration**: other Discord bots are ignored by default. Assign the "Roadie" role to another bot to let it trigger Roadie sessions.

## Best Practices

- **Create a dedicated Discord server** for your agents. This keeps coding sessions separate and gives you full control over permissions.
- **Use the "Roadie" role** for team access.
- **Send long prompts as file attachments.** Tap the plus icon and use "Send message as file" for longer prompts. Roadie reads file attachments as your message.

## Troubleshooting

If sessions stop responding, fail to start, or the bot behaves unexpectedly, run `/restart-opencode-server` in any channel. This restarts the backend OpenCode server while keeping the bot connected to Discord. It fixes most transient issues.

If the problem persists, or if the issue is with the bot itself (crashes, messages not picked up, threads not created), run `/upgrade-and-restart` to update to the latest release and do a full restart. On managed installs (`ROADIE_MANAGED=1`), restart through the host's service manager instead.

Logs are in `roadie.log` in the data directory (`~/.roadie` by default).
