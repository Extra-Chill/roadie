# Discord voice messages

Post a mobile voice note (or an audio attachment) in a Roadie conversation. Roadie posts a quoted transcript attributed to the speaker, then processes it as a normal message with the same identity, queue and permissions. This works for new threads and replies; it does not join voice channels.

## Setup

Roadie sends Discord's OGG/Opus and M4A recordings to the provider as-is; no local audio tooling is needed. Notes are limited to 25 MiB.

Configure the bot process environment:

| Setting | Values / default |
| --- | --- |
| `ROADIE_VOICE_PROVIDER` | `openai` (default) or `gemini` |
| `ROADIE_OPENAI_API_KEY` | OpenAI API key, for OpenAI transcription |
| `ROADIE_GEMINI_API_KEY` | Google Gemini API key, for Gemini transcription |
| `ROADIE_VOICE_MODEL` | Optional provider model override; defaults to `gpt-4o-mini-transcribe` or `gemini-3.5-flash-lite` |

Keys use Roadie's secret handling: instead of a direct value, set `ROADIE_OPENAI_API_KEY_FILE` or `ROADIE_GEMINI_API_KEY_FILE` to a readable secret file. Direct values take precedence. These are transcription credentials, independent of the agent's model account.

Audio and a bounded vocabulary hint (the project's directory/repository name and the last 20 thread messages, up to 8,000 characters, including recent file/function names) are sent to the chosen provider. The hint instructs the model not to copy context as speech. Consider the provider's data policy before enabling this in sensitive projects.

Missing keys, unreadable secrets, empty speech and provider/download failures produce a short thread notice instead of an agent turn. Transcription and download requests have timeouts. Multiple successful audio attachments become one prompt; failures receive notices, and the cause is written to the bot log. To retry, resend the note or type the request.
