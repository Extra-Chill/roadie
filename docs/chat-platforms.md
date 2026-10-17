# Pluggable chat platforms

Roadie's chat surfaces go through one registry (#297). Discord and Slack are
built-in registrations; a host can add its own platform from a plugin, and one
process can run several platforms at once against the same data dir.

## Selecting platforms

`--platform` / `ROADIE_PLATFORM` accepts one or more registered ids,
repeatable or comma-separated. No value means `discord`, as before.

```sh
roadie --platform slack                      # unchanged
roadie --platform discord --platform slack   # both in one process
ROADIE_PLATFORM=discord,host-chat roadie     # built-in + plugin platform
```

Unknown ids stop startup with the list of registered platforms. The running
set is exported back into `ROADIE_PLATFORM` for tool shells and `roadie send`,
and reported by the lock-port `/health` endpoint (`chatPlatforms`).

## What is shared, what is per-platform

Shared services start once per process: the in-process Hrana server (which is
also the single-instance lock port), the SQLite database, the agent backend,
sessions and their queue, the scheduler, credential pools, identity and
`roadie send`.

Each platform owns only its ingress and its `ChatThread` implementation:

- how a new message, interaction answer or abort arrives,
- how text parts, notices, files and interactive elements are rendered,
- its thread id namespace. Platforms that coexist with others must namespace
  thread ids (Slack uses `slack:<workspace>:<channel>:<ts>`) so shared tables
  never collide; plain Discord snowflakes stay valid.

Identity is platform-tagged, not platform-specific: the `person` filter and
turn attribution see `actor.platform` set to the platform's registered id.

## Registering a platform from a plugin

A plugin registers a platform in `register(roadie)` — the same path Discord
and Slack use internally:

```js
export function register(roadie) {
  roadie.registerChatPlatform({
    // Lowercase letters, digits, dashes. Used for --platform,
    // actor.platform, thread id namespacing and /health.
    id: 'host-chat',
    // Shared services (lock port, database, agent backend, hooks) are
    // already up when start() runs. Return an Error to stop startup,
    // or a handle whose stop() disconnects the ingress.
    async start(context) {
      const server = await connectHostIngress(context.options)
      return { stop: () => server.close() }
    },
  })
}
```

Duplicate or invalid ids fail plugin load, so a plugin can never silently
shadow a built-in platform.

Inside `start()`, a platform wires its ingress to the shared runtime:

1. resolve policy and admission with `resolveConversationIntake` /
   `recordConversationAdmission` (`src/conversation-intake.ts`),
2. get a runtime with `getOrCreateRuntime({ threadId, chat })`, where `chat`
   is its `ChatThread` (`src/chat-platform/types.ts`), and feed it with
   `runtime.enqueueIncoming(...)`,
3. register a parent resolver (`setChannelParentResolver(resolver, { key: id })`)
   so channel policy can walk its thread ids back to channel ids, and an IPC
   registration (`startIpcPolling({ resolveChatThread })`) if
   `roadie send` should reach its threads,
4. call `markChatPlatformReady(id, true)` once ingress is live.

`src/chat-platform/test-chat-platform.ts` is a complete in-memory reference
implementation; `src/chat-platform/platform-registry.e2e.test.ts` runs it
side by side with Discord in one process.

## Startup and shutdown order

`runChatPlatforms` starts the Hrana server and database once, then each
requested platform in the order given. All ids are validated first; if a
platform fails to start, the ones already running are stopped again and the
process exits without restart. On shutdown platforms stop newest-first before
the shared services tear down.
