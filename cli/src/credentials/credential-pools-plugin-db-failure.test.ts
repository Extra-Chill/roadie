// A failed owner/speaker lookup must never bill the shared pool: in per-person
// modes the plugin sends no pool, and the provider rejects such a request.
// Kept in its own file because the database module is mocked for every test.
import { test, expect, describe, vi, afterEach } from 'vitest'

vi.mock('../database.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../database.js')>()
  return {
    ...original,
    getSessionCredentialOwner: async () => {
      throw new Error('database is locked')
    },
    getSessionTurnAttribution: async () => {
      throw new Error('database is locked')
    },
  }
})

const { credentialPoolsPlugin, CREDENTIAL_POOLS_ENV } = await import('../credential-pools-plugin.js')
const { CREDENTIALS_MODE_ENV, THREAD_BILLING_ENV } = await import('./person-pool.js')

const ENV_NAMES = [CREDENTIAL_POOLS_ENV, CREDENTIALS_MODE_ENV, THREAD_BILLING_ENV]
const ORIGINAL_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

async function chatHeaders(sessionID: string): Promise<Record<string, string>> {
  const hooks = await credentialPoolsPlugin({} as Parameters<typeof credentialPoolsPlugin>[0])
  const hook = hooks && 'chat.headers' in hooks ? hooks['chat.headers'] : undefined
  if (!hook) throw new Error('chat.headers hook missing')
  const output = { headers: {} as Record<string, string> }
  await hook(
    {
      sessionID,
      agent: 'build',
      model: { id: 'default', providerID: 'roadie' },
      provider: { source: 'config', info: {}, options: {} },
      message: {},
    } as Parameters<NonNullable<typeof hook>>[0],
    output,
  )
  return output.headers
}

describe('credentialPoolsPlugin when the routing lookup fails', () => {
  for (const mode of ['per-person', 'per-person-fallback']) {
    for (const billing of ['owner', 'speaker']) {
      test(`${mode} + ${billing} billing sends no pool instead of shared`, async () => {
        process.env[CREDENTIAL_POOLS_ENV] = '1'
        process.env[CREDENTIALS_MODE_ENV] = mode
        process.env[THREAD_BILLING_ENV] = billing
        expect(await chatHeaders('ses_db_down')).toEqual({ 'x-roadie-session': 'ses_db_down' })
      })
    }
  }

  test('global mode never reads the database and still tags shared', async () => {
    process.env[CREDENTIAL_POOLS_ENV] = '1'
    delete process.env[CREDENTIALS_MODE_ENV]
    expect(await chatHeaders('ses_global')).toEqual({
      'x-roadie-pool': 'shared',
      'x-roadie-session': 'ses_global',
    })
  })
})
