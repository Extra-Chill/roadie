---
title: Debugging and profiling roadie
description: >
  Recipes for debugging the roadie bot: the log file, OpenCode session event
  JSONL (env vars, sqlite export, compacted buffer shape, jq queries), heap
  snapshots, live CPU profiling, CPU profiling tests, and the
  ~/.roadie/bin/roadie command shim. Read when debugging session state, event
  ordering, memory, CPU, slow tests, or agents failing to run `roadie` commands.
---

# Debugging and profiling roadie

| Symptom                                        | Start with                                  |
| ---------------------------------------------- | ------------------------------------------- |
| bot error, session not responding              | `<dataDir>/roadie.log`                      |
| wrong footer, stuck typing, ordering bug       | session event JSONL + jq                    |
| memory growth                                  | heap snapshot (`kill -SIGUSR1 <PID>`)       |
| high CPU in the running bot                    | `cpuprof` in the bot terminal               |
| slow test file                                 | `VITEST_CPU_PROF=1`                         |
| agent cannot run `roadie send` from bash       | command shim in `~/.roadie/bin`             |

## logs

roadie writes logs to `<dataDir>/roadie.log` (default `~/.roadie/roadie.log`). The log file is reset on every bot startup, so it only contains logs from the current run. File logging works in all environments (dev and production), also under vitest when terminal logs are suppressed.

## session event JSONL

To debug OpenCode event ordering, set `ROADIE_LOG_OPENCODE_SESSION_EVENTS=1`. This writes JSONL files under `<dataDir>/opencode-session-events/` (one file per session id, like `ses_xxx.jsonl`). Use `ROADIE_OPENCODE_SESSION_EVENTS_DIR` to override the output directory.

Example when running a test to debug events:

```bash
ROADIE_OPENCODE_SESSION_EVENTS_DIR=./tmp/roadie-test-3423 ROADIE_LOG_OPENCODE_SESSION_EVENTS=1 pnpm run test --run src/test-file.test.ts -t test-name
```

For live user-session debugging (without restarting with env vars), export the persisted session event buffer from sqlite:

```bash
roadie session export-events-jsonl --session <session_id> --out ./tmp/session-events.jsonl
```

Use this for session-state regressions (for example a footer appearing after abort). Copy the exported JSONL into `cli/src/session-handler/event-stream-fixtures/` and add or update `event-stream-state.test.ts` coverage for the pure derivation helpers.

### compacted buffer shape

`ThreadSessionRuntime` keeps the last 1000 OpenCode events in memory per thread (`eventBuffer`) for event-sourcing derivation and waiters. The buffer stores a compacted event shape to avoid memory spikes. It strips or truncates these large fields:

- `message.updated` user events: strip `info.system`, `info.summary`, `info.tools`
- `message.part.updated` text/reasoning/snapshot: truncate long text fields
- `message.part.updated` `step-start.snapshot`: truncate
- `message.part.updated` tool states: replace `state.input` with `{}`
- `message.part.updated` completed tool output: truncate `state.output`
- `message.part.updated` completed tool attachments: strip `state.attachments`
- `message.part.updated` pending `state.raw` and error `state.error`: truncate

Each JSONL line is intentionally minimal: `{ timestamp, threadId, projectDirectory, event }`.

### jq recipes

```bash
# list event type counts for one session file
jq -r '.event.type' ~/.roadie/opencode-session-events/ses_xxx.jsonl | sort | uniq -c

# show only session lifecycle events (status/idle/error)
jq -r 'select(.event.type=="session.status" or .event.type=="session.idle" or .event.type=="session.error") | [.timestamp, .event.type, (.event.properties.status.type // ""), (.event.properties.error.name // "")] | @tsv' ~/.roadie/opencode-session-events/ses_xxx.jsonl

# filter by a specific event type (example: message.part.updated)
jq -r 'select(.event.type=="message.part.updated")' ~/.roadie/opencode-session-events/ses_xxx.jsonl

# filter by event subtype (example: session.status idle)
jq -r 'select(.event.type=="session.status" and .event.properties.status.type=="idle")' ~/.roadie/opencode-session-events/ses_xxx.jsonl

# show timestamps + event types
jq -r '[.timestamp, .event.type] | @tsv' ~/.roadie/opencode-session-events/ses_xxx.jsonl
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

## roadie command shim (`~/.roadie/bin/roadie`)

`ensureRoadieCommandShim()` in `cli/src/opencode-command.ts` generates a shell script at `~/.roadie/bin/roadie` (or `roadie.cmd` on Windows) every time the bot starts. It captures `process.execPath`, `process.execArgv`, and `process.argv[1]` into an `exec` one-liner, so the shim always mirrors the current process.

The shim directory is prepended to `PATH` in the env passed to the OpenCode server process (`cli/src/opencode.ts`). This lets agent sessions run `roadie send`, `roadie upload-to-discord`, `roadie tunnel`, etc. as regular shell commands via the bash tool, however roadie was installed (npx, global install, local dev).

In local dev the shim contains tsx loader flags (`--require` / `--import`) because the bot was launched with tsx against the raw `.ts` entry point. In production (npm package) there are no tsx flags and the entry script is the compiled `bin.js`. The shim reflects how the current process was started; there is no special-casing.
