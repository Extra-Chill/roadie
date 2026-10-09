// Per-session agent tokens: mint/verify, secret persistence, and the
// shell.env contract (scrubbed credentials, session-bound token).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AGENT_TOKEN_ENV,
  AGENT_TOKEN_SECRET_ENV,
  applyAgentShellEnv,
  ensureAgentTokenSecret,
  mintAgentToken,
  SCRUBBED_SHELL_ENV_NAMES,
  verifyAgentToken,
} from './agent-token.js'
import { closeDb } from './db.js'
import { setDataDir } from './config.js'

const tempDirs: string[] = []
const previousEnv = Object.fromEntries(
  [AGENT_TOKEN_SECRET_ENV, 'ROADIE_DB_URL', 'ROADIE_DB_AUTH_TOKEN', 'ROADIE_DB_AUTH_TOKEN_FILE', 'ROADIE_SERVICE_TOKEN_FILE'].map((key) => [key, process.env[key]]),
)

afterEach(() => {
  delete process.env[AGENT_TOKEN_SECRET_ENV]
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env[AGENT_TOKEN_ENV]
})

function useTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-agent-token-'))
  tempDirs.push(dir)
  setDataDir(dir)
  return dir
}

describe('mintAgentToken / verifyAgentToken', () => {
  const secret = 'test-secret'

  test('a minted token verifies to its own session', () => {
    const token = mintAgentToken({ secret, sessionId: 'sesabc123' })
    expect(token).toBe('sesabc123.' + token.slice('sesabc123.'.length))
    expect(verifyAgentToken({ secret, token })).toEqual({ sessionId: 'sesabc123' })
  })

  test('a tampered MAC is rejected', () => {
    const token = mintAgentToken({ secret, sessionId: 'sesabc123' })
    const mac = token.slice(token.lastIndexOf('.') + 1)
    const flipped = (mac[0] === '0' ? '1' : '0') + mac.slice(1)
    expect(verifyAgentToken({ secret, token: `sesabc123.${flipped}` })).toBeNull()
  })

  test('a token minted under another secret is rejected', () => {
    const token = mintAgentToken({ secret, sessionId: 'sesabc123' })
    expect(verifyAgentToken({ secret: 'other-secret', token })).toBeNull()
  })

  test('malformed tokens are rejected', () => {
    expect(verifyAgentToken({ secret, token: 'no-separator' })).toBeNull()
    expect(verifyAgentToken({ secret, token: '.deadbeef' })).toBeNull()
    expect(verifyAgentToken({ secret, token: 'ses123.' })).toBeNull()
    expect(verifyAgentToken({ secret, token: 'ses123.short' })).toBeNull()
  })

  test('tokens are bound per session', () => {
    const token = mintAgentToken({ secret, sessionId: 'ses_a' })
    // Verification reports the bound session, so endpoints can reject
    // other-session tokens by comparing it to the addressed resource.
    expect(verifyAgentToken({ secret, token })).toEqual({ sessionId: 'ses_a' })
    expect(verifyAgentToken({ secret, token })).not.toEqual({ sessionId: 'ses_b' })
  })
})

describe('ensureAgentTokenSecret', () => {
  test('persists a private secret and reuses it across calls', () => {
    const dir = useTempDataDir()
    const secret = ensureAgentTokenSecret()
    expect(secret).toBeTruthy()
    const file = path.join(dir, 'secrets', 'agent-token-secret')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(ensureAgentTokenSecret()).toBe(secret)
    // A second process (the bot after restart) reads the same secret.
    const reread = fs.readFileSync(file, 'utf8').trim()
    expect(reread).toBe(secret)
  })

  test('prefers the shared env secret when set', () => {
    useTempDataDir()
    process.env[AGENT_TOKEN_SECRET_ENV] = 'from-env'
    expect(ensureAgentTokenSecret()).toBe('from-env')
  })

  test('tokens minted from the persisted secret still verify from the file alone', () => {
    const dir = useTempDataDir()
    const secret = ensureAgentTokenSecret()
    const token = mintAgentToken({ secret, sessionId: 'ses_live' })
    // The secrets file is the only state shared with a restarted bot process
    // or the OpenCode server process.
    const persisted = fs
      .readFileSync(path.join(dir, 'secrets', 'agent-token-secret'), 'utf8')
      .trim()
    expect(persisted).toBe(secret)
    expect(verifyAgentToken({ secret: persisted, token })).toEqual({ sessionId: 'ses_live' })
  })
})

describe('applyAgentShellEnv (shell.env contract)', () => {
  const secret = 'shell-secret'

  test('a shell env has no database credentials but does have ROADIE_AGENT_TOKEN', () => {
    const env: Record<string, string> = {
      ROADIE_DB_URL: 'http://127.0.0.1:29988',
      ROADIE_DB_AUTH_TOKEN: 'db-secret',
      ROADIE_DB_AUTH_TOKEN_FILE: '/path/to/token-file',
      ROADIE_SERVICE_TOKEN_FILE: '/path/to/service-file',
      [AGENT_TOKEN_SECRET_ENV]: secret,
      PATH: '/usr/bin',
    }
    applyAgentShellEnv({ env, secret, sessionId: 'ses_shell' })
    for (const name of SCRUBBED_SHELL_ENV_NAMES) {
      expect(env[name]).toBe('')
    }
    expect(env[AGENT_TOKEN_SECRET_ENV]).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    const token = env[AGENT_TOKEN_ENV]
    expect(typeof token).toBe('string')
    expect(verifyAgentToken({ secret, token: token! })).toEqual({ sessionId: 'ses_shell' })
    // The token is bound to this session only.
    expect(verifyAgentToken({ secret, token: token! })).not.toEqual({ sessionId: 'ses_other' })
    expect(mintAgentToken({ secret, sessionId: 'ses_other' })).not.toBe(token)
  })

  test('a session-less shell gets no token and keeps no secret', () => {
    const env: Record<string, string> = {
      [AGENT_TOKEN_ENV]: mintAgentToken({ secret, sessionId: 'ses_stale' }),
      [AGENT_TOKEN_SECRET_ENV]: secret,
    }
    applyAgentShellEnv({ env, secret, sessionId: undefined })
    expect(env[AGENT_TOKEN_ENV]).toBeUndefined()
    expect(env[AGENT_TOKEN_SECRET_ENV]).toBeUndefined()
  })

  test('without a secret no token is exported and a stale one is removed', () => {
    const env: Record<string, string> = {
      [AGENT_TOKEN_ENV]: mintAgentToken({ secret, sessionId: 'ses_stale' }),
    }
    applyAgentShellEnv({ env, secret: undefined, sessionId: 'ses_shell' })
    expect(env[AGENT_TOKEN_ENV]).toBeUndefined()
    expect(env.ROADIE_DB_URL).toBe('')
  })
})

describe('agent mode detection', () => {
  test('resolveAgentCredentials requires the opencode process marker, a token, and no database credential', async () => {
    const { resolveAgentCredentials } = await import('./agent-remote.js')
    useTempDataDir()
    await closeDb()

    delete process.env.ROADIE_OPENCODE_PROCESS
    delete process.env.ROADIE_DB_URL
    delete process.env.ROADIE_DB_AUTH_TOKEN
    delete process.env.ROADIE_DB_AUTH_TOKEN_FILE
    process.env[AGENT_TOKEN_ENV] = 'ses_x.token'
    expect(resolveAgentCredentials()).toBeInstanceOf(Error)

    process.env.ROADIE_OPENCODE_PROCESS = '1'
    expect(resolveAgentCredentials()).toEqual({ token: 'ses_x.token', port: expect.any(Number) })

    // A usable database credential keeps the shell in operator mode.
    process.env.ROADIE_DB_URL = 'http://127.0.0.1:29988'
    expect(resolveAgentCredentials()).toBeInstanceOf(Error)
    delete process.env.ROADIE_DB_URL
    process.env.ROADIE_DB_AUTH_TOKEN = 'db-secret'
    expect(resolveAgentCredentials()).toBeInstanceOf(Error)
    delete process.env.ROADIE_DB_AUTH_TOKEN

    // Blanked (empty) credentials — what the shell.env hook writes — are not
    // usable credentials.
    process.env.ROADIE_DB_AUTH_TOKEN = ''
    process.env.ROADIE_DB_AUTH_TOKEN_FILE = ''
    expect(resolveAgentCredentials()).toEqual({ token: 'ses_x.token', port: expect.any(Number) })

    delete process.env[AGENT_TOKEN_ENV]
    expect(resolveAgentCredentials()).toBeInstanceOf(Error)
  })
})
