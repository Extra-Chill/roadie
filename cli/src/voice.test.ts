import { afterEach, expect, test, vi } from 'vitest'
import { isVoiceAttachment, transcribeAudio } from './voice.js'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

test('detects voice flag, audio MIME and Discord filename fallbacks', () => {
  expect(isVoiceAttachment({ name: 'note', contentType: null }, true)).toBe(true)
  expect(isVoiceAttachment({ name: 'note', contentType: 'audio/webm' })).toBe(true)
  expect(isVoiceAttachment({ name: 'NOTE.M4A', contentType: null })).toBe(true)
  expect(isVoiceAttachment({ name: 'note.ogg', contentType: 'application/octet-stream' })).toBe(true)
  expect(isVoiceAttachment({ name: 'image.png', contentType: 'image/png' })).toBe(false)
})

test.each(['openai', 'gemini'])('missing %s credentials does not download audio', async (provider) => {
  vi.stubEnv('ROADIE_VOICE_PROVIDER', provider)
  for (const key of ['ROADIE_OPENAI_API_KEY', 'ROADIE_GEMINI_API_KEY']) {
    vi.stubEnv(key, '')
    vi.stubEnv(`${key}_FILE`, '')
  }
  const audio = vi.fn()
  expect((await transcribeAudio({ audio })).notice).toContain('unavailable: configure')
  expect(audio).not.toHaveBeenCalled()
})

test('download failure is safe and does not leak sensitive URLs', async () => {
  vi.stubEnv('ROADIE_VOICE_PROVIDER', 'openai')
  vi.stubEnv('ROADIE_OPENAI_API_KEY', 'secret')
  const result = await transcribeAudio({ audio: async () => { throw new Error('sensitive-url') } })
  expect(result.notice).toBe('Voice transcription failed; please try again or type your message.')
})


test('Gemini transcribes through the Interactions API with smart mode and thread vocabulary', async () => {
  vi.stubEnv('ROADIE_VOICE_PROVIDER', 'gemini')
  vi.stubEnv('ROADIE_GEMINI_API_KEY', 'test-key')
  let request: { url: string; body: any } | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    request = { url: String(input), body: JSON.parse(String(init?.body)) }
    return new Response(JSON.stringify({ steps: [
      { type: 'thought', content: [{ type: 'text', text: 'ignored' }] },
      { type: 'model_output', content: [{ type: 'text', text: ' run the voice-message tests ' }] },
    ] }))
  })
  const result = await transcribeAudio({
    context: 'Project: /work/roadie\nfix voice-message.e2e.test.ts in cli/src and call transcribeAudio, please',
    audio: async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: 'audio/mp4', filename: 'note.m4a' }),
  })
  expect(result).toEqual({ text: 'run the voice-message tests' })
  expect(request?.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
  expect(request?.body).toEqual({
    model: 'gemini-3.5-transcribe',
    input: [{ type: 'audio', mime_type: 'audio/m4a', data: 'AQID' }],
    generation_config: { transcription_config: {
      mode: { type: 'smart' },
      custom_vocabulary: ['transcribeAudio', 'voice-message.e2e.test.ts'],
    } },
  })
})
