# Agent backend

Roadie's session runtime talks to an *agent backend* through an interface: session operations, catalog listings (providers, models, agents, commands), auth, MCP and a merged event stream. **Pi** (`pi` coding agent) implements it (#177): each session is a `pi --mode rpc` child process; there is no server to start.

## Running Pi

- **Version gate.** Roadie needs the `pi` binary (from `ROADIE_PI_BIN`, default `pi`) at major version 1 or newer. If it is missing or older, startup fails with a clear error.
- **`ROADIE_BACKEND`.** Optional; when set it must be `pi`. Any other value stops startup with an error.
- **Variables.** `ROADIE_PI_BIN`, `ROADIE_PI_MODEL`, `ROADIE_PI_TITLE_MODEL`, `ROADIE_PI_SESSION_DIR`.
- **Catalogs and logins.** `/model` and `/agent` show Pi's models and agents, plus whatever plugins add through the `agent_providers`, `agent_definitions` and `agent_backend` filters. `/model` skips provider selection when exactly one connected provider has pickable models; otherwise it shows the provider menu first. Hidden pool rotations stay out of the menu (unless all rotations are hidden). Model and thinking-level changes retain session/channel/global scope selection. Use the **Change thinking level** and **Clear session/channel override** buttons on `/model`; there is no separate thinking-level slash command.
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

## Person-scoped MCP servers

Per-person servers (credentials/person MCP, see `src/person-mcp.ts`) are registered under scoped names (`roadie_pm_<hash>_<name>`) and their tools surface as `mcp__<server>__<tool>`, so session permission rules and the `roadie_pm_*` deny/allow pair scope them per person.

A remote person server that advertises protocol revision `2026-07-28` in `server/discover` is registered through Roadie's own stateless MCP client instead of Pi's built-in one: every request carries the revision envelope (`_meta`, `MCP-Protocol-Version`, `Mcp-Method`) and the person's bearer token stays in headers. Servers without the revision, or where discovery fails, keep the built-in client as before.

Form elicitation: a `tools/call` answered with `elicitation/create` form requests surfaces as a `form.asked` event and a dialog (Discord) showing the server's message with Accept / Decline / Cancel plus fields for simple schemas (choice, boolean, string, number). Only the person the server was registered for can answer; nobody else's click is accepted, and the decision never goes through permission rules or "always" choices. Unrenderable schemas answer cancel with an explanatory tool result. Answers continue the same call (`inputResponses` + `requestState`) for up to five rounds; a timeout, an abort or a session end answers cancel so the server runs nothing.

## Plugins

Plugins can replace or wrap the provider with the `agent_backend` filter; the default it receives is Pi. Per-directory catalog listings pass through the `agent_providers` and `agent_definitions` filters. See [Plugins and hooks](../README.md#plugins-and-hooks).
