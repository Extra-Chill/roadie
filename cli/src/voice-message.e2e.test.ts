import { afterEach, describe, expect, test, vi } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { waitForFooterMessage } from './test-utils.js'

const CHANNEL = '200000000000004620'

describe.skipIf(!findPi())('Discord voice messages', () => {
  const ctx = setupQueueAdvancedSuite({ channelId: CHANNEL, channelName: 'voice-e2e', dirName: 'voice-e2e', username: 'voice-tester' })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  test('transcribes a new-thread note and skips empty, missing-key and failed replies', async () => {
    vi.stubEnv('ROADIE_VOICE_PROVIDER', 'openai')
    vi.stubEnv('ROADIE_OPENAI_API_KEY', 'deterministic-test-key')
    vi.stubEnv('ROADIE_OPENAI_API_KEY_FILE', '')
    const originalFetch = globalThis.fetch
    let transcription = 'Reply with exactly: voice-note-ok'
    let status = 200
    let calls = 0
    // Small valid PCM WAV; the real download and provider request still run.
    const wav = Buffer.alloc(44 + 3200)
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(3200, 40)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'https://voice.invalid/note.ogg') return new Response(wav)
      if (String(input) === 'https://api.openai.com/v1/audio/transcriptions') {
        calls++
        expect((init?.body as FormData).get('prompt')).toContain('Project:')
        return new Response(JSON.stringify({ text: transcription }), { status })
      }
      return originalFetch(input, init)
    })
    const attachment = { id: '300000000000004620', filename: 'voice-message.ogg', size: wav.length, url: 'https://voice.invalid/note.ogg', proxy_url: 'https://voice.invalid/note.ogg', content_type: 'audio/ogg' }
    await ctx.discord.channel(CHANNEL).user(TEST_USER_ID).sendMessage({ content: '', attachments: [attachment] })
    const thread = await ctx.discord.channel(CHANNEL).waitForThread({ timeout: 10_000 })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })
    const messages = await ctx.discord.thread(thread.id).getMessages()
    expect(messages.some((m) => m.content?.includes(`Voice transcript — <@${TEST_USER_ID}>:\n> Reply with exactly: voice-note-ok`))).toBe(true)
    expect(ctx.modelServer.bodies.some((body) => body.includes('voice-note-ok'))).toBe(true)
    const initialTurns = ctx.modelServer.bodies.length
    for (const mode of ['empty', 'no-key', 'failure']) {
      transcription = ''
      status = mode === 'failure' ? 500 : 200
      vi.stubEnv('ROADIE_OPENAI_API_KEY', mode === 'no-key' ? '' : 'deterministic-test-key')
      await ctx.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: '', attachments: [attachment] })
      const expected = mode === 'empty' ? 'returned no speech' : mode === 'no-key' ? 'unavailable: configure' : 'transcription failed'
      await vi.waitFor(async () => {
        const replies = await ctx.discord.thread(thread.id).getMessages()
        expect(replies.some((m) => m.content?.includes(expected))).toBe(true)
      }, { timeout: 10_000 })
    }
    expect(calls).toBe(3)
    expect(ctx.modelServer.bodies).toHaveLength(initialTurns)
  }, 60_000)
})
