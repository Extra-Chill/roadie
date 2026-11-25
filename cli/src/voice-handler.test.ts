import { expect, test } from 'vitest'
import { voiceInput, voiceOutput } from './voice-handler.js'

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
