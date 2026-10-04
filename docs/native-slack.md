# Native Slack and shared project context

Roadie's native Slack path talks directly to Slack's Events API, Web API and
Block Kit. It uses the same `ThreadSessionRuntime`, agent backend, local queue,
permission policy, host context hooks, IPC tools and task scheduler as Discord.
It does not run `discord-slack-bridge` or translate Slack into Discord IDs.
API calls use Slack's official Web API client, including its rate-limit and
transient-request handling.

## Channels bind to projects

A project is a workspace and optional opaque host context. Any number of
channels can bind to it; each channel keeps its own audience, response policy
and sessions. The same configuration works for Discord and Slack:

```yaml
projects:
  shared-site:
    directory: /srv/shared-site
    context: shared-site-agent
    agent: build
channels:
  CDEVELOPMENT:
    project: shared-site
    who: everyone
    respond: always
  COPERATIONS:
    project: shared-site
    who: ["person:operator"]
    respond: mention
  "*":
    respond: never
```

The host's `context_sections` filter receives `projectId`, `contextId`,
`channelId`, `threadId`, directory and the authenticated actor/person. The
external context command receives the same fields as `project_id`,
`context_id`, `channel_id`, `thread_id` and `directory`. Roadie treats context
identifiers as opaque; the host decides what they mean.

Channel fields override project defaults. Existing directory-based channel
configuration continues to work. `roadie project add` and `/add-project` can
create multiple Discord channels for the same directory. When a project has
multiple bindings, `roadie send --project` asks for an explicit `--channel` or
`--thread` rather than selecting an arbitrary channel.

## Run Slack

Configure these environment variables (secret variables also accept `_FILE`):

| Variable | Purpose |
| --- | --- |
| `ROADIE_PLATFORM=slack` | Select native Slack; alternatively use `--platform slack`. |
| `ROADIE_SLACK_BOT_TOKEN` | Slack bot token. |
| `ROADIE_SLACK_SIGNING_SECRET` | Authenticate Slack or host-re-signed deliveries. |
| `ROADIE_SLACK_WORKSPACE_ID` | Optional expected workspace; startup verifies it against `auth.test`. |
| `ROADIE_SLACK_PORT` | Loopback HTTP receiver port, default `4000`. |
| `ROADIE_CHANNELS_CONFIG` | Channel/project configuration file. |
| `ROADIE_SERVICE_TOKEN` | Authorizes native CLI sends and uploads through the running bot. |

```sh
roadie --platform slack --channels-config /etc/roadie/channels.yaml
```

The Slack receiver binds to `127.0.0.1`. A host or HTTPS reverse proxy forwards:

- Events API: `POST /slack/events`
- Interactivity: `POST /slack/interactions`
- The `/roadie` slash command: `POST /slack/commands`

Subscribe to `message.channels`, `message.groups` as needed, and `app_mention`.
Invite the bot to configured channels. Required scopes include `chat:write`,
`channels:read`, `channels:history`, `groups:read`/`groups:history` for private
channels, `users:read`, `app_mentions:read`, `commands`, `files:read`, and
`files:write`. Slack's thread-history token/scope eligibility must be verified
for the installed app when using `conversations.replies`.

The receiver verifies the original bytes and five-minute timestamp window,
checks workspace identity, and persists accepted events before acknowledging
them. Platform retries and host redelivery deduplicate by workspace, channel
and message timestamp. A host may durably receive events, wake its workload,
then re-sign and forward them to this same receiver. The receiver's signing
secret must match that host's re-signing secret.

Bot/signing credentials and their file paths are removed from the agent's
inherited environment. The agent's CLI uses the narrower service send token.
Other bots are ignored unless the host's identity layer explicitly vouches for
their authenticated Slack actor and grants session access.
The lock-port health endpoint reports `chatPlatform` and `chatReady` alongside
the existing Discord-specific readiness field.

## Sessions and interactions

A channel message becomes the root of a Slack thread and its Roadie session.
Replies continue that session. Root messages in `existing-only` channels are
ignored. End a message with `. queue` to use Roadie's persistent local queue.

Thread identifiers are native, namespaced strings:

```text
slack:WORKSPACE_ID:CHANNEL_ID:THREAD_TIMESTAMP
```

These identifiers are persisted as ordinary Roadie thread bindings, including
part/message mappings, queued turns, restart continuation and scheduled wakes.

Permission prompts use Block Kit Accept/Accept Always/Deny buttons. Questions
use single/multiple selects and a custom-answer modal. Multiple-choice questions
have a Submit answers button so the first selection cannot prematurely answer
the question. Action buttons continue the same session. File requests use a
native Slack `file_input` modal, authenticated downloads and local attachment
paths. Outbound files use Slack's external upload protocol.

`/roadie new <prompt>` creates a session. Session commands include `abort`,
`queue`, `model`, `agent`, `session`, and `fork`. An omitted thread target opens
a native session picker; model and agent commands open their own catalog pickers
when the value is omitted. An explicit thread timestamp also works:

```text
/roadie queue 1700000000.000001 Review the result
/roadie model 1700000000.000001
/roadie fork 1700000000.000001 Explore another approach
```

Project-defined backend commands can be invoked through `/roadie <command>`.

## CLI and automation

Native sends use the existing authenticated loopback `/roadie/send` endpoint.
Set the same data/lock-port configuration and `ROADIE_SERVICE_TOKEN` for the
caller. Credentials remain in the bot process:

```sh
roadie send --platform slack --channel CDEVELOPMENT --prompt 'Review this project'
roadie send --platform slack --thread slack:TWORKSPACE:CDEVELOPMENT:1700000000.000001 --prompt 'Continue'
roadie send --platform slack --session ses_example --notify-only --prompt 'Build finished'
roadie send --platform slack --channel CDEVELOPMENT --prompt 'Read this screenshot' --file screenshot.png
roadie upload-to-chat --session ses_example screenshot.png
roadie send --platform slack --thread slack:TWORKSPACE:CDEVELOPMENT:1700000000.000001 --prompt 'Follow up' --send-at '2026-12-01T09:00:00Z'
```

`upload-to-chat` follows `ROADIE_PLATFORM`; the old `upload-to-discord` name
remains an alias for compatibility. CLI-asserted users are marked `via: cli` and
are never promoted to a platform-authenticated host person.

Scheduling and `roadie_sleep` use the shared claim/retry/concurrency scheduler
through native delivery callbacks. Wake events enter the durable inbox and are
consumed only when the same session accepts the wake. A human message or queued
turn supersedes a pending sleep.

## Native differences and remaining parity work

- Slack threads have no editable title. The adapter advertises `rename: false`.
- Slack has no general bot typing indicator. It advertises `typing: false`;
  assistant-status API integration is separate work.
- Silent output makes explicit mentions inert and disables unfurls. Slack
  controls ordinary unread/thread notifications.
- Slack slash commands lack a thread timestamp, so session selection is explicit
  or uses a modal instead of guessing the most recent session.
- Native credential-login dialogs, the remaining Discord-only
  command UIs, HTML-action rendering, and complete cross-platform scenario
  parameterization remain tracked by #14. Configure backend credentials through
  the agent backend's own CLI until native login UI parity is complete.
- Native `--pre-run` automation is not exposed through the send endpoint.
  Host-owned shell execution remains available through the shared scheduler.
- Live Slack installation, production token/scope eligibility, real modal timing,
  and hosted pause/snapshot/replacement acceptance still require a live proof.

The Discord-emulation packages remain available for existing deployments until
native parity and that live acceptance are complete. Selecting Slack never loads
their runtime.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm run generate
pnpm --dir cli exec tsc --noEmit
pnpm --dir cli run test --run src/slack-native.e2e.test.ts src/slack-signature.test.ts
pnpm --dir cli run test --run
```

Native scenarios run a Slack digital twin, signed real HTTP deliveries, the
shared Roadie runtime, and the real OpenCode deterministic provider. They verify
visible responses, stable session identity after restart, shared host context,
speaker attribution in an actual guarded shell, Block Kit replies, actual file
bytes and scheduled delivery. The twin's file routes retain uploaded bytes;
they are not success-only upload stubs.
