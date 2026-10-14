import { describe, test, expect } from 'vitest'
import { isSkillAllowed } from './skill-filter.js'

describe('isSkillAllowed', () => {
  test('no filters - all skills allowed', () => {
    expect(isSkillAllowed({ name: 'anything', enabledSkills: [], disabledSkills: [] })).toBe(true)
  })

  test('whitelist mode - listed skill is allowed', () => {
    expect(isSkillAllowed({ name: 'npm-package', enabledSkills: ['npm-package', 'errore'], disabledSkills: [] })).toBe(true)
  })

  test('whitelist mode - unlisted skill is denied', () => {
    expect(isSkillAllowed({ name: 'jitter', enabledSkills: ['npm-package', 'errore'], disabledSkills: [] })).toBe(false)
  })

  test('blacklist mode - listed skill is denied', () => {
    expect(isSkillAllowed({ name: 'jitter', enabledSkills: [], disabledSkills: ['jitter', 'termcast'] })).toBe(false)
  })

  test('blacklist mode - unlisted skill is allowed', () => {
    expect(isSkillAllowed({ name: 'npm-package', enabledSkills: [], disabledSkills: ['jitter', 'termcast'] })).toBe(true)
  })

  test('whitelist takes precedence when both are set', () => {
    expect(isSkillAllowed({ name: 'npm-package', enabledSkills: ['npm-package'], disabledSkills: ['npm-package'] })).toBe(true)
    expect(isSkillAllowed({ name: 'jitter', enabledSkills: ['npm-package'], disabledSkills: ['jitter'] })).toBe(false)
  })
})
