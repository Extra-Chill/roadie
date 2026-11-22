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
