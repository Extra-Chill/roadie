// The OpenCode backend's shell.env hook (bash-tool-schema-plugin.ts) carries
// the configured --shell-env / ROADIE_SHELL_ENV templates, exactly like the
// Pi backend's shell env file. The bot validates the templates at startup and
// forwards the accepted JSON to the server process (opencode.ts); the hook
// reads it from its environment, as it does for the agent token secret.

import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { bashToolSchemaPlugin } from '../bash-tool-schema-plugin.js'
import { closeDb } from '../db.js'
import { setSessionTurnAttribution } from '../database.js'
import { AGENT_TOKEN_SECRET_ENV } from '../agent-token.js'
import { SHELL_ENV_TEMPLATES_ENV } from '../turn-attribution-env.js'

const saved = [AGENT_TOKEN_SECRET_ENV, SHELL_ENV_TEMPLATES_ENV].map((key) => [key, process.env[key]] as const)
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterAll(async () => {
  await closeDb()
})

const hooks = await bashToolSchemaPlugin({} as Parameters<typeof bashToolSchemaPlugin>[0])

async function runShellEnv(sessionId: string | undefined): Promise<Record<string, string>> {
  const output = { env: {} as Record<string, string> }
  await hooks['shell.env']!({ cwd: process.env.TMPDIR || '/tmp', sessionID: sessionId }, output)
  return output.env
}

describe('OpenCode shell.env hook with configured templates', () => {
  test('includes the configured variables rendered over the turn attribution', async () => {
    const sessionId = 'ses-opencode-shell-env'
    await setSessionTurnAttribution({
      sessionId,
      threadId: 'thread-1',
      channelId: 'channel-1',
      actor: { platform: 'discord', id: '38', name: 'Team Member', via: 'chat' },
      personId: 'host:38',
    })
    process.env[AGENT_TOKEN_SECRET_ENV] = 'test-secret'
    process.env[SHELL_ENV_TEMPLATES_ENV] = JSON.stringify({
      ROADIE_DEPLOY_HOOK: 'https://ops.example/hook/{session_id}',
      ROADIE_LABEL: '{platform}:{actor_id}',
      ROADIE_THREAD_CHANNEL: '{thread_id}/{channel_id}',
    })
    const env = await runShellEnv(sessionId)
    expect(env.ROADIE_DEPLOY_HOOK).toBe(`https://ops.example/hook/${sessionId}`)
    expect(env.ROADIE_LABEL).toBe('discord:38')
    expect(env.ROADIE_THREAD_CHANNEL).toBe('thread-1/channel-1')
    // The rest of the shell.env contract is untouched.
    expect(env.ROADIE_SESSION_ID).toBe(sessionId)
    expect(env.ROADIE_THREAD_ID).toBe('thread-1')
    expect(env.ROADIE_AGENT_TOKEN).toContain(sessionId)
    expect(env.ROADIE_AGENT_TOKEN_SECRET).toBe('')
  })

  test('leaves a variable unset when its field has no value for the turn', async () => {
    const sessionId = 'ses-opencode-shell-env-unset'
    await setSessionTurnAttribution({ sessionId, threadId: 'thread-2' })
    process.env[AGENT_TOKEN_SECRET_ENV] = 'test-secret'
    process.env[SHELL_ENV_TEMPLATES_ENV] = JSON.stringify({
      ROADIE_CHANNEL_VAR: '{channel_id}',
      ROADIE_THREAD_VAR: '{thread_id}',
    })
    const env = await runShellEnv(sessionId)
    expect(env.ROADIE_CHANNEL_VAR).toBeUndefined()
    expect(env.ROADIE_THREAD_VAR).toBe('thread-2')
  })

  test('a shell outside any session only resolves {session_id} templates', async () => {
    process.env[AGENT_TOKEN_SECRET_ENV] = 'test-secret'
    process.env[SHELL_ENV_TEMPLATES_ENV] = JSON.stringify({
      ROADIE_SESSION_VAR: '{session_id}',
      ROADIE_ACTOR_VAR: '{actor_id}',
    })
    const env = await runShellEnv(undefined)
    expect(env.ROADIE_SESSION_VAR).toBeUndefined()
    expect(env.ROADIE_ACTOR_VAR).toBeUndefined()
    expect(env.ROADIE_AGENT_TOKEN).toBe('')
  })

  test('an unparsable ROADIE_SHELL_ENV is skipped without breaking the contract', async () => {
    const sessionId = 'ses-opencode-shell-env-bad'
    process.env[AGENT_TOKEN_SECRET_ENV] = 'test-secret'
    process.env[SHELL_ENV_TEMPLATES_ENV] = '{nope'
    const env = await runShellEnv(sessionId)
    expect(env.ROADIE_SESSION_ID).toBe(sessionId)
    expect(env.ROADIE_AGENT_TOKEN).toContain(sessionId)
  })
})
