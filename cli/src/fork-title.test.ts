import { expect, test } from 'vitest'
import { forkTaskTitle } from './fork-title.js'

test('fork titles normalize a new prompt and bound Unicode without splitting surrogate pairs', () => {
  expect(forkTaskTitle('  Investigate cache\n\tmisses  ')).toBe('Investigate cache misses')
  expect(forkTaskTitle('   ')).toBeNull()
  const title = forkTaskTitle('🧑'.repeat(120))!
  expect(Array.from(title)).toHaveLength(100)
  expect(title).toBe('🧑'.repeat(99) + '…')
})
