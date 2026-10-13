// The Pi backend's per-turn shell env file carries the configured
// --shell-env / ROADIE_SHELL_ENV templates, exactly like the OpenCode
// backend's shell.env hook. Unit-level: writeShellEnv runs without a `pi`
// process, so this does not need the ROADIE_PI_BIN e2e harness.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { closeDb } from '../../db.js'
import { setSessionTurnAttribution } from '../../database.js'
import { AGENT_TOKEN_SECRET_ENV } from '../../agent-token.js'
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
    })
    try {
      const env = await writeShellEnv(provider, sessionId)
      expect(env.ROADIE_DEPLOY_HOOK).toBe(`https://ops.example/hook/${sessionId}`)
      expect(env.ROADIE_LABEL).toBe('discord:38')
      expect(env.ROADIE_PERSON).toBe('host:38')
      // The rest of the shell env contract is untouched.
      expect(env.ROADIE_SESSION_ID).toBe(sessionId)
      expect(env.ROADIE_THREAD_ID).toBe('thread-1')
      expect(env.ROADIE_AGENT_TOKEN).toContain(sessionId)
    } finally {
      provider.dispose()
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
})
