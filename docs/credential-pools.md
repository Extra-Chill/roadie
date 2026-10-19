# Credential pools

Credential pools are Roadie's own account rotation: ordered pools of API keys
and provider subscriptions that LLM requests are billed through. One mechanism
covers a single shared subscription, a rotating shared pool, and per-person
subscriptions with per-person rotation. `roadie credentials import-subrouter`
moves existing subrouter accounts over.

Pools are **on by default**. `--no-credential-pools` (or
`ROADIE_CREDENTIAL_POOLS=0`) turns them off: Pi's own auth (its agent dir
`auth.json`, managed with `pi` on the host) applies, and `/login` and
`/credentials` are not registered.

## Configuring pools

```bash
roadie                                         # pools on, shared pool only
roadie --credentials per-person --thread-billing speaker
roadie --no-credential-pools                   # pools off
```

| setting | values | default |
| --- | --- | --- |
| `--no-credential-pools` / `ROADIE_CREDENTIAL_POOLS=0` | turn the pool store, the pool models and the Discord `/login` and `/credentials` commands off | on |
| `--credentials` / `ROADIE_CREDENTIALS` | `global`, `per-person`, `per-person-fallback` | `global` |
| `--thread-billing` / `ROADIE_THREAD_BILLING` | `owner`, `speaker` | `owner` |

A `--credentials per-person` or `per-person-fallback` value keeps pools on
even when `ROADIE_CREDENTIAL_POOLS=0`; only an explicit `--no-credential-pools`
wins over it.

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

A **person** is the `person` filter's `personId` when configured, otherwise
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

History is stored by the agent backend (Pi), not by the provider, so continuity holds: every
turn receives the full prior conversation, even across providers. The
tradeoffs:

- **Cache loss.** A switch of account or provider is a prompt-cache miss. The
  person taking over a long thread pays full input price for all of it; two
  people alternating providers never hit cache.
- **Reasoning does not cross providers.** Claude thinking blocks and OpenAI
  reasoning items cannot be replayed to the other provider; the next model
  sees answers and tool results, not the reasoning behind them.
- **Privacy.** Bob's turn sends the earlier conversation — including other
  people's messages — to bob's provider account. The thread says so once,
  with a notice when the payer first changes.
- **Turn granularity.** A turn never splits across accounts: tool follow-ups
  stay on the account that started the turn (see [Turn affinity](#turn-affinity)).

## The pool models

With pools on, Roadie writes one pool provider, `roadie`, into Pi's agent
directory (`<dataDir>/pi-agent` unless `ROADIE_PI_AGENT_DIR` is set), served
by a loopback proxy in the bot process. Pi never sees a credential: each Pi
process gets its own key, and the proxy maps it to the session and swaps in
the pool account's real credentials.

Each named rotation is one model, `roadie/<rotation>`, selectable with
`/model`. A rotation is an ordered list of `provider/model` entries tried top
to bottom, and it may mix providers freely. Pi speaks Anthropic Messages to the
proxy; the proxy serves each entry in its own wire format:

- `anthropic/*`: forwarded as Anthropic Messages (OAuth shaping, betas).
- API-key providers (models.dev catalog providers like z.ai, or an account's
  `--base-url`): translated to OpenAI-compatible chat completions.
- `openai/*` on a ChatGPT subscription: translated to Codex Responses.

A candidate that fails before its answer starts (a 429, an auth or quota
failure, a 5xx, a network error) falls through to the next. A 429 also cools
the account down (honoring `retry-after`, else 60 seconds). Other errors, such
as a 400 for a malformed request, go back to the client. Set rotations with
`roadie credentials rotation set <name> <provider/model> ...`. For example,
`zai-coding-plan/glm-5.3-flash opencode-go/glm-5.3-flash openai/gpt-6-luna
anthropic/claude-sonnet-5-5` tries each in turn behind `roadie/<name>`. A key
is only ever sent to its own provider.

Translated thinking comes back unsigned, so Pi replays it to the next request
as plain text, the same way it treats another model's thinking.

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

### `/login`

`/login` is registered only while pools are on and never touches Pi's `auth.json`. The provider
picker lists the models.dev catalog, and Anthropic offers both a subscription
login and an API key. The writes go through the same handlers as
`/credentials`: in `global` mode accounts land in `shared` (admin only), in
per-person modes they land in the caller's pool. Every reply is ephemeral.

### CLI (operators)

```bash
roadie credentials list --pool <poolId>
echo <key> | roadie credentials add-key --provider <provider> [--pool <poolId>] [--base-url <url>]
roadie credentials login <anthropic|openai-codex> --pool <poolId>
roadie credentials remove <id> --pool <poolId>
roadie credentials rotation set <name> <provider/model> ... --pool <poolId>
roadie credentials import-subrouter
```

`list`, `add-key`, `login` and `remove` manage the pool host's accounts when
this Roadie uses a remote pool (see below).

## Remote pool

One pool can serve many machines. A **pool host** runs the pool with no chat
platform and no agent backend:

```bash
roadie credentials client add mac-bot                # prints the client key once
roadie credentials client add mac-bot-admin --admin  # a key that may also manage accounts
roadie credentials serve --host 100.64.0.5 --port 47120
```

Accounts, OAuth refresh, rotation and 429 cooldowns live only on the host, so
each refresh token has exactly one holder. Every client is registered with
`roadie credentials client add <name> [--pools <id,id>]`; the host stores only
a hash of the key.

A Roadie bot uses the host instead of its local pool with:

| variable | value |
| --- | --- |
| `ROADIE_POOL_URL` | the host's base URL, e.g. `http://100.64.0.5:47120` |
| `ROADIE_POOL_KEY_FILE` | file holding the bot's client key; model requests use it |
| `ROADIE_POOL_ADMIN_KEY_FILE` | optional: file holding an `--admin` client key; `/credentials`, `/login` and the `roadie credentials` account verbs use it |

With `ROADIE_POOL_ADMIN_KEY_FILE` set, `/credentials` and `/login` on the bot
add, list, reorder and remove the host's accounts. The OAuth code exchange
runs on the host, so the token never reaches the bot. Without it those
commands report the host and the `client add <name> --admin` fix, and write
nothing locally.

An admin client manages only the pools in its own `pools` list. The host
serves the admin API under `/roadie/pool/admin/`, authenticated by
`x-roadie-key`:

| route | body / query |
| --- | --- |
| `GET accounts?pool=<id>` | accounts (no secrets) and rotations |
| `POST accounts/api-key` | `{pool, provider, key, label?, baseURL?}` |
| `POST oauth/start` | `{pool, provider: anthropic \| openai-codex, label?}` → `{flowId, authorizeUrl}` |
| `POST oauth/complete` | `{pool, flowId, input}` (the pasted `code#state` or redirect URL) |
| `DELETE accounts/<id>?pool=<id>` | `{removed}` |
| `POST accounts/reorder` | `{pool, accountId, position}` |

Every request on one client key bills to that client's pools, so a remote
pool serves one person or one team. Per-person routing (`--credentials
per-person`) is a local-pool feature: a multi-person server keeps its own
pool.

## Any-provider API keys and the models.dev catalog

API keys are not limited to a hardcoded provider list. When you add a key, the
free-text provider id is validated against the [models.dev](https://models.dev)
catalog (fetched from `models.dev/api.json` once and cached under
`<dataDir>/credentials/models-dev.json`). How a key is served:

1. Anthropic keys on the Anthropic Messages wire;
2. any other provider as OpenAI-compatible against the account's `baseURL`
   override — for custom endpoints and self-hosted gateways — else the
   catalog's `api` URL;
3. a provider with neither is unsupported, with a clear error.

Typos get the closest catalog names as suggestions. The `baseURL` override
always wins over the catalog, and a `baseURL` bypasses catalog validation —
a custom endpoint is exactly the case the catalog cannot know.

## Subscriptions: Anthropic and ChatGPT

`/credentials login-anthropic` (or `roadie credentials login anthropic`) runs
the Claude Pro/Max OAuth flow: an authorize URL with PKCE, then the code
pasted back into a modal. Tokens are stored per pool, refreshed under that
pool's lock shortly before expiry, and requests are shaped the way Claude Code
sends them (system prefix, beta headers, tool-name round-trip).

A ChatGPT subscription is added through `/login` on Discord (choose OpenAI,
then the ChatGPT subscription), or imported from subrouter or OpenCode (below)
(#198). It is stored under the `openai-codex` provider id and serves the
`openai/<model>` entries of rotations; the proxy translates them to ChatGPT's
Codex Responses endpoint with the account's bearer token and
`chatgpt-account-id`.

Only these subscriptions are supported; other providers' subscriptions are
not (their OAuth is not public).

## Importing from subrouter

```bash
roadie credentials import-subrouter
```

Copies `~/.subrouter/auth.json` accounts and presets into the `shared` pool:
Anthropic OAuth accounts, ChatGPT subscriptions (the `openai` OAuth entry,
imported under the pool's `openai-codex` id), API keys for any
catalog-resolvable provider, and each preset as a same-named rotation
(`#variant` suffixes stripped; `openai/<model>` entries are kept as they are
and served by the imported subscription). The run is idempotent —
accounts already present are reported and skipped — and strictly read-only on
subrouter files. `roadie credentials import-opencode --opencode-data <dir>`
imports an OpenCode install's `auth.json` and `<provider>-oauth-accounts.json`
rotation files with the same rules, read-only on OpenCode files.

## Turn affinity

The router holds a session's live route — pool, account, provider and model —
from the first request of a turn until the session goes idle, so tool
follow-ups stay on one account (and, on mixed-provider rotations, one
provider). The route is held in `<dataDir>/credentials/routes.json` and only
moves when the held account itself fails (a 429 cooldown or a failed OAuth
refresh); the answering candidate is then re-pinned for the rest of the turn.
A TTL of 30 minutes bounds a missed idle event. Requests without a session
resolve candidates fresh, exactly as before.

## Person filter: `credentialPool`

The `person` filter (see [Plugins and hooks](../README.md#plugins-and-hooks))
may return `credentialPool` for a person:

```js
roadie.addFilter('person', async () => ({
  allowed: true,
  personId: 'wp:17',
  capabilities: new Set(['sessions']),
  permissions: [],
  credentialPool: 'shared',
}))
```

The override redirects everything that person bills: their pool becomes the
named pool instead of the derived one. Uses: put a team on one pool, pin a
guest to `shared`, or (combined with per-person mode) deny someone their own
billing entirely. The field is optional; an invalid pool id is ignored.

## Security

**Read this before enabling per-person modes.**

In phases 1–2, credentials live as files under `<dataDir>/credentials/`
(mode 0600, one directory per pool) and, by default, agent tool shells run as
the bot's OS user. That means **an agent with shell access can read every
pool's keys and tokens** — theirs and everyone else's. The file permissions protect
against other OS users, not against the agent your bot runs.

- `global` mode is unaffected in practice: the credentials are the operator's
  own, the same exposure as Pi's own `auth.json`.
- **Per-person servers should deny the `shell` capability to non-admins
  through the `person` filter** (`capabilities: new Set(['sessions'])`, no `'shell'`),
  and keep `!` shell-prefixed messages and similar power tools admin-only.

Phase 3 removes the exposure: the bot process's pool proxy holds every
credential, Pi processes only get a per-process proxy key, so refresh tokens
and API keys never enter the agent's process (#144), and tool shells can be
run as an unprivileged user (below). Until both are on, treat shell access as credential access.

### `--isolate-shells <user>` (opt-in OS isolation)

Step 2 of phase 3. `roadie --isolate-shells <user>` (or
`ROADIE_ISOLATE_SHELLS=<user>`) makes every agent tool shell run as the given
unprivileged user instead of the bot's own OS user. Off by default: with the
flag unset, Pi runs its default shell.

Roadie writes a shell wrapper to `<dataDir>/bin/isolated-shell/bash` (mode
0755, root-owned). Pi takes its tool shell from `shellPath` in its agent dir's
`settings.json`, so Roadie writes the wrapper path there when it owns that dir
(and refuses Pi sessions when it does not); every bash tool call goes through
the wrapper. The wrapper uses util-linux `setpriv`
(`--reuid`/`--regid`/`--init-groups`/`--no-new-privs`) to drop to the agent
user and `env -i` to replace the environment with a fixed allowlist:
`PATH` (a fixed value, not inherited), `HOME` (the agent user's home),
`TERM`, `LANG`, and the `ROADIE_*` attribution vars, `ROADIE_SESSION_ID` and
`ROADIE_AGENT_TOKEN` from #144. Nothing else is inherited — `ROADIE_DB_*`,
`ROADIE_SERVICE_TOKEN_FILE`, `ROADIE_AGENT_TOKEN_SECRET` and provider keys
never reach a tool shell, and the Pi process's `/proc/<pid>/environ` is
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
- `<dataDir>` (including Pi's agent dir and the pool files under
  `<dataDir>/credentials/`) are **not** readable by the agent user (root-owned,
  mode 0700).

What isolation costs: root-owned tools and credentials — `gh auth`, ssh keys,
cloud CLIs — are gone from tool shells unless they are provisioned for the
agent user too. That is the point (per-person servers no longer expose the
operator's identity to every session), and it is why this is opt-in per
server.
