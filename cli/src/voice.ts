// Provider-independent transcription boundary, also usable by live voice ingress.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getRoadieEnv, readRoadieSecret } from './config.js'

export type VoiceResult = { text: string; notice?: never } | { text?: never; notice: string }

export function isVoiceAttachment(attachment: { contentType: string | null; name: string }, voiceMessage = false): boolean {
  return voiceMessage || !!attachment.contentType?.startsWith('audio/') || /\.(ogg|m4a)$/i.test(attachment.name)
}

/** Decode Discord's OGG/Opus (and M4A) to a format accepted by both providers. */
async function toWav(audio: Uint8Array): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roadie-voice-'))
  try {
    const input = path.join(dir, 'input')
    const output = path.join(dir, 'audio.wav')
    await fs.writeFile(input, audio)
    await promisify(execFile)('ffmpeg', ['-nostdin', '-y', '-i', input, '-ac', '1', '-ar', '16000', output], { timeout: 30_000 })
    return await fs.readFile(output)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

export async function transcribeAudio({ audio, context = '' }: { audio: () => Promise<Uint8Array>; context?: string }): Promise<VoiceResult> {
  try {
    const provider = getRoadieEnv('ROADIE_VOICE_PROVIDER') || 'openai'
    if (provider !== 'openai' && provider !== 'gemini') return { notice: 'Voice transcription: ROADIE_VOICE_PROVIDER must be openai or gemini.' }
    const keyName = provider === 'openai' ? 'ROADIE_OPENAI_API_KEY' : 'ROADIE_GEMINI_API_KEY'
    const key = readRoadieSecret(keyName)
    if (!key) return { notice: `Voice transcription unavailable: configure ${keyName} (or ${keyName}_FILE).` }
    const wav = await toWav(await audio())
    const prompt = `Transcribe the audio exactly, without commentary. Prefer technical vocabulary, file paths, function names and CLI commands. The following is vocabulary context only; never copy it as speech:\n${context.slice(-8_000)}`
    let response: Response
    if (provider === 'openai') {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', getRoadieEnv('ROADIE_VOICE_MODEL') || 'gpt-4o-mini-transcribe')
      form.append('prompt', prompt)
      response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000),
      })
    } else {
      const model = getRoadieEnv('ROADIE_VOICE_MODEL') || 'gemini-2.5-flash'
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] }] }),
        signal: AbortSignal.timeout(60_000),
      })
    }
    if (!response.ok) throw new Error('Transcription provider rejected request')
    const result = await response.json() as { text?: string; candidates?: { content?: { parts?: { text?: string }[] } }[] }
    const text = (provider === 'openai' ? result.text : result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(''))?.trim()
    return text ? { text } : { notice: 'Voice transcription returned no speech; please try again or type your message.' }
  } catch {
    // Never echo provider bodies, credentials, or download URLs to Discord.
    return { notice: 'Voice transcription failed; please try again or type your message.' }
  }
}
