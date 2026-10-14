// The suite runs under a clean Roadie environment (#156): a run from an agent
// tool shell must not test the live session's ROADIE_* / OPENCODE_* / PI_* env.
import { describe, expect, test } from 'vitest'
import { clearAmbientRoadieEnv } from './test-env.js'

describe('clearAmbientRoadieEnv', () => {
  test('drops a live session env and keeps operator test inputs', () => {
    const env: NodeJS.ProcessEnv = {
      ROADIE: '1',
      ROADIE_SESSION_ID: 'ses_live',
      ROADIE_PROMPT_CONFIG: '{}',
      ROADIE_PI_KEY: 'live-key',
      OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
      PI_SESSION_ID: 'live',
      ROADIE_REQUIRE_PI: '1',
      ROADIE_PI_BIN: '/usr/bin/pi',
      ROADIE_PI_REAL_ROTATION: 'subagent',
      ROADIE_VITEST: '1',
      PATH: '/usr/bin',
      ROADIEX: 'unrelated',
    }
    clearAmbientRoadieEnv(env)
    expect(env).toEqual({ ROADIE_REQUIRE_PI: '1', ROADIE_PI_BIN: '/usr/bin/pi', ROADIE_PI_REAL_ROTATION: 'subagent', ROADIE_VITEST: '1', PATH: '/usr/bin', ROADIEX: 'unrelated' })
  })

  test('a test worker inherits the cleaned environment', () => {
    expect(process.env['ROADIE_SESSION_ID']).toBeUndefined()
    expect(process.env['ROADIE_PI_KEY']).toBeUndefined()
  })
})
