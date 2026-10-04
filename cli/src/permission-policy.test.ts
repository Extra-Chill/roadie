import { afterEach, describe, expect, test } from 'vitest'
import { addFilter, resetHooks } from './hooks.js'
import {
  buildSessionPermissions,
  evaluatePermission,
  matchesPermissionPattern,
  resolveSessionPermissionRules,
} from './permission-policy.js'

afterEach(() => resetHooks())

describe('matchesPermissionPattern', () => {
  test('globs, single characters and the bare-command form', () => {
    expect(matchesPermissionPattern({ value: 'git status', pattern: 'git *' })).toBe(true)
    expect(matchesPermissionPattern({ value: 'git', pattern: 'git *' })).toBe(true)
    expect(matchesPermissionPattern({ value: 'gitx', pattern: 'git *' })).toBe(false)
    expect(matchesPermissionPattern({ value: '/a/b.ts', pattern: '/a/*.ts' })).toBe(true)
    expect(matchesPermissionPattern({ value: 'ab', pattern: 'a?' })).toBe(true)
    expect(matchesPermissionPattern({ value: 'a.b', pattern: 'a.b' })).toBe(true)
    expect(matchesPermissionPattern({ value: 'axb', pattern: 'a.b' })).toBe(false)
  })
})

describe('evaluatePermission', () => {
  const rules = [
    { permission: 'bash', pattern: '*', action: 'ask' as const },
    { permission: 'bash', pattern: 'git *', action: 'allow' as const },
    { permission: 'bash', pattern: 'git push *', action: 'deny' as const },
    { permission: 'edit', pattern: '*', action: 'allow' as const },
  ]

  test('the last matching rule wins', () => {
    expect(evaluatePermission({ rules, permission: 'bash', targets: ['ls'] })).toBe('ask')
    expect(evaluatePermission({ rules, permission: 'bash', targets: ['git status'] })).toBe('allow')
    expect(evaluatePermission({ rules, permission: 'bash', targets: ['git push origin'] })).toBe('deny')
  })

  test('every target must pass: any deny wins, then any ask', () => {
    expect(evaluatePermission({ rules, permission: 'bash', targets: ['git status', 'git push x'] })).toBe('deny')
    expect(evaluatePermission({ rules, permission: 'bash', targets: ['git status', 'rm x'] })).toBe('ask')
  })

  test('no matching rule falls back', () => {
    expect(evaluatePermission({ rules, permission: 'webfetch', targets: ['https://x'] })).toBe('ask')
    expect(evaluatePermission({ rules, permission: 'webfetch', targets: [], fallback: 'allow' })).toBe('allow')
  })
})

describe('resolveSessionPermissionRules', () => {
  test('create: checkout isolation first, then requested rules', () => {
    const rules = resolveSessionPermissionRules({
      directory: '/work/feature',
      originalRepoDirectory: '/work/main',
      requested: ['bash:deny'],
      phase: 'create',
    })
    expect(rules).toEqual([
      ...buildSessionPermissions({ directory: '/work/feature', originalRepoDirectory: '/work/main' }),
      { permission: 'bash', pattern: '*', action: 'deny' },
    ])
    expect(evaluatePermission({ rules, permission: 'external_directory', targets: ['/work/main/x.ts'] })).toBe('deny')
  })

  test('update: only requested rules', () => {
    expect(resolveSessionPermissionRules({
      directory: '/work/feature',
      originalRepoDirectory: '/work/main',
      requested: ['edit:ask'],
      phase: 'update',
    })).toEqual([{ permission: 'edit', pattern: '*', action: 'ask' }])
  })

  test('plugins add rules through permission_rules, and they win', () => {
    addFilter('permission_rules', (rules, { phase }) => (
      phase === 'create' ? [...rules, { permission: 'bash', pattern: 'rm *', action: 'deny' as const }] : rules
    ))
    const rules = resolveSessionPermissionRules({ directory: '/p', requested: ['bash:allow'], phase: 'create' })
    expect(evaluatePermission({ rules, permission: 'bash', targets: ['rm -rf /'] })).toBe('deny')
    expect(evaluatePermission({ rules, permission: 'bash', targets: ['ls'] })).toBe('allow')
  })
})
