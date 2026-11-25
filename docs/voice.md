# Hands-free voice orchestrator

Roadie can take spoken requests while you drive or walk. Voice is only a
bridge: speech goes into one **orchestrator thread**, a normal Roadie agent
session, and that thread's replies are read back to you.

```
you (voice) ⇄ Gemini Live (speech in/out only) ⇄ orchestrator thread ⇄ roadie send / roadie session * ⇄ coding threads
```

The orchestrator drives other threads with Roadie's existing CLI, exactly as it
would if you typed to it: `roadie send` to start or continue project threads,
and `roadie session list|read|wait|abort` to check on and stop them. Gemini
has one tool, `tell_orchestrator`, and makes no decisions of its own.

## Setup

1. Provide a Gemini Live API key with `ROADIE_GEMINI_API_KEY`, or preferably
   `ROADIE_GEMINI_API_KEY_FILE` pointing to a service-readable secret file.
   Keys are never written to the database. The model is `gemini-3.8-live`;
   your Google account needs Live access. Without a key Roadie refuses to join
   and DMs the speaker why.
2. Point a guild voice channel at the text channel that should hold the
   orchestrator threads, and give that text channel a project directory (the
   orchestrator's agent runs there). A ready-to-paste channels config:

   ```yaml
   channels:
     "VOICE_CHANNEL_ID":
       voice:
         channel: "ORCHESTRATOR_TEXT_CHANNEL_ID"
       who: ["user:YOUR_DISCORD_ID"]
     "ORCHESTRATOR_TEXT_CHANNEL_ID":
       directory: /absolute/path/to/a/workspace
       respond: mention
       who: ["user:YOUR_DISCORD_ID"]
       # Optional: a context id your host context provider (ROADIE_CONTEXT_PROVIDER)
       # can use to add your own orchestrator memory, project list or rules.
       context: voice-orchestrator
     "PROJECT_TEXT_CHANNEL_ID":
       directory: /absolute/project/path
       respond: always
       who: ["user:YOUR_DISCORD_ID"]
   ```

   Do not put `voice` on a wildcard policy.
3. Give the bot View Channel, Connect and Speak on the voice channel, and its
   normal thread and message permissions on the text channels.
4. Join the voice channel from your phone. Roadie joins for the first speaker
   who passes the normal checks (identity `sessions` capability, Roadie role
   and the voice channel's `who`), and leaves when they leave or move. One
   voice session runs per guild; other speakers are ignored.

## What happens in a session

- On join Roadie creates a thread named `🎙️ Voice — <local date time>` in the
  configured text channel. It is the orchestrator for this session and the
  durable log of the drive.
- Everything you ask is posted in that thread as `🎙️ **you:** your words` and
  enters Roadie's normal intake as you: identity, channel policy, queueing and
  attribution apply exactly as for a typed message. A speaker the text
  channel's policy does not admit is refused there. Speech never runs `!`
  shell commands.
- The orchestrator session gets voice-mode guidance pinned into its prompt
  through the host context mechanism (a `voice-orchestrator` context section):
  reply in one to three speakable sentences without code or diffs; dispatch
  work with `roadie send` and check it with `roadie session list/read/wait/abort`
  instead of coding itself; leave destructive actions (merge, deploy,
  force-push, delete, release) until you confirm in Discord. Your context
  provider can add to it with the channel's `context` id.
- When the orchestrator finishes a turn, its final reply is condensed (code,
  diff lines and links dropped) and read aloud. A question it asks is read
  aloud with its options; your spoken answer goes back as a new message, which
  cancels the pending question exactly as a typed message does.
- When any other Roadie thread you can access finishes a turn, you hear one
  line: the thread's channel and name plus the first sentence of its reply.
  Nothing is posted to the orchestrator thread, so it never starts a turn.

## Example spoken session

> **You:** Ask the roadie project to fix the flaky queue test.
> **Gemini:** On it.
> *(thread: `🎙️ alice: Ask the roadie project to fix the flaky queue test.`; the orchestrator runs `roadie send --channel <roadie channel> --prompt '…'`)*
> **Gemini:** Orchestrator: I started a roadie thread on the flaky queue test and will check on it.
> *(later)* **Gemini:** roadie, fix flaky queue test: The test now waits for the footer before asserting.
> **You:** Great, have it open a PR.
> **Gemini:** On it. … Orchestrator: The PR is open; merging waits for your confirmation in Discord.

## Limits

- Speech is sent to Google. Use a private channel and review your provider's
  data policy.
- Audio needs network access to Discord voice and Gemini; receiving Discord
  audio depends on the voice library and the guild's voice encryption support.
- Anything risky stays in Discord: the orchestrator is told to wait for your
  confirmation there, and permission prompts are answered in Discord.
- Recorded voice-message transcription is a separate feature.

## Provider seam and tests

`VoiceProvider` (`cli/src/voice-provider.ts`) separates Live audio and the one
`tell_orchestrator` tool from the bridge (`cli/src/voice-bridge.ts`), so a
different realtime provider can replace Gemini without touching Roadie's
intake. The Discord-twin e2e (`voice-orchestrator.discord.e2e.test.ts`) uses a
deterministic provider with a real Pi runtime and the scripted model server.
It checks the orchestrator thread, attributed intake, refusal of an unadmitted
speaker, the spoken reply and spoken-only announcements from other threads. No
live microphone run is claimed by this evidence; try it in your guild first.
