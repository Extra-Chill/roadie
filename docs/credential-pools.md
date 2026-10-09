# Credential pools

Credential pools are Roadie's own account rotation: ordered pools of API keys
and provider subscriptions that LLM requests are billed through. One mechanism
covers a single shared subscription, a rotating shared pool, and per-person
subscriptions with per-person rotation. When pools are on, they replace the
[@subrouter](https://www.npmjs.com/package/@subrouter/opencode) dependency for
routing; `roadie credentials import-subrouter` moves existing subrouter
accounts over.

Pools are **opt-in**. Without the flags below nothing changes: `/login` writes
OpenCode's `auth.json` and every session uses it, exactly as before.

## Enabling pools

```bash
roadie --credential-pools                      # pools on, shared pool only
roadie --credential-pools --credentials per-person --thread-billing speaker
```

| setting | values | default |
| --- | --- | --- |
| `--credential-pools` / `ROADIE_CREDENTIAL_POOLS=1` | turn the pool store, the `roadie/<rotation>` models and the Discord `/credentials` command on | off |
| `--credentials` / `ROADIE_CREDENTIALS` | `global`, `per-person`, `per-person-fallback` | `global` |
| `--thread-billing` / `ROADIE_THREAD_BILLING` | `owner`, `speaker` | `owner` |

A `--credentials per-person` or `per-person-fallback` value implies
`--credential-pools`, so per-person servers only need one flag.

## Modes

- **`global`** — every session bills to the `shared` pool. Single-operator
  servers: add your accounts to `shared` and stop reading.
- **`per-person`** — each session bills to its owner's pool. The owner is the
  first person to speak in a thread, recorded once. An owner with no accounts
  gets a clear error telling them to run `/credentials add-key` or
  `/credentials login-anthropic`; nothing falls back silently.
- **`per-person-fallback`** — the owner's pool first, then `shared` as a
  fallback. Use it when some people have subscriptions and others draw from a
  team account.

A **person** is the identity hook's `person_id` when configured, otherwise
`<platform>:<actorId>` (e.g. `discord:532385681268408341`). Each person gets
their own pool directory under `<dataDir>/credentials/<poolId>/`, with its own
lock, so people never contend with each other and an OAuth refresh for one
person never races another's request.

## Thread billing

In per-person modes `--thread-billing` decides who pays a thread:

- **`owner`** (default) — the first speaker owns the session; everyone who
  talks in their thread bills to the owner's accounts. Right for pair work in
  one person's thread.
- **`speaker`** — each turn bills to whoever sent it. A thread can move
  between payers (and providers) as people take turns.

### What a speaker-billing hand-off costs

History is stored by OpenCode, not by the provider, so continuity holds: every
turn receives the full prior conversation, even across providers. The
tradeoffs:

- **Cache loss.** A switch of account or provider is a prompt-cache miss. The
  person taking over a long thread pays full input price for all of it; two
  people alternating providers never hit cache.
- **Reasoning does not cross providers.** Claude thinking blocks and OpenAI
  reasoning items cannot be replayed to the other provider; the next model
  sees answers and tool results, not the reasoning behind them.
- **Context windows differ.** The router skips a candidate whose model's
  context window (from the models.dev catalog) is smaller than the
  conversation's estimated input, so a thread that fits one model rolls to a
  larger one instead of failing mid-hand-off. A request whose candidates are
  all too small fails with a message asking for compaction.
- **Privacy.** Bob's turn sends the earlier conversation — including other
  people's messages — to bob's provider account. The thread says so once,
  with a notice when the payer first changes.
- **Turn granularity.** A turn never splits across accounts: tool follow-ups
  stay on the account that started the turn (see [Turn affinity](#turn-affinity)).

## The `roadie/<rotation>` models

With pools on, Roadie loads a `roadie` provider into OpenCode. Each named
rotation in a pool becomes a model `roadie/<rotation>` (for example
`roadie/default`), selectable with `/model`. A rotation is an ordered list of
`provider/model` entries tried top to bottom; a 429 rate limit cools the
account down (honoring `retry-after`, else 60 seconds) and the next candidate
answers. Set rotations with `roadie credentials rotation set <name> <provider/model> ...`.
A rotation may mix providers: `anthropic/claude-sonnet-5-5` followed by
`zai-coding-plan/glm-5.3-flash` is fine, and a z.ai key is never sent to any
other provider.

## Managing accounts

### `/credentials` (Discord)

Registered only when pools are on. Everything replies ephemerally: nothing
about credentials is ever posted in a channel, and keys are only ever entered
in a modal.

- `/credentials list` — accounts and rotations in your pool (no secrets)
- `/credentials add-key provider:<provider>` — add an API key (modal, plus an
  optional base URL override)
- `/credentials login-anthropic` — add a Claude Pro/Max subscription (OAuth:
  authorize URL, then paste the code back into a modal)
- `/credentials remove account:<id>` — remove an account
- `/credentials reorder account:<id> position:<n>` — move an account in the
  pool order (the router's tiebreaker within one provider)

In per-person modes the command manages **your own pool**. Writing to
`shared` requires admin capability (server administrator, or the identity
hook's `admin`).

### `/login` with pools on

With pools on, `/login` never touches OpenCode's `auth.json`. The provider
picker lists the models.dev catalog, and Anthropic offers both a subscription
login and an API key. The writes go through the same handlers as
`/credentials`: in `global` mode accounts land in `shared` (admin only), in
per-person modes they land in the caller's pool. Every reply is ephemeral.
With pools off, `/login` is unchanged.

### CLI (operators)

```bash
roadie credentials list --pool <poolId>
echo <key> | roadie credentials add-key --provider <provider> [--pool <poolId>] [--base-url <url>]
roadie credentials login anthropic --pool <poolId>
roadie credentials remove <id> --pool <poolId>
roadie credentials rotation set <name> <provider/model> ... --pool <poolId>
roadie credentials import-subrouter
```

## Any-provider API keys and the models.dev catalog

API keys are not limited to a hardcoded provider list. When you add a key, the
free-text provider id is validated against the [models.dev](https://models.dev)
catalog — the same data OpenCode already caches
(`~/.cache/opencode/models.json`; when missing it is fetched from
`models.dev/api.json` once and cached under
`<dataDir>/credentials/models-dev.json`). Resolution order for a key:

1. a bundled AI SDK package (`@ai-sdk/anthropic`, `@ai-sdk/openai`,
   `@ai-sdk/google`, `@ai-sdk/groq`, `@ai-sdk/xai`, `@ai-sdk/mistral`,
   `@openrouter/ai-sdk-provider`), else
2. OpenAI-compatible against the catalog's `api` URL (185+ providers), else
3. OpenAI-compatible against the account's `baseURL` override — for custom
   endpoints, self-hosted gateways, and providers declared only in your
   OpenCode config, else
4. unsupported, with a clear error.

Typos get the closest catalog names as suggestions. The `baseURL` override
always wins over the catalog, and a `baseURL` bypasses catalog validation —
a custom endpoint is exactly the case the catalog cannot know. The catalog
also supplies each model's context-window limit for the speaker-billing check
above.

## Anthropic subscriptions

`/credentials login-anthropic` (or `roadie credentials login anthropic`) runs
the Claude Pro/Max OAuth flow: an authorize URL with PKCE, then the code
pasted back into a modal. Tokens are stored per pool, refreshed under that
pool's lock shortly before expiry, and requests are shaped the way Claude Code
sends them (system prefix, beta headers, tool-name round-trip). Only Anthropic
subscriptions are supported; other providers' subscriptions are not (their
OAuth is not public).

## Importing from subrouter

```bash
roadie credentials import-subrouter
```

Copies `~/.subrouter/auth.json` accounts and presets into the `shared` pool:
Anthropic OAuth accounts, API keys for any catalog-resolvable provider, and
each preset as a same-named rotation (`#variant` suffixes stripped). The run
is idempotent — accounts already present are reported and skipped — and
strictly read-only on subrouter files.

## Turn affinity

The router holds a session's live route — pool, account, provider and model —
from the first request of a turn until the session goes idle, so tool
follow-ups stay on one account (and, on mixed-provider rotations, one
provider). The route is held in `<dataDir>/credentials/routes.json` and only
moves when the held account itself fails (a 429 cooldown or a failed OAuth
refresh); the answering candidate is then re-pinned for the rest of the turn.
A TTL of 30 minutes bounds a missed idle event. Requests without a session
resolve candidates fresh, exactly as before.

## Identity hook: `credential_pool`

The identity hook (`--identity-hook <command>`, see
[Plugins and hooks](README.md#plugins-and-hooks)) may return `credential_pool`
for a person:

```json
{
  "allowed": true,
  "person_id": "wp:17",
  "capabilities": ["sessions"],
  "credential_pool": "shared"
}
```

The override redirects everything that person bills: their pool becomes the
named pool instead of the derived one. Uses: put a team on one pool, pin a
guest to `shared`, or (combined with per-person mode) deny someone their own
billing entirely. The field is optional and hooks that do not send it behave
as before; an invalid pool id is ignored.

## Security

**Read this before enabling per-person modes.**

In phases 1–2, credentials live as files under `<dataDir>/credentials/`
(mode 0600, one directory per pool) and the OpenCode server runs as the bot's
OS user. That means **an agent with shell access can read every pool's keys
and tokens** — theirs and everyone else's. The file permissions protect
against other OS users, not against the agent your bot runs.

- `global` mode is unaffected in practice: the credentials are the operator's
  own, the same exposure as plain OpenCode with `auth.json`.
- **Per-person servers should deny the `shell` capability to non-admins
  through the identity hook** (`capabilities: ["sessions"]`, no `"shell"`),
  and keep `!` shell-prefixed messages and similar power tools admin-only.

Phase 3 removes the exposure: the bot process brokers short-lived access
tokens to the OpenCode server per session (#144), refresh tokens and API keys
never enter the agent's process, and tool shells can be run as an unprivileged
user (below). Until both are on, treat shell access as credential access.

### `--isolate-shells <user>` (opt-in OS isolation)

Step 2 of phase 3. `roadie --isolate-shells <user>` (or
`ROADIE_ISOLATE_SHELLS=<user>`) makes every agent tool shell run as the given
unprivileged user instead of the bot's own OS user. Off by default: with the
flag unset, `SHELL` and the generated OpenCode config are unchanged.

Roadie writes a shell wrapper to `<dataDir>/bin/isolated-shell/bash` (mode
0755, root-owned) and starts `opencode serve` with `SHELL` pointing at it —
OpenCode picks its tool shell from `$SHELL`, so every bash tool call goes
through the wrapper. The wrapper uses util-linux `setpriv`
(`--reuid`/`--regid`/`--init-groups`/`--no-new-privs`) to drop to the agent
user and `env -i` to replace the environment with a fixed allowlist:
`PATH` (a fixed value, not inherited), `HOME` (the agent user's home),
`TERM`, `LANG`, and the `ROADIE_*` attribution vars, `ROADIE_SESSION_ID` and
`ROADIE_AGENT_TOKEN` from #144. Nothing else is inherited — `ROADIE_DB_*`,
`ROADIE_SERVICE_TOKEN_FILE`, `ROADIE_AGENT_TOKEN_SECRET` and provider keys
never reach a tool shell, and the OpenCode server's `/proc/<pid>/environ` is
unreadable for the agent user.

Requirements, checked at startup (the bot fails fast with a clear message):

- Linux with `setpriv` and `bash` on `PATH` (util-linux).
- The bot runs as root, or with `CAP_SETUID` + `CAP_SETGID` (for example
  `AmbientCapabilities=CAP_SETUID CAP_SETGID` in its service unit).
- The agent user exists (`useradd --system --create-home ...`).

Directory layout the startup check (and an operator should) confirm:

- Project directories are readable **and writable** by the agent user — a
  shared group plus setgid directories:
  `chgrp <agent-group> <project> && chmod 2770 <project>`.
- `<dataDir>`, `~/.local/share/opencode` and the pool files under
  `<dataDir>/credentials/` are **not** readable by the agent user (root-owned,
  mode 0700).

What isolation costs: root-owned tools and credentials — `gh auth`, ssh keys,
cloud CLIs — are gone from tool shells unless they are provisioned for the
agent user too. That is the point (per-person servers no longer expose the
operator's identity to every session), and it is why this is opt-in per
server. Note the `~/.roadie/bin/roadie` shim is inside the private data dir,
so agent-mode `roadie` subcommands need their own agent-user-accessible
provisioning under this flag.
