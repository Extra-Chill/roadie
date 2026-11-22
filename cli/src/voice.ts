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
    if (provider === 'openai') {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename)
      form.append('model', getRoadieEnv('ROADIE_VOICE_MODEL') || 'gpt-4o-mini-transcribe')
      form.append('prompt', prompt)
      response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000),
      })
    } else {
      const model = getRoadieEnv('ROADIE_VOICE_MODEL') || 'gemini-2.5-flash'
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: Buffer.from(data).toString('base64') } }] }] }),
        signal: AbortSignal.timeout(60_000),
      })
    }
    if (!response.ok) throw new Error(`Transcription provider returned HTTP ${response.status}`)
    const result = await response.json() as { text?: string; candidates?: { content?: { parts?: { text?: string }[] } }[] }
    const text = (provider === 'openai' ? result.text : result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(''))?.trim()
    return text ? { text } : { notice: 'Voice transcription returned no speech; please try again or type your message.' }
  } catch (error) {
    // Never echo provider bodies, credentials, or download URLs to Discord; keep the cause in the bot log.
    voiceLogger.warn(`Voice transcription failed: ${error instanceof Error ? error.message : String(error)}`)
    return { notice: 'Voice transcription failed; please try again or type your message.' }
  }
}
