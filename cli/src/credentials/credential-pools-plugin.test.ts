import { test, expect, describe, afterEach } from 'vitest'
import { credentialPoolsPlugin, CREDENTIAL_POOLS_ENV } from '../credential-pools-plugin.js'

const ORIGINAL_ENV = process.env[CREDENTIAL_POOLS_ENV]

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[CREDENTIAL_POOLS_ENV]
  } else {
    process.env[CREDENTIAL_POOLS_ENV] = ORIGINAL_ENV
  }
})

describe('credentialPoolsPlugin', () => {
  test('flag off: no hooks at all', async () => {
    delete process.env[CREDENTIAL_POOLS_ENV]
    const hooks = await credentialPoolsPlugin({} as Parameters<typeof credentialPoolsPlugin>[0])
    expect(hooks).toEqual({})
  })

  test('flag on: tags the shared pool and the session on every LLM call', async () => {
    process.env[CREDENTIAL_POOLS_ENV] = '1'
    const hooks = await credentialPoolsPlugin({} as Parameters<typeof credentialPoolsPlugin>[0])
    expect(hooks).not.toBeNull()
    const hook = hooks && 'chat.headers' in hooks ? hooks['chat.headers'] : undefined
    expect(hook).toBeDefined()
    if (!hook) return
    const output = { headers: {} as Record<string, string> }
    await hook(
      {
        sessionID: 'ses_abc',
        agent: 'build',
        model: { id: 'default', providerID: 'roadie' },
        provider: { source: 'config', info: {}, options: {} },
        message: {},
      } as Parameters<NonNullable<typeof hook>>[0],
      output,
    )
    expect(output.headers).toEqual({
      'x-roadie-pool': 'shared',
      'x-roadie-session': 'ses_abc',
    })
  })

  test('flag on: requests to other providers are not tagged (nothing to strip them)', async () => {
    process.env[CREDENTIAL_POOLS_ENV] = '1'
    const hooks = await credentialPoolsPlugin({} as Parameters<typeof credentialPoolsPlugin>[0])
    const hook = hooks && 'chat.headers' in hooks ? hooks['chat.headers'] : undefined
    expect(hook).toBeDefined()
    if (!hook) return
    for (const providerID of ['anthropic', 'openai', 'subrouter']) {
      const output = { headers: {} as Record<string, string> }
      await hook(
        {
          sessionID: 'ses_abc',
          agent: 'build',
          model: { id: 'm', providerID },
          provider: { source: 'config', info: {}, options: {} },
          message: {},
        } as Parameters<NonNullable<typeof hook>>[0],
        output,
      )
      expect(output.headers).toEqual({})
    }
  })
})
