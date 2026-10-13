# Agent backend

Roadie's session runtime talks to an *agent backend* through an interface: session operations, catalog listings (providers, models, agents, commands), auth, MCP and a merged event stream. Two backends implement it:

- **Pi** (`pi` coding agent) — the default for every new session (#177). Each session is a `pi --mode rpc` child process; there is no server to start.
- **OpenCode** — the previous default. One shared server, started lazily: only when a session it owns is used, or when it is the configured backend.

## Selecting the backend

| Selection | How |
|---|---|
| Pi (default) | nothing to do |
| OpenCode for every new session | `--backend opencode` (bot command) or `ROADIE_BACKEND=opencode` |
| Per-channel Pi opt-in (deprecated) | `ROADIE_BACKEND=opencode` plus `ROADIE_PI_CHANNELS=<comma-separated channel ids>` |

- `ROADIE_BACKEND` accepts `pi` (default) or `opencode`; anything else stops startup with an error.
- The bot command's `--backend <name>` flag takes the same values and wins over the environment.
- With Pi as the default, `ROADIE_PI_CHANNELS` has no effect (Pi already runs everywhere) and Roadie logs that it is ignored. With `ROADIE_BACKEND=opencode` it keeps working exactly as before and Roadie logs a deprecation warning.

## Pi as the default

- **Version gate.** Roadie needs the `pi` binary (from `ROADIE_PI_BIN`, default `pi`) at major version 1 or newer. If it is missing or older, startup fails with a clear error — there is no silent fallback to OpenCode. Set `ROADIE_BACKEND=opencode` to keep running without Pi.
- **Legacy OpenCode sessions keep working.** Session operations route by session id: ids Pi owns (running processes or session files) go to Pi, everything else goes to OpenCode. Permission and question replies try Pi first, then OpenCode, because request ids are not session-scoped.
- **Lazy OpenCode start.** Bot startup does not start the OpenCode server anymore. The server starts when a legacy OpenCode-owned session is first used (read, prompted, aborted, forked, ...) or when `ROADIE_BACKEND=opencode`. Everything that lists or merges across backends — `roadie session list`, `/last-sessions`, session status, pending questions, MCP status, slash-command registration — works while OpenCode is down and never starts it just to list.
- **Catalogs and logins.** With Pi as the default, `/model`, `/agent` and `/login` show Pi's providers, agents and auth methods (plus whatever plugins add through the `agent_providers`, `agent_definitions` and `agent_backend` filters). With `ROADIE_BACKEND=opencode` they show OpenCode's.
- **Credential pools.** When credential pools are enabled, Pi sessions bill to the pools through the same loopback proxy as before, so the pool proxy starts whenever Pi runs sessions. Pi's own variables: `ROADIE_PI_BIN`, `ROADIE_PI_MODEL`, `ROADIE_PI_TITLE_MODEL`, `ROADIE_PI_SESSION_DIR`.
- **Channel setup.** On first run with Pi as the default, the interactive project-selection step is skipped (it lists OpenCode projects). Bind channels to project directories with `--channels-config` / `ROADIE_CHANNELS_CONFIG`, or run once with `ROADIE_BACKEND=opencode` to pick projects interactively.

The startup log line names the resolved backend, e.g. `Agent backend: pi+opencode` (Pi default, OpenCode for legacy sessions) or `Agent backend: opencode+pi` (legacy OpenCode default with `ROADIE_PI_CHANNELS`).

## Plugins

Plugins can replace or wrap the provider with the `agent_backend` filter; the default it receives follows the selection above. Per-directory catalog listings pass through the `agent_providers` and `agent_definitions` filters on whichever backend serves them. See [Plugins and hooks](../README.md#plugins-and-hooks).
