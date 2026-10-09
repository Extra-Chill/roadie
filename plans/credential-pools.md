---
title: Credential Pools
description: |
  Configurable AI credentials for Roadie. One mechanism, a credential pool,
  covers a single shared subscription, a rotating shared pool, and
  per-person subscriptions with per-person rotation. Global stays the
  default; per-person is opt-in. Replaces the @subrouter dependency.
prompt: |
  Based on reading cli/src/opencode.ts (single-server lifecycle),
  cli/src/identity.ts (identity hook), cli/src/turn-attribution-env.ts,
  cli/src/schema.ts (session_actors), cli/src/commands/login.ts, and the
  pinned @subrouter/cli 0.6.1 + @subrouter/opencode 0.5.1 sources. The
  chat.headers -> provider fetch path was proven with the spike in
  spikes/credential-pools/ against opencode 1.18.31.
---

# Credential Pools

## Problem

Roadie runs one OpenCode server, and every session uses the credentials in
that server's `auth.json`. `/login` swaps them for the whole bot. That is
right for a single-operator server and wrong for a server where several
people each want to bring their own Claude or ChatGPT subscription.

Servers want different things:

- **Single operator.** One account, or a few of the operator's own accounts
  rotated on rate limits. Nothing about other people.
- **Shared team pool.** Everyone draws from the same accounts.
- **Bring your own subscription.** Each person's sessions bill to that
  person's accounts, rotated in that person's order.
- **Mixed.** Own accounts first, shared pool as a fallback.

Roadie should support all of these through configuration and keep the
current behavior as the default.

## Why not one OpenCode server per person

The obvious isolation, one server per person with its own `HOME`, splits
session storage: a session created on one server does not exist on another,
so fork, search, listing and resume break across people. It costs a full
server per person (about 640 MB RSS on our host), and `singleServer` is
assumed across 20+ files. Rejected.

## Why not subrouter

`@subrouter/*` already routes per request, but around one global pool:

- `subrouterHome()` reads `process.env.SUBROUTER_HOME` on every call,
  `loadAccounts()` takes no scope, and `withStoreLock()` is one global lock.
  A single server serves every person concurrently, so per-person scope
  cannot be faked with env swaps; it would need a rewrite of store, router
  and lock.
- The published packages ship no license file or `license` field, so we
  depend on them but should not copy code from them.
- It is a third-party project with its own roadmap (Kimaki, its CLI).

We keep the idea (tag in `chat.headers`, choose the account in the provider
fetch, rotate on rate limits) and build it Roadie-native.

## Model

**Pool.** An ordered list of accounts plus per-account cooldown state. An
account is an OAuth subscription or an API key for one provider. A pool has
a rotation: ordered `provider/model[#variant]` entries, tried top to bottom,
skipping accounts that are cooling down. Global rotation and per-person
rotation are the same code with a different pool.

**Person key.** `person_id` from the identity hook when configured,
otherwise `<platform>:<actorId>` (e.g. `discord:532385681268408341`). Roadie
does not know what a person is in the host's world; the hook decides.

**Session owner.** The person whose pool a session draws from. Recorded
once when the session is created. Not the same as `session_actors`, which
tracks the *current* speaker and changes every turn.

## Configuration

Flags with env equivalents, following the existing pattern
(`--identity-hook` / `ROADIE_IDENTITY_HOOK`):

| setting | values | default |
| --- | --- | --- |
| `--credentials` / `ROADIE_CREDENTIALS` | `global`, `per-person`, `per-person-fallback` | `global` |
| `--thread-billing` / `ROADIE_THREAD_BILLING` | `owner`, `speaker` | `owner` |
| `--no-credential-pools` / `ROADIE_CREDENTIAL_POOLS=0` | disable entirely, OpenCode's own `auth.json` applies | enabled |

- `global`: every session uses the `shared` pool. Single-operator servers
  set nothing.
- `per-person`: each session uses its owner's pool. An owner with no
  accounts gets told to run `/login`; nothing falls back silently.
- `per-person-fallback`: owner's pool first, then `shared`.
- `thread-billing=owner`: other people talking in your thread bill to you.
  `speaker`: each turn bills to whoever sent it (the owner is resolved per
  turn instead of per session).

### Speaker billing: what a hand-off costs

In `speaker` mode a thread can move between payers, and with them between
providers (alice's rotation is Claude, bob's is GPT). History is stored by
OpenCode, not by the provider, so continuity holds: the spike shows each
turn receiving the full prior conversation as structured user/assistant
messages across the Anthropic and OpenAI wire formats. The tradeoffs:

- **Cache loss.** A switch of account or provider is a prompt-cache miss.
  The person taking over a long thread pays full input price for all of it;
  two people alternating providers never hit cache. Document it, and
  consider a per-server cap or a warning past a token threshold.
- **Reasoning does not cross providers.** Claude thinking blocks and OpenAI
  reasoning items cannot be replayed to the other provider; the next model
  sees answers and tool results, not the reasoning behind them.
- **Context windows differ.** A thread that fits one model may need a
  compaction before a smaller one can take the turn. The router must check
  the candidate's limit against the session size and compact or skip.
- **Privacy.** Bob's turn sends the earlier conversation, including other
  people's messages, to bob's provider account. `speaker` threads should
  say so once, when the payer first changes.
- **Turn granularity.** The payer is fixed per turn: tool follow-ups inside
  one turn stay on the account that started it (live route held until the
  session is idle), so a turn never splits across accounts.

The identity hook may return `credential_pool` to override the pool for a
person (teams sharing a pool, a guest pinned to `shared`, a person denied
any pool). Hook output stays optional and backward compatible.

## Architecture

```
Discord message
  -> identity hook (optional) -> person key
  -> session created: owner = person key   (credential_owners table)
OpenCode server (one)
  -> roadie plugin  chat.headers: x-roadie-session, x-roadie-pool
  -> roadie LanguageModel (roadie/<rotation>):
       read + strip x-roadie-* call headers
       resolve pool -> rotation -> candidates (skip cooldowns)
       per candidate: build the provider's SDK model from the models.dev
         catalog + that account's credentials, call doGenerate/doStream
       429 APICallError -> mark cooldown, next candidate
```

Routing happens at the LanguageModel level, not the HTTP level (issue #136):
`createRoadiePoolProvider().languageModel(rotationName)` returns one
delegating `LanguageModelV3` whose `doGenerate`/`doStream` resolve the pool
list from the (then stripped) `x-roadie-*` call headers, resolve candidates
with the router, and dispatch each candidate through **that provider's own AI
SDK model** — so one rotation can mix providers (e.g.
`anthropic/claude-sonnet-5-5` then `zai-coding-plan/glm-5.3-flash`), and a
z.ai key is never sent to OpenAI. Rate limits are `APICallError`s with status
429 (`retry-after` from `responseHeaders`); every other error is returned
as-is. Per-person/fallback routing and fail-closed 401s are unchanged.

Components:

1. **Pool store** (`cli/src/credentials/store.ts`). One directory per pool
   under `<dataDir>/credentials/<poolId>/` with `accounts.json` (mode 0600)
   and `state.json` (cooldowns, last used). API-key accounts carry an
   optional `baseURL` override. One lock per pool, so people never contend
   with each other. Token refresh writes back under that pool's lock, which
   removes the shared-`auth.json` refresh race.
2. **Owner table** (`credential_owners`: `session_id`, `pool_id`,
   `person_key`, `created_at`). New table, so `schema.sql` creates it with
   no migration.
3. **Router** (`cli/src/credentials/router.ts`). Pool + rotation + cooldowns
   -> candidate list. Keeps the live route per session until idle so tool
   follow-ups stay on one account.
4. **Adapters** (`cli/src/credentials/adapters/`). Anthropic OAuth first
   (per-provider adapters are for subscriptions only), then plain API keys
   for **any** provider through the catalog below. Written from provider
   docs and our own traces, not copied.
5. **Provider catalog** (`cli/src/credentials/provider-catalog.ts`). The
   models.dev data opencode already caches
   (`$XDG_CACHE_HOME/opencode/models.json`; when missing,
   `https://models.dev/api.json` is fetched once and cached under
   `<dataDir>/credentials/models-dev.json`). A provider resolves to a
   bundled AI SDK package (`@ai-sdk/anthropic`, `@ai-sdk/openai`,
   `@ai-sdk/openai-compatible`, `@ai-sdk/google`, `@ai-sdk/groq`,
   `@ai-sdk/xai`, `@ai-sdk/mistral`, `@openrouter/ai-sdk-provider`), else to
   `@ai-sdk/openai-compatible` against the catalog's `api` URL (185+
   providers), else to the account's `baseURL` override (custom endpoints,
   providers declared only in opencode config), else unsupported with a
   clear error. `credentials add-key` (CLI and `/credentials` modal)
   validates the free-text provider against the catalog and lists close
   matches; no provider names are hardcoded.
6. **OpenCode integration.** The Roadie OpenCode plugin adds the
   `chat.headers` hook; a `roadie` provider module is loaded through
   `provider.roadie.npm` (file:// URL) and exposes one delegating
   LanguageModel per rotation. Models are `roadie/<rotation>`.
7. **`/login` changes.** In `global` mode it adds an account to `shared`
   (admin capability, as today). In per-person modes it adds to the
   caller's pool; the flow runs in an ephemeral reply so codes never land
   in a public channel. New `/credentials` to list, reorder and remove
   accounts in your pool.

## Spike result

`spikes/credential-pools/` runs a real `opencode serve` (1.18.31) with a
stub upstream that speaks both the Anthropic Messages and OpenAI chat
wire formats, three pool-aware providers (one per wire, plus a second
OpenAI-compatible provider with its own base URL), and a `chat.headers`
plugin. Three sessions prompt concurrently on
one server, then a fourth session runs three turns that alternate payer and
provider (alice on Anthropic, bob on OpenAI, alice on Anthropic), and a
fifth session prompts through the second OpenAI-compatible endpoint:

```
PASS  A+B alice session billed to alice pool        [ok:alice-2]
PASS  A+B bob session billed to bob pool            [ok:bob-1]
PASS  C alice rotated past rate-limited alice-1     [ok:alice-2]
PASS  C alice-1 was tried and got 429
PASS  D no x-roadie-* header reached upstream
PASS  E untagged session never reached upstream     [401 no credential pool]
PASS  F turns billed to alternating payers          [anth:alice-2 | ok:bob-1 | anth:alice-2]
PASS  F turn 2 (bob, OpenAI wire) saw turn 1 prompt and Anthropic reply
PASS  F turn 3 (alice, Anthropic wire) saw turns 1-2 including the OpenAI reply
PASS  F turn 1 request went out on the Anthropic wire
PASS  G second OpenAI-compatible provider routed to its own base URL
PASS  G the zai provider never used the first provider base URL
```

Wire-level history for the hand-off session, from the stub's request log:

```
anthropic alice-2  [user turn-1]
openai    bob-1    [user turn-1, assistant anth:alice-2, user turn-2]
anthropic alice-2  [user turn-1, assistant anth:alice-2, user turn-2,
                    assistant ok:bob-1, user turn-3]
```

So: the tag reaches the provider fetch per session, concurrent sessions
resolve to different credentials on one server, per-pool rotation works in
the fetch layer, internal headers can be stripped, a missing tag fails
closed, and one session can change payer and provider between turns with
full structured history. Title-generation calls carry the session too, so
they bill to the owner of the first turn. Note: OpenCode itself sends
`x-session-id` and `x-session-affinity` upstream.

Not covered by the spike: thinking/reasoning blocks (the stub returns plain
text) and tool calls crossing providers. Both belong in phase 2's e2e
tests against the deterministic provider.

Run it: `node spikes/credential-pools/run.mjs /path/to/opencode`.

## Security

Phase 1 keeps today's trust model: OpenCode runs as the bot's user, so an
agent with shell can read the credential directory. Acceptable for
`global` mode (it is the operator's own credentials, same as today) and
must be documented as a limit of per-person mode. Per-person servers
should deny the `shell` capability to non-admins through the identity hook.

Phase 3 removes the exposure. The boundary that matters is tool shells vs.
the OpenCode/plugin process, which share an OS user today:

- Step 1 (issue #144, shipped): tool shells stop holding general database
  access. The bot serves typed agent endpoints on its local HTTP server
  (send, session search/read/wait, task list/edit, project list) authorized
  by a per-session agent token — an HMAC of the session id that the
  `shell.env` hook exports as `ROADIE_AGENT_TOKEN` while blanking
  `ROADIE_DB_URL`, `ROADIE_DB_AUTH_TOKEN`, `ROADIE_DB_AUTH_TOKEN_FILE` and
  `ROADIE_SERVICE_TOKEN_FILE` — so the `roadie` subcommands agents run do
  their database reads and writes and Discord REST calls through the bot
  instead of opening the database themselves. The token is never accepted
  on the hrana `/v2` routes or any admin route, and tasks stay scoped to
  the token's session or thread. Plugins in the server process keep their
  access.
- Step 2: run tool shells as a separate unprivileged user, so they cannot
  read the server's `/proc/<pid>/environ`, `<dataDir>` or the pool files.
  Without this step, step 1 scopes the CLI surface the agent drives but the
  shared OS user still protects the files.
- With that boundary in place, a separate token broker is unnecessary.

## Migration from subrouter

- One release with both: subrouter still loads unless
  `--no-subrouter`; `roadie/<rotation>` models are available alongside.
- `roadie credentials import-subrouter` copies `~/.subrouter/auth.json`
  accounts and presets into the `shared` pool and rotations.
- Next release: `subrouter/<preset>` session models are rewritten to the
  imported `roadie/<rotation>`; subrouter and its `/login` entry removed.

## Phases

1. **Pools, global mode.** Store, router, Anthropic + API-key adapters,
   plugin hook, provider, `/login` into `shared`, subrouter import. Behavior
   for existing servers unchanged except the backend.
2. **Per-person.** `--credentials`, owner table, `--thread-billing`,
   per-person `/login` and `/credentials`, identity hook
   `credential_pool`, OpenAI/Codex adapter.
3. **Isolation.** Tool shells scoped to typed agent endpoints with
   per-session tokens (#144), then an unprivileged OpenCode user.
4. **Remove subrouter.**

## Open questions

- Owner for scheduled tasks and `roadie send` sessions with no human
  actor: default to `shared`, or the task creator?
- Forks: does a forked session keep the parent's owner or take the forker?
  Leaning forker, since they asked for it.
- Should a person be able to see that their pool is cooling down (footer
  note, like subrouter's fallback notice)?
- Usage accounting per pool: store token counts per request so hosts can
  show people what they spent.
