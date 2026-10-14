---
title: Debugging and profiling roadie
description: >
  Recipes for debugging the roadie bot: the log file, agent session event
  JSONL (env vars, sqlite export, compacted buffer shape, jq queries), heap
  snapshots, live CPU profiling, and CPU profiling tests. Read when debugging
  session state, event ordering, memory, CPU, or slow tests.
---

# Debugging and profiling roadie

| Symptom                                        | Start with                                  |
| ---------------------------------------------- | ------------------------------------------- |
| bot error, session not responding              | `<dataDir>/roadie.log`                      |
| wrong footer, stuck typing, ordering bug       | session event JSONL + jq                    |
| memory growth                                  | heap snapshot (`kill -SIGUSR1 <PID>`)       |
| high CPU in the running bot                    | `cpuprof` in the bot terminal               |
| slow test file                                 | `VITEST_CPU_PROF=1`                         |

## logs

roadie writes logs to `<dataDir>/roadie.log` (default `~/.roadie/roadie.log`). The log file is reset on every bot startup, so it only contains logs from the current run. File logging works in all environments (dev and production), also under vitest when terminal logs are suppressed.

## IPC database authentication after restart

The local database service keeps its default credential in
`<dataDir>/secrets/db-auth-token` with owner-only permissions. Agent child processes
inherit `ROADIE_DB_AUTH_TOKEN_FILE`, and authenticated HTTP requests read the
current credential at dispatch time. Configured inline or file credentials use
the existing `ROADIE_DB_AUTH_TOKEN` / `ROADIE_DB_AUTH_TOKEN_FILE` contract.
The database listener binds authorization to that credential for its lifetime;
later bot credential loading keeps its separate identity and does not replace
the listener's expected credential.

For repeated `thread_sessions` or `session_actors` query failures, compare the
long-lived plugin's failure with a fresh authenticated client. Retained session
events include the failing sleep tool result. The restart regression exercises a
cached database handle, credential-file rotation, actual sleep persistence, and
a response lost after a committed write to verify single-dispatch behavior.

## session event JSONL

To debug agent backend event ordering, set `ROADIE_LOG_SESSION_EVENTS=1`. This writes JSONL files under `<dataDir>/session-events/` (one file per session id). Use `ROADIE_SESSION_EVENTS_DIR` to override the output directory.

Each line holds the backend's native record as-is, tagged with the backend that produced it (`"backend": "pi"`).

Example when running a test to debug events:

```bash
ROADIE_SESSION_EVENTS_DIR=./tmp/roadie-test-3423 ROADIE_LOG_SESSION_EVENTS=1 pnpm run test --run src/test-file.test.ts -t test-name
```

For live user-session debugging (without restarting with env vars), export the persisted session event buffer from sqlite:

```bash
roadie session export-events-jsonl --session <session_id> --out ./tmp/session-events.jsonl
```

Use this for session-state regressions (for example a footer appearing after abort). Copy the exported JSONL into `cli/src/session-handler/event-stream-fixtures/` and add or update `event-stream-state.test.ts` coverage for the pure derivation helpers.

### compacted buffer shape

`ThreadSessionRuntime` keeps the last 1000 agent events (`cli/src/agent-backend/events.ts`) in memory per thread (`eventBuffer`) for event-sourcing derivation and waiters. The buffer stores a compacted event shape to avoid memory spikes:

- `session.diff` events: dropped
- `message` user events: strip `message.system`
- `part` text/reasoning: truncate long `text`
- `part` tool: replace `input` with `{}`, truncate `output` and `error`

Each JSONL line is intentionally minimal: `{ timestamp, threadId, projectDirectory, event }`.

### jq recipes

```bash
# list event type counts for one session file
jq -r '.event.type' ~/.roadie/session-events/<session_id>.jsonl | sort | uniq -c

# show timestamps + event types
jq -r '[.timestamp, .event.type] | @tsv' ~/.roadie/session-events/<session_id>.jsonl

# exported agent events: lifecycle only (status/idle/error)
jq -r 'select(.event.type=="status" or .event.type=="idle" or .event.type=="error") | [.timestamp, .event.type, (.event.status.state // ""), (.event.error.name // "")] | @tsv' ./tmp/session-events.jsonl

# exported agent events: parts only
jq -r 'select(.event.type=="part")' ./tmp/session-events.jsonl
```

## heap snapshots and memory debugging

roadie has a built-in heap monitor (`cli/src/heap-monitor.ts`) that runs every 30s and checks V8 heap usage. At **85% heap used** it writes a `.heapsnapshot` file to `~/.roadie/heap-snapshots/`. There is a 5 minute cooldown between automatic snapshots to avoid disk spam.

To trigger a heap snapshot manually at any time:

```bash
kill -SIGUSR1 <PID>
```

Snapshots are saved as `heap-<date>-<sizeMB>MB.heapsnapshot` in `~/.roadie/heap-snapshots/`. Open them in Chrome DevTools (Memory tab > Load) to inspect what is holding memory.

Signal summary:

- `SIGUSR1`: write heap snapshot to disk
- `SIGUSR2`: graceful restart (only when the user asks)

## live CPU profiling

To capture a CPU profile from a **running** roadie bot without restarting, type this in the same terminal and press Enter:

```
cpuprof
```

Type `cpuprof` again to stop, or wait **20 seconds** for auto-stop. The profile is written to `<dataDir>/cpu-profiles/cpu-<date>.cpuprofile` (default `~/.roadie/cpu-profiles/`). Open it in Chrome DevTools (Performance tab > Load) or:

```bash
bunx profano ~/.roadie/cpu-profiles/cpu-*.cpuprofile
```

This uses `node:inspector` `Profiler.start` / `Profiler.stop` inside the bot process (`cli/src/cpu-profiler.ts`). It does not use SIGUSR1 (that stays heap snapshots). stdin must be a TTY; piped stdin is ignored.

## CPU profiling tests

Set `VITEST_CPU_PROF=1` to generate `.cpuprofile` files when running vitest. Profiles land in `cli/tmp/cpu-profiles/`. Always run a single test file to avoid hanging the machine; the config forces `maxForks: 1` when profiling.

```bash
cd cli
VITEST_CPU_PROF=1 pnpm run test --run src/some-file.e2e.test.ts

# top-down self-time report in the terminal
bunx profano tmp/cpu-profiles/CPU.*.cpuprofile

# interactive flame chart in the browser
npx cpupro tmp/cpu-profiles/CPU.*.cpuprofile
```
