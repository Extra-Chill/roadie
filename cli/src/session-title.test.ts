import { expect, test } from 'vitest'
import { sessionTitlePrompt, normalizeGeneratedSessionTitle } from './session-title.js'

test('recovery and context turns cannot supply a fork task title', () => {
  const prompt = 'Roadie restarted while you were working on this'
  for (const turn of [
    { isRestartContinuation: true }, { isSleepWake: true },
    { noReply: true }, { contextOnly: true },
  ]) expect(sessionTitlePrompt({ prompt, ...turn })).toBeNull()
  // Actual task text is eligible regardless of what words it contains.
  expect(sessionTitlePrompt({ prompt })).toBe(prompt)
  expect(sessionTitlePrompt({ prompt: 'synthetic lineage', titlePrompt: 'actual task' })).toBe('actual task')
  expect(sessionTitlePrompt({ prompt: '', command: { name: 'plan', arguments: 'task' } })).toBe('/plan task')
})

test('generated fork titles normalize model output and bound Unicode without splitting surrogate pairs', () => {
  expect(normalizeGeneratedSessionTitle('  Investigate cache\n\tmisses  ')).toBe('Investigate cache misses')
  expect(normalizeGeneratedSessionTitle('   ')).toBeNull()
  const title = normalizeGeneratedSessionTitle('🧑'.repeat(120))!
  expect(Array.from(title)).toHaveLength(100)
  expect(title).toBe('🧑'.repeat(99) + '…')
})
