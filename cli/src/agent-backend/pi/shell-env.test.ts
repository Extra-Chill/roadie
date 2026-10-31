// The Pi backend's per-turn shell env file carries the configured
// --shell-env / ROADIE_SHELL_ENV templates. Unit-level: writeShellEnv
// runs without a `pi`
// process, so this does not need the ROADIE_PI_BIN e2e harness.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { closeDb } from '../../db.js'
import { setSessionTurnAttribution } from '../../database.js'
import { AGENT_TOKEN_SECRET_ENV, verifyAgentToken } from '../../agent-token.js'
import { getDataDir, setDataDir } from '../../config.js'
import { PiBackendProvider } from './backend.js'

const savedSecret = process.env[AGENT_TOKEN_SECRET_ENV]
afterEach(() => {
  if (savedSecret === undefined) delete process.env[AGENT_TOKEN_SECRET_ENV]
  else process.env[AGENT_TOKEN_SECRET_ENV] = savedSecret
})

afterAll(async () => {
  await closeDb()
})

function makeProvider(shellEnvTemplates: Record<string, string>) {
  const sessionDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'roadie-pi-shell-env-'))
  return new PiBackendProvider({ bin: 'pi', sessionDir, shellEnvTemplates })
}

type ShellEnvWriter = { writeShellEnv(file: string, sessionId: string): Promise<void> }

async function writeShellEnv(provider: PiBackendProvider, sessionId: string): Promise<Record<string, string>> {
  const file = path.join(provider.options.sessionDir, `shell-env-${sessionId}.json`)
  await (provider as unknown as ShellEnvWriter).writeShellEnv(file, sessionId)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

describe('Pi backend writeShellEnv with configured templates', () => {
  test('includes the configured variables rendered over the turn attribution', async () => {
    const sessionId = 'ses-pi-shell-env'
    await setSessionTurnAttribution({
      sessionId,
      threadId: 'thread-1',
      channelId: 'channel-1',
      actor: { platform: 'discord', id: '38', name: 'Team Member', via: 'chat' },
      personId: 'host:38',
    })
    process.env[AGENT_TOKEN_SECRET_ENV] = 'test-secret'
    const provider = makeProvider({
      ROADIE_DEPLOY_HOOK: 'https://ops.example/hook/{session_id}',
      ROADIE_LABEL: '{platform}:{actor_id}',
      ROADIE_PERSON: '{person_id}',
      ROADIE_SPEAKER: '{actor_name}',
    })
    try {
      const env = await writeShellEnv(provider, sessionId)
      expect(env.ROADIE_DEPLOY_HOOK).toBe(`https://ops.example/hook/${sessionId}`)
      expect(env.ROADIE_LABEL).toBe('discord:38')
      expect(env.ROADIE_PERSON).toBe('host:38')
      expect(env.ROADIE_SPEAKER).toBe('Team Member')
      // The rest of the shell env contract is untouched.
      expect(env.ROADIE_SESSION_ID).toBe(sessionId)
      expect(env.ROADIE_THREAD_ID).toBe('thread-1')
      expect(env.ROADIE_AGENT_TOKEN).toContain(sessionId)
    } finally {
      provider.dispose()
    }
  })

  test('mints the agent token from the data-dir secret file when the env var is unset (#380)', async () => {
    const sessionId = 'ses-pi-shell-env-secret-file'
    const previousDataDir = getDataDir()
    const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'roadie-pi-secret-'))
    fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'secrets', 'agent-token-secret'), 'file-secret\n')
    delete process.env[AGENT_TOKEN_SECRET_ENV]
    setDataDir(dataDir)
    const provider = makeProvider({})
    try {
      const env = await writeShellEnv(provider, sessionId)
      expect(env.ROADIE_AGENT_TOKEN).not.toBe('')
      expect(verifyAgentToken({ secret: 'file-secret', token: env.ROADIE_AGENT_TOKEN! })).toEqual({ sessionId })
      // The secret itself never reaches the shell.
      expect(env[AGENT_TOKEN_SECRET_ENV]).toBe('')
    } finally {
      provider.dispose()
      setDataDir(previousDataDir)
    }
  })

  test('leaves a variable unset when its field has no value for the turn', async () => {
    const sessionId = 'ses-pi-shell-env-unset'
    await setSessionTurnAttribution({ sessionId, threadId: 'thread-2' })
    const provider = makeProvider({ ROADIE_CHANNEL_VAR: '{channel_id}', ROADIE_THREAD_VAR: '{thread_id}' })
    try {
      const env = await writeShellEnv(provider, sessionId)
      expect(env.ROADIE_CHANNEL_VAR).toBeUndefined()
      expect(env.ROADIE_THREAD_VAR).toBe('thread-2')
    } finally {
      provider.dispose()
    }
  })

  test('configures nothing when no templates are set', async () => {
    const sessionId = 'ses-pi-shell-env-none'
    const provider = makeProvider({})
    try {
      const env = await writeShellEnv(provider, sessionId)
      expect(env.ROADIE_SESSION_ID).toBe(sessionId)
      expect(Object.keys(env).filter((key) => key.startsWith('ROADIE_DEPLOY'))).toEqual([])
    } finally {
      provider.dispose()
    }
  })

  test('gives tool shells a session-lifetime pool key, revoked only when the session is deleted', async () => {
    const sessionId = 'ses-pi-shell-pool-key'
    const live = new Map<string, () => string | undefined>()
    let issued = 0
    const pool = {
      issueKey: (session: () => string | undefined) => {
        const key = `key-${++issued}`
        live.set(key, session)
        return key
      },
      revokeKey: (key: string) => {
        live.delete(key)
      },
    }
    const sessionDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'roadie-pi-shell-env-'))
    const provider = new PiBackendProvider({ bin: 'pi', sessionDir, pool })
    try {
      const first = await writeShellEnv(provider, sessionId)
      const key = first.ROADIE_PI_KEY
      expect(key).toBeDefined()
      expect(live.get(key!)?.()).toBe(sessionId)
      // A later turn (or a resumed Pi process) reuses the same key, so work a
      // shell started earlier keeps billing after its Pi process stops.
      const second = await writeShellEnv(provider, sessionId)
      expect(second.ROADIE_PI_KEY).toBe(key)
      expect(issued).toBe(1)
      await provider.getBackend().sessions.delete({ sessionId, directory: sessionDir })
      expect(live.has(key!)).toBe(false)
    } finally {
      provider.dispose()
    }
  })
})
