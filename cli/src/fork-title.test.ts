import { expect, test } from 'vitest'
import { normalizeGeneratedForkTitle } from './fork-title.js'

test('generated fork titles normalize model output and bound Unicode without splitting surrogate pairs', () => {
  expect(normalizeGeneratedForkTitle('  Investigate cache\n\tmisses  ')).toBe('Investigate cache misses')
  expect(normalizeGeneratedForkTitle('   ')).toBeNull()
  const title = normalizeGeneratedForkTitle('🧑'.repeat(120))!
  expect(Array.from(title)).toHaveLength(100)
  expect(title).toBe('🧑'.repeat(99) + '…')
})
