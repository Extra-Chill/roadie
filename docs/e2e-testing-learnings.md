---
title: E2E Testing Learnings
description: >
  Hard-won lessons from writing and debugging roadie's Discord e2e tests.
  Covers caching behavior, flaky test patterns, timeouts, polling strategies,
  and the CachedOpencodeProviderProxy.
prompt: |
  Document testing learnings from the thread-message-queue e2e test debugging
  sessions. Covers: proxy caching behavior (cache hits vs misses),
  streamChunkDelayMs only affecting cache hits, why tests should be run
  twice on failure, content-aware polling vs count-based polling, and
  timeout guidelines. Based on @cli/src/thread-message-queue.e2e.test.ts
  and the debugging sessions that led to the fixes in commit 64a1f59.
---

# E2E Testing Learnings

> E2E suites now run real `pi` processes against the scripted fake model
> server (`cli/src/pi-test-backend.ts`); there is no provider cache. The
> caching section below describes the retired OpenCode harness and is kept
> for history.

## CachedOpencodeProviderProxy and caching

Tests use `CachedOpencodeProviderProxy` which sits between the bot and
the real AI provider (Gemini). It caches request/response pairs in a local
SQLite DB (`provider-cache.db`).

**First run = all cache misses.** Responses stream at upstream provider
speed. On subsequent runs, identical requests hit the cache and stream
from the local DB instead.

This means test behavior can differ between first and second runs:

- **First run**: slower, real provider latency, `streamChunkDelayMs` has
  no effect (it only applies to cache hits)
- **Second run**: faster, cached responses, `streamChunkDelayMs` controls
  how fast cached chunks are replayed

**Always run a failing e2e test at least twice before investigating.**
The first run populates the cache. The second run exercises the cached
path which is the steady-state behavior. Many flaky tests only reproduce
on cache misses (first run) or only on cache hits (second run). Running
twice covers both paths.

## streamChunkDelayMs only affects cache hits

`proxy.setStreamChunkDelayMs(500)` makes cached responses stream slowly
(500ms between chunks). This is used to keep a session "busy" so we can
test interrupts. But on the first run with an empty cache, this setting
does nothing — the response streams at whatever speed the upstream
provider delivers.

Design tests so the core assertion holds regardless of cache state.
For interrupt tests, send the interrupt message quickly (e.g. 200ms
after the message being interrupted) so it fires while the session is
still processing regardless of how fast the response streams.

## Content-aware polling over count-based polling

**Bad pattern**: `waitForBotMessageCount(count: N)` — waits until there
are N bot messages total. This is fragile because:

- Error messages from interrupted/aborted sessions count as bot messages
- The count can be satisfied before the actual expected response arrives
- You end up asserting on the wrong messages

**Good pattern**: poll until a specific user message has a bot reply
after it in message order:

```ts
while (Date.now() - start < timeout) {
  const messages = await discord.thread(threadId).getMessages()
  const userMsgIdx = messages.findIndex((m) => {
    return m.author.id === userId && m.content.includes('foxtrot')
  })
  const hasBotReply =
    userMsgIdx >= 0 &&
    messages.some((m, i) => {
      return i > userMsgIdx && m.author.id === discord.botUserId
    })
  if (hasBotReply) break
  await new Promise((r) => setTimeout(r, 500))
}
```

This checks the actual condition you care about: "did the bot reply to
this specific message?" rather than "are there enough bot messages?"

`waitForBotMessageCount` is still fine for simple sequential tests where
there is no interruption or abort involved.

## Timeout guidelines

- **Individual test timeout**: 360_000 (6 minutes). LLM responses +
  agent startup can be slow. Never go below
  120s for e2e tests that involve LLM calls.
- **Polling timeouts**: 120_000 (2 minutes) for waiting on bot replies.
  This covers cold agent starts.
- **beforeAll timeout**: 60_000 (1 minute) for test setup (starting
  proxy, discord-digital-twin, hrana server, bot client).
- **Never use short timeouts** (5-10s) in e2e tests. Even cached
  responses take time due to Discord message routing, agent session
  creation, and tool execution.

## Messages to a busy session

Roadie no longer interrupts a busy session (#83). A message sent during a run
reaches the agent, which takes it at the next step boundary; only `/abort`
stops a run. `busy-thread-boundary-delivery.e2e.test.ts` covers this: a
message sent during a slow bash tool must not produce a `MessageAbortedError`
in the session event log, and the step after the tool must already answer it.

Rapid messages to a busy session share one run, so wait for that run's footer
before snapshotting the thread; the final text part is still quoted until the
run completes.

## Bot replies can be error messages

Bot replies are not always LLM content. They can be error messages like
a session error ("Not Found") if the session fails or the provider
returns an error. Tests should verify ordering by message position, not
by content matching (unless the test specifically asks for exact content
like "Reply with exactly: foxtrot").

## Logger noise in tests

Test logs are suppressed by default (`ROADIE_VITEST=1` in vitest.config.ts).
To debug a failing test, rerun with `ROADIE_TEST_LOGS=1` to see all
roadie logger output in the terminal:

```bash
ROADIE_TEST_LOGS=1 pnpm test --run src/thread-message-queue.e2e.test.ts
```

File logging to `<dataDir>/roadie.log` still works regardless of this flag.
