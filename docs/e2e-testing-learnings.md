---
title: E2E Testing Learnings
description: >
  Hard-won lessons from writing and debugging roadie's Discord e2e tests.
  Covers Pi's scripted model server, flaky test patterns, timeouts and polling.
---

# E2E Testing Learnings

E2E suites run real `pi` processes against the scripted fake model server
(`cli/src/pi-test-backend.ts`); there is no provider cache or external model
credential requirement. Use scripted tool calls to keep a turn busy rather
than relying on model latency. Rerun a failure to distinguish timing races
from a deterministic regression.

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
- **Never use short timeouts** (5-10s) in e2e tests. Even scripted
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
