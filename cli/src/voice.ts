// Provider-independent transcription boundary, also usable by live voice ingress.
import { getRoadieEnv, readRoadieSecret } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const voiceLogger = createLogger(LogPrefix.VOICE)

export type VoiceResult = { text: string; notice?: never } | { text?: never; notice: string }

export function isVoiceAttachment(attachment: { contentType: string | null; name: string }, voiceMessage = false): boolean {
  return voiceMessage || !!attachment.contentType?.startsWith('audio/') || /\.(ogg|m4a)$/i.test(attachment.name)
}

/** Audio as downloaded; both providers accept Discord's OGG/Opus and M4A natively. */
export type VoiceAudio = { data: Uint8Array; mimeType: string; filename: string }

// Gemini accepts a fixed set of audio MIME types; Discord labels M4A recordings as MP4.
const GEMINI_AUDIO_TYPES: Record<string, string> = { 'audio/mp4': 'audio/m4a', 'audio/x-m4a': 'audio/m4a' }

/**
 * Gemini transcription takes a term list rather than a prompt: the newest distinct
 * technical-looking words (paths, file names, identifiers) from the context.
 */
export function vocabularyFrom(context: string): string[] {
  const terms = new Set<string>()
  const words = context.split(/[^\w./@-]+/).flatMap((word) => [word, ...word.split('/')]).reverse()
  for (const word of words.map((w) => w.replace(/^[.@-]+|[.@-]+$/g, ''))) {
    if (word.length >= 3 && word.length <= 60 && !word.includes('/') && /[._-]|[a-z][A-Z]|[A-Za-z]\d/.test(word)) terms.add(word)
    if (terms.size === 100) break
  }
  return [...terms]
}

export async function transcribeAudio({ audio, context = '' }: { audio: () => Promise<VoiceAudio>; context?: string }): Promise<VoiceResult> {
  try {
    const provider = getRoadieEnv('ROADIE_VOICE_PROVIDER') || 'openai'
    if (provider !== 'openai' && provider !== 'gemini') return { notice: 'Voice transcription: ROADIE_VOICE_PROVIDER must be openai or gemini.' }
    const keyName = provider === 'openai' ? 'ROADIE_OPENAI_API_KEY' : 'ROADIE_GEMINI_API_KEY'
    const key = readRoadieSecret(keyName)
    if (!key) return { notice: `Voice transcription unavailable: configure ${keyName} (or ${keyName}_FILE).` }
    const { data, mimeType, filename } = await audio()
    const prompt = `Transcribe the audio exactly, without commentary. Prefer technical vocabulary, file paths, function names and CLI commands. The following is vocabulary context only; never copy it as speech:\n${context.slice(-8_000)}`
    let response: Response
    let text: string | undefined
    if (provider === 'openai') {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename)
      form.append('model', getRoadieEnv('ROADIE_VOICE_MODEL') || 'gpt-transcribe')
      form.append('prompt', prompt)
      response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`Transcription provider returned HTTP ${response.status}`)
      text = ((await response.json()) as { text?: string }).text
    } else {
      // Gemini's speech-to-text model is served by the Interactions API. Smart mode drops
      // filler words and applies spoken self-corrections, which suits dictated prompts.
      response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: getRoadieEnv('ROADIE_VOICE_MODEL') || 'gemini-3.5-transcribe',
          input: [{ type: 'audio', mime_type: GEMINI_AUDIO_TYPES[mimeType] || mimeType, data: Buffer.from(data).toString('base64') }],
          generation_config: { transcription_config: { mode: { type: 'smart' }, custom_vocabulary: vocabularyFrom(context) } },
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`Transcription provider returned HTTP ${response.status}`)
      const result = await response.json() as { steps?: { type?: string; content?: { text?: string }[] }[] }
      text = result.steps?.filter((step) => step.type === 'model_output').flatMap((step) => step.content || []).map((part) => part.text || '').join('')
    }
    text = text?.trim()
    return text ? { text } : { notice: 'Voice transcription returned no speech; please try again or type your message.' }
  } catch (error) {
    // Never echo provider bodies, credentials, or download URLs to Discord; keep the cause in the bot log.
    voiceLogger.warn(`Voice transcription failed: ${error instanceof Error ? error.message : String(error)}`)
    return { notice: 'Voice transcription failed; please try again or type your message.' }
  }
}
