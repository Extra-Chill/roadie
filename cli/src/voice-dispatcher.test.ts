import { expect, test, vi } from 'vitest'
import { VoiceDispatcher, spokenText, type VoiceThreadHost } from './voice-dispatcher.js'
import { voiceInput, voiceOutput } from './voice-handler.js'

test('deterministic tool driver preserves indices, focus, ambiguity and intake errors', async () => {
  let threads = [
    { id: 'a', label: 'homeboy: fix', status: 'idle' },
    { id: 'b', label: 'roadie: voice', status: 'running' },
  ]
  const host: VoiceThreadHost = {
    list: async () => threads,
    send: vi.fn(async () => {}),
    start: vi.fn(async () => 'c'),
    read: async () => 'Done. ```ts\nsecret code\n```',
    abort: vi.fn(async () => {}),
    answer: async () => "Queued for when you're parked",
  }
  const driver = new VoiceDispatcher(host)
  await driver.call('list_threads', {})
  threads = [threads[1]!, threads[0]!]
  await driver.call('focus_thread', { thread: 'thread 2' })
  await driver.call('send_to_thread', { text: 'fix it' })
  expect(host.send).toHaveBeenCalledWith('b', 'fix it')
  await driver.call('focus_thread', { thread: 'homeboy' })
  expect(await driver.call('read_latest', {})).toBe('Done. Code omitted.')
  await driver.call('abort_thread', {})
  expect(host.abort).toHaveBeenCalledWith('a')
  expect(await driver.call('answer_pending', { option: 'deploy' })).toContain('parked')
  threads = []
  await expect(driver.call('send_to_thread', { text: 'stale' })).rejects.toThrow('accessible')
  expect(spokenText('+diff\nhello https://example.com')).toBe('hello link')
})

test('audio conversions preserve rate, channels and bounded frame size', () => {
  const input = Buffer.alloc(960 * 4)
  for (let i = 0; i < input.length; i += 2) input.writeInt16LE(1200, i)
  const pcm = voiceInput(input)
  expect(pcm.length).toBe(320 * 2)
  expect(pcm.readInt16LE(0)).toBe(1200)
  const discord = voiceOutput(pcm)
  expect(discord.length).toBe(pcm.length * 4)
  expect(discord.readInt16LE(6)).toBe(1200)
})
