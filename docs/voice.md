# Hands-free voice dispatcher

Roadie can route spoken requests to normal Discord coding threads. The voice
agent never codes: work and its replies remain in the thread, using the default
Pi backend (or the configured AgentBackend).

## Setup

1. Provide a Gemini Live API key using `ROADIE_GEMINI_API_KEY`, or preferably
   `ROADIE_GEMINI_API_KEY_FILE` pointing to a service-readable secret file. Keys
   are never written to the database. The default model is
   `gemini-3.1-flash-live-preview`; your Google account must have Live access.
2. Enable one guild voice channel in the existing channels config:

   ```yaml
   channels:
     "VOICE_CHANNEL_ID":
       voice: true
       who: ["user:YOUR_DISCORD_ID"]
     "PROJECT_TEXT_CHANNEL_ID":
       directory: /absolute/project/path
       respond: always
       who: ["user:YOUR_DISCORD_ID"]
   ```

3. Give the bot View Channel, Connect and Speak on the voice channel, and its
   normal thread/message permissions on project text channels. Speakers need
   the normal Roadie role/identity capability and channel audience access.
   Do not set `voice: true` on a wildcard policy.
4. Join the configured voice channel from your phone. Roadie joins for the
   first authorized speaker. Leaving or moving channels ends the session and
   releases the connection, audio streams and Live session. Other speakers are
   ignored. One dispatcher is active per guild. Rejoin to start again.

With no key, Roadie refuses to join and DMs the speaker an explanation. If DMs
are blocked, configure the key before retrying. Audio needs network access to
Discord voice and Gemini; Discord audio reception depends on the voice library
and the guild's voice encryption support. Speech is sent to Google, so use an
appropriately private channel and review your provider's data policy.

## Vocabulary

- “List my threads”: accessible active Roadie runtime threads, status and stable
  session-local indices (not indices that change when the list is reordered).
- “Switch to thread 2” / “switch to the homeboy one”: focus by index or unique
  label. Ambiguous names require clarification.
- “Tell it to …”: send through normal Discord intake, identity and queueing.
  A visible `🎙️ speaker: message` transcript remains in the thread. The bot
  authors that transcript; the runtime receives the authenticated human actor.
- “Start a new thread in roadie about …”: use an exact project text-channel
  name. Channel policy still controls whether new conversations are admitted.
- “What's the status?” / “read me the last reply”: short spoken text, omitting
  code fences, diff lines and links. Pending questions take precedence.
- “Stop that”: abort the focused running turn.
- “Answer …”: voice can cancel/reject requests or choose a narrowly allowlisted
  read-only question option. Permission grants, arbitrary confirmations, and
  destructive options (including merge, deploy, force-push and delete) are
  deferred: “queued for when you're parked”. This means deferred for manual
  review in Discord, not a scheduled approval or an automatic action queue.

Turn completions and pending question/permission transitions are announced
while connected. The dispatcher only observes threads accessible to the speaker.
Long code and diffs are not read aloud. Recorded voice-message transcription
is not part of this feature.

## Provider seam and evidence

`VoiceProvider` separates Live audio/tool calls from the thread dispatcher. A
future OpenAI Realtime provider can implement that interface without changing
thread routing. There is no backend-specific client in the voice layer.

The Discord conversation-intake twin scenario includes a deterministic tool-call
driver replacing Live inference: it focuses a real thread, sends speech text
through the real intake and Pi runtime, observes the attributed transcript and
reply, reads status, refuses a destructive approval, and aborts. Unit tests cover
stable indices and PCM conversion. No live microphone/Discord voice run is
claimed by this automated evidence; test device audio in your guild before use.
