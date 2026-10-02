import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { getRoadieEnv, resolveDefaultDataDir, withKimakiEnvAliases } from './config.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('legacy environment values work and explicit Roadie values win', () => {
  vi.stubEnv('KIMAKI_LOCK_PORT', '31001')
  expect(getRoadieEnv('ROADIE_LOCK_PORT')).toBe('31001')
  vi.stubEnv('ROADIE_LOCK_PORT', '31002')
  expect(getRoadieEnv('ROADIE_LOCK_PORT')).toBe('31002')
})

test('exports Roadie environment values under both names for child processes', () => {
  expect(withKimakiEnvAliases({
    ROADIE_SESSION_ID: 'ses_child',
    ROADIE_THREAD_ID: 'thread_child',
    ROADIE_CHILD: '1',
    KIMAKI_LOCK_PORT: '31001',
  })).toEqual({
    ROADIE_SESSION_ID: 'ses_child',
    KIMAKI_SESSION_ID: 'ses_child',
    ROADIE_THREAD_ID: 'thread_child',
    KIMAKI_THREAD_ID: 'thread_child',
    ROADIE_CHILD: '1',
    KIMAKI_CHILD: '1',
    KIMAKI_LOCK_PORT: '31001',
  })
})

test('uses an existing Kimaki data directory only when Roadie data is absent', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-home-'))
  const kimakiDir = path.join(homeDir, '.kimaki')
  fs.mkdirSync(kimakiDir)
  try {
    expect(resolveDefaultDataDir(homeDir)).toBe(kimakiDir)
    const roadieDir = path.join(homeDir, '.roadie')
    fs.mkdirSync(roadieDir)
    expect(resolveDefaultDataDir(homeDir)).toBe(roadieDir)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})
