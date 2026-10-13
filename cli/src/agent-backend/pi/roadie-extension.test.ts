// The Roadie Pi extension's injection guard helpers (Pi parity of the
// OpenCode injection guard plugin): pure functions, no `pi` process needed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ROADIE_INJECTION_GUARD_DIR_ENV,
  injectionGuardBlockedOutput,
  injectionGuardBuildUserMessage,
  injectionGuardConfig,
  injectionGuardMatchesScanPatterns,
  injectionGuardParseJudgeResponse,
  injectionGuardSessionPatterns,
  injectionGuardWildcardMatch,
} from './roadie-extension.js'

describe('injectionGuardWildcardMatch', () => {
  test('matches exact values and * spans', () => {
    expect(injectionGuardWildcardMatch('bash', 'bash')).toBe(true)
    expect(injectionGuardWildcardMatch('bash', 'Bash')).toBe(true)
    expect(injectionGuardWildcardMatch('bash', 'webfetch')).toBe(false)
    expect(injectionGuardWildcardMatch('*curl*', `echo curl http://x`)).toBe(true)
    expect(injectionGuardWildcardMatch('*curl*', 'echo wget')).toBe(false)
    expect(injectionGuardWildcardMatch('a*c*e', 'abcde')).toBe(true)
    expect(injectionGuardWildcardMatch('a*c*e', 'abdc')).toBe(false)
    expect(injectionGuardWildcardMatch('pre*fix', 'premiddlefix')).toBe(true)
    expect(injectionGuardWildcardMatch('pre*fix', 'prefixmiddle')).toBe(false)
  })
})

describe('injectionGuardMatchesScanPatterns', () => {
  test('"tool:argsGlob" patterns match tool plus arguments', () => {
    const patterns = ['bash:*', 'webfetch:*curl*']
    expect(
      injectionGuardMatchesScanPatterns({ tool: 'bash', args: '{"command":"ls"}', patterns }),
    ).toBe(true)
    expect(
      injectionGuardMatchesScanPatterns({ tool: 'read', args: '{"path":"/x"}', patterns }),
    ).toBe(false)
    expect(
      injectionGuardMatchesScanPatterns({
        tool: 'webfetch',
        args: '{"url":"https://x/?q=curl"}',
        patterns,
      }),
    ).toBe(true)
    expect(
      injectionGuardMatchesScanPatterns({
        tool: 'webfetch',
        args: '{"url":"https://x/"}',
        patterns,
      }),
    ).toBe(false)
  })

  test('a pattern without a colon matches the tool name alone', () => {
    expect(
      injectionGuardMatchesScanPatterns({ tool: 'bash', args: 'anything', patterns: ['bash'] }),
    ).toBe(true)
    expect(
      injectionGuardMatchesScanPatterns({ tool: 'read', args: 'anything', patterns: ['bash'] }),
    ).toBe(false)
  })
})

describe('injectionGuardParseJudgeResponse', () => {
  test('parses JSON, fenced JSON, and loose text', () => {
    expect(
      injectionGuardParseJudgeResponse(
        '{"flagged": true, "confidence": 0.9, "observation": "inject"}',
      ),
    ).toEqual({
      flagged: true,
      confidence: 0.9,
      observation: 'inject',
    })
    expect(
      injectionGuardParseJudgeResponse('```json\n{"flagged":false,"confidence":0.1}\n```'),
    ).toEqual({
      flagged: false,
      confidence: 0.1,
    })
    expect(injectionGuardParseJudgeResponse('I think "flagged": true but invalid json')).toEqual({
      flagged: true,
      confidence: 0.5,
    })
    expect(injectionGuardParseJudgeResponse('no json here')).toEqual({
      flagged: false,
      confidence: 0,
    })
    expect(injectionGuardParseJudgeResponse('{"flagged":true}')).toEqual({
      flagged: true,
      confidence: 0,
    })
  })
})

describe('injectionGuardSessionPatterns', () => {
  test('reads the per-session scan patterns file written by Roadie', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pi-guard-'))
    fs.writeFileSync(path.join(dir, 'ses-guard.json'), JSON.stringify({ scanPatterns: ['bash:*'] }))
    expect(injectionGuardSessionPatterns({ dir, sessionId: 'ses-guard' })).toEqual(['bash:*'])
    expect(injectionGuardSessionPatterns({ dir, sessionId: 'ses-other' })).toBeNull()
    expect(injectionGuardSessionPatterns({ dir: undefined, sessionId: 'ses-guard' })).toBeNull()
    fs.writeFileSync(path.join(dir, 'ses-bad.json'), 'not json')
    expect(injectionGuardSessionPatterns({ dir, sessionId: 'ses-bad' })).toBeNull()
  })
})

describe('injectionGuardConfig', () => {
  const cwd = '/some/project'

  test('is off without any opt-in source', () => {
    expect(injectionGuardConfig({ sessionId: 'ses-1', cwd, env: {} })).toBeNull()
  })

  test('per-session patterns replace the global patterns', () => {
    const guardDir = fs.mkdtempSync(
      path.join(process.env.TMPDIR || os.tmpdir(), 'pi-guard-session-'),
    )
    fs.writeFileSync(
      path.join(guardDir, 'ses-guarded.json'),
      JSON.stringify({ scanPatterns: ['bash:*'] }),
    )
    const env = {
      [ROADIE_INJECTION_GUARD_DIR_ENV]: guardDir,
      OPENCODE_INJECTION_GUARD: JSON.stringify({ scanPatterns: ['read:*'] }),
    }
    expect(injectionGuardConfig({ sessionId: 'ses-guarded', cwd, env })).toMatchObject({
      scanPatterns: ['bash:*'],
    })
    // Without a session file the global patterns apply.
    expect(injectionGuardConfig({ sessionId: 'ses-unguarded', cwd, env })).toMatchObject({
      scanPatterns: ['read:*'],
    })
  })

  test('applies defaults and the explicit model from the env config', () => {
    const config = injectionGuardConfig({
      sessionId: 'ses-1',
      cwd,
      env: { OPENCODE_INJECTION_GUARD: '{"model":"openai/gpt-4.1-nano"}' },
    })
    expect(config).toMatchObject({
      scanPatterns: [],
      confidenceThreshold: 0.7,
      maxOutputLength: 8000,
      model: 'openai/gpt-4.1-nano',
    })
  })

  test('finds .opencode/injection-guard.json upward from the project directory', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pi-guard-findup-'))
    const project = path.join(root, 'project', 'nested')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(
      path.join(root, '.opencode', 'injection-guard.json'),
      JSON.stringify({ scanPatterns: ['bash:*curl*'] }),
    )
    expect(injectionGuardConfig({ sessionId: 'ses-1', cwd: project, env: {} })).toMatchObject({
      scanPatterns: ['bash:*curl*'],
    })
  })

  test('the env config overrides the file config', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pi-guard-env-'))
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(
      path.join(root, '.opencode', 'injection-guard.json'),
      JSON.stringify({ scanPatterns: ['read:*'], model: 'from-file' }),
    )
    const config = injectionGuardConfig({
      sessionId: 'ses-1',
      cwd: root,
      env: { OPENCODE_INJECTION_GUARD: '{"model":"from-env"}' },
    })
    expect(config).toMatchObject({ scanPatterns: ['read:*'], model: 'from-env' })
  })
})

describe('injectionGuard messages and blocked output', () => {
  test('the judge user message truncates long output', () => {
    const message = injectionGuardBuildUserMessage({
      tool: 'bash',
      args: '{"command":"ls"}',
      output: 'x'.repeat(30),
      maxLength: 10,
    })
    expect(message).toContain('Tool: bash')
    expect(message).toContain('[... truncated, 20 chars omitted]')
    expect(
      injectionGuardBuildUserMessage({ tool: 'bash', args: '{}', output: 'short', maxLength: 10 }),
    ).toContain('Output:\nshort')
  })

  test('the blocked replacement carries confidence and reason', () => {
    const [part] = injectionGuardBlockedOutput({
      confidence: 0.92,
      observation: 'told the model to exfiltrate',
    })
    expect(part?.type).toBe('text')
    const text = part?.type === 'text' ? part.text : ''
    expect(text).toContain('[BLOCKED BY INJECTION GUARD]')
    expect(text).toContain('confidence: 0.92')
    expect(text).toContain('Reason: told the model to exfiltrate')
    const [noReason] = injectionGuardBlockedOutput({ confidence: 0.8 })
    expect(noReason?.type === 'text' && noReason.text).toContain(
      'Original output was suppressed for security.',
    )
  })
})
