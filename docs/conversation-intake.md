# Conversation intake

Admission and response are separate decisions. A person may be eligible in a
channel without every message starting agent work. The same policy and host
filter are used by Discord and native Slack:

```yaml
projects:
  shared-workspace:
    directory: /srv/workspace
    context: shared-brain
    intake:
      start: mention
      continue: participants
      join: mention
      other: context
channels:
  CHANNEL_ONE:
    project: shared-workspace
    respond: mention
    who: everyone
  CHANNEL_TWO:
    project: shared-workspace
    respond: mention
    who: everyone
    intake:
      other: ignore
```

Multiple channels share a workspace/context, while each conversation has its
own durable admission. Individual intake fields inherit and override through
the existing project/channel/category/default policy lookup.

| Field | Values | Meaning |
| --- | --- | --- |
| `start` | `message`, `mention`, `command` | Start from any eligible message, explicit direction to the agent, or a command. |
| `continue` | `starter`, `participants`, `eligible` | Who can continue without another explicit direction to the agent. |
| `join` | `mention`, `message`, `never` | Admit another eligible actor through explicit direction, any message, or never. |
| `other` | `context`, `ignore` | Record other eligible messages as data in an existing session, or ignore them. |

Explicit commands and native interactions are directed to the agent, so they
can satisfy mention-style start/join rules. `command`-only initiation still
requires a command. User-to-user messages take the `other` path unless they
also explicitly address the agent.

The default continuation is `eligible`, join is `mention`, and other is
`ignore`. Start defaults to the channel's existing response rule. Without an
`intake` object, existing adapter behavior is preserved. `respond: never`,
channel audience/capability restrictions and identity/platform access checks
remain bounds; intake cannot grant eligibility.

`threads: existing-only` prevents physical thread creation, including a relayed
Slack root whose `thread_ts` equals its own timestamp. It can still start an
agent conversation inside an already existing platform thread when allowed.

## Durable admission

Roadie records platform + workspace/server + thread scope. The authenticated
start event establishes the starter. Explicitly admitted participants can
continue after process/backend restart. Admission does not become a WordPress
user, tool permission, credential binding, approval owner, or asynchronous job
owner; those remain host/backend contracts.

Local CLI user assertions and automation do not establish authenticated
starters or participants. Existing conversations without recorded admission
can explicitly admit eligible participants through their configured join rule;
Roadie does not infer a trusted starter from display names or model text.

## Host filter

```js
export function register(roadie) {
  roadie.addFilter('conversation_intake', (decision, { request, admission, policy }) => {
    // Actor/person attribution is supplied by the adapter/host, and text is
    // message data. Return a response/admission decision for eligible actors.
    if (request.text.startsWith('FYI:')) return { outcome: 'context', admit: false }
    return decision
  })
}
```

The typed request carries actor, optional host person ID, platform space,
channel/thread/message identifiers, text, new-conversation/thread status,
existing-session status, mentions, command intent, direction and eligibility.
The context also contains the effective policy and durable starter/participants.

Outcomes are `respond`, `context`, and `ignore`. A context outcome cannot
establish a session or admit a participant. The filter cannot override failed
eligibility, a disabled channel or a physical thread-creation restriction.

## Context-only semantics

Context-only messages are recorded through the existing backend's `noReply`
operation, with speaker attribution and attachments. They do not invoke named
commands, start an agent loop, change the active execution actor or preferences,
load personal context, dismiss interactive prompts, or cancel a planned wake.
The next response-producing turn can see that data in conversation history.
Shared history remains shared; intake is not a private-context boundary.

## Verification

The same scenario runs through both native adapters, their digital twins and
the real OpenCode deterministic backend: unmentioned root ignored, mention
starts, starter replies naturally, eligible non-participant messages are
context-only, outside-audience messages are excluded, another actor joins,
speaker context switches, admission/session identity survive restart, and the
starter returns. SQLite tests also verify space isolation and rejection of
CLI assertions. Context-only tests retain the active actor/model and planned
wake, and record command-shaped text without executing it.
