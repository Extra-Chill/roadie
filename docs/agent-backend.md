# Agent backend

Roadie's session runtime talks to an *agent backend* through an interface: session operations, catalog listings (providers, models, agents, commands), auth, MCP and a merged event stream. **Pi** (`pi` coding agent) implements it (#177): each session is a `pi --mode rpc` child process; there is no server to start.

## Running Pi

- **Version gate.** Roadie needs the `pi` binary (from `ROADIE_PI_BIN`, default `pi`) at major version 1 or newer. If it is missing or older, startup fails with a clear error.
- **`ROADIE_BACKEND`.** Optional; when set it must be `pi`. Any other value stops startup with an error.
- **Variables.** `ROADIE_PI_BIN`, `ROADIE_PI_MODEL`, `ROADIE_PI_TITLE_MODEL`, `ROADIE_PI_SESSION_DIR`.
- **Catalogs and logins.** `/model` and `/agent` show Pi's providers and agents, plus whatever plugins add through the `agent_providers`, `agent_definitions` and `agent_backend` filters.
- **Credential pools.** When credential pools are enabled (the default), Pi sessions bill to the pools through the loopback pool proxy, which starts with the bot. See [Credential pools](credential-pools.md).
- **Channel setup.** Bind channels to project directories with `--channels-config` / `ROADIE_CHANNELS_CONFIG`.

The startup log line names the backend: `Agent backend: pi`.

## Sessions Pi does not own

A thread bound to a session Pi does not own — for example one started on a retired backend — starts a new Pi session on its next prompt. The new session is seeded with one context-only message: the thread's recent chat history (bounded), plus a note that files, tool results and the earlier transcript did not carry over.

## Project configuration

Prompt templates and skills are Pi's own: `.pi/prompts`, `.pi/skills`, `.agents/skills` and the user-level equivalents. Roadie also reads OpenCode-format project configuration for agents and MCP servers and passes it to Pi:

- **Agents:** `.opencode/agent[s]/*.md` and `agent` entries in `opencode.json`, plus the built-in primary and subagent agents. A selected agent contributes its system prompt, model and permission rules to the turn.
- **MCP servers:** `mcp` entries in `opencode.json` (local and remote), plus per-person servers.

`opencode.jsonc` is read as well as `opencode.json`.

## Plugins

Plugins can replace or wrap the provider with the `agent_backend` filter; the default it receives is Pi. Per-directory catalog listings pass through the `agent_providers` and `agent_definitions` filters. See [Plugins and hooks](../README.md#plugins-and-hooks).
