import { test, expect, describe, afterEach, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { credentialPoolsPlugin, CREDENTIAL_POOLS_ENV } from '../credential-pools-plugin.js'
import {
  CREDENTIALS_MODE_ENV,
  THREAD_BILLING_ENV,
} from './person-pool.js'
import { readSessionRoute, setSessionRoute } from './routes.js'
import {
  getSessionCredentialOwner,
  getSessionTurnAttribution,
  recordCredentialOwner,
  setSessionTurnAttribution,
} from '../database.js'
import { closeDb } from '../db.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {
  [CREDENTIAL_POOLS_ENV]: process.env[CREDENTIAL_POOLS_ENV],
  [CREDENTIALS_MODE_ENV]: process.env[CREDENTIALS_MODE_ENV],
  [THREAD_BILLING_ENV]: process.env[THREAD_BILLING_ENV],
  ROADIE_DATA_DIR: process.env.ROADIE_DATA_DIR,
}

afterEach(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

afterAll(async () => {
  await closeDb()
})

/** Set the plugin env the way opencode.ts does for pools-on servers. */
function setRoutingEnv({
  mode,
  billing,
}: {
  mode?: string
  billing?: string
} = {}) {
  process.env[CREDENTIAL_POOLS_ENV] = '1'
  if (mode === undefined) delete process.env[CREDENTIALS_MODE_ENV]
  else process.env[CREDENTIALS_MODE_ENV] = mode
  if (billing === undefined) delete process.env[THREAD_BILLING_ENV]
  else process.env[THREAD_BILLING_ENV] = billing
}

async function chatHeaders(sessionID: string): Promise<Record<string, string>> {
  const hooks = await credentialPoolsPlugin({} as Parameters<typeof credentialPoolsPlugin>[0])
  expect(hooks).not.toBeNull()
  const hook = hooks && 'chat.headers' in hooks ? hooks['chat.headers'] : undefined
  expect(hook).toBeDefined()
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

describe('credentialPoolsPlugin', () => {
  test('flag off: no hooks at all', async () => {
    delete process.env[CREDENTIAL_POOLS_ENV]
    const hooks = await credentialPoolsPlugin({} as Parameters<typeof credentialPoolsPlugin>[0])
    expect(hooks).toEqual({})
  })

  test('flag on, mode unset or global: tags the shared pool (unchanged headers, no db)', async () => {
    for (const mode of [undefined, 'global']) {
      setRoutingEnv({ mode })
      expect(await chatHeaders('ses_abc')).toEqual({
        'x-roadie-pool': 'shared',
        'x-roadie-session': 'ses_abc',
      })
    }
  })

  test('flag on with a per-person mode env but pools flag off: inert', async () => {
    // Mode alone never enables routing: ROADIE_CREDENTIAL_POOLS is the switch.
    delete process.env[CREDENTIAL_POOLS_ENV]
    process.env[CREDENTIALS_MODE_ENV] = 'per-person'
    const hooks = await credentialPoolsPlugin({} as Parameters<typeof credentialPoolsPlugin>[0])
    expect(hooks).toEqual({})
  })

  test('per-person + owner billing: the session owner\'s pool', async () => {
    setRoutingEnv({ mode: 'per-person', billing: 'owner' })
    await recordCredentialOwner({ sessionId: 'ses_owner', poolId: 'alice', personKey: 'discord:1' })
    expect(await chatHeaders('ses_owner')).toEqual({
      'x-roadie-pool': 'alice',
      'x-roadie-session': 'ses_owner',
    })
  })

  test('per-person + owner billing: no owner row falls back to shared', async () => {
    setRoutingEnv({ mode: 'per-person', billing: 'owner' })
    expect(await chatHeaders('ses_nobody')).toEqual({
      'x-roadie-pool': 'shared',
      'x-roadie-session': 'ses_nobody',
    })
  })

  test('per-person + speaker billing: the current speaker\'s recorded pool', async () => {
    setRoutingEnv({ mode: 'per-person', billing: 'speaker' })
    await recordCredentialOwner({ sessionId: 'ses_spk', poolId: 'alice', personKey: 'discord:1' })
    await setSessionTurnAttribution({
      sessionId: 'ses_spk',
      threadId: 'thr',
      actor: { platform: 'discord', id: '2', via: 'chat' },
      credentialPool: 'bob',
    })
    expect(await chatHeaders('ses_spk')).toEqual({
      'x-roadie-pool': 'bob',
      'x-roadie-session': 'ses_spk',
    })
  })

  test('per-person + speaker billing: a turn with no speaker bills to shared', async () => {
    setRoutingEnv({ mode: 'per-person', billing: 'speaker' })
    await setSessionTurnAttribution({ sessionId: 'ses_nospk', threadId: 'thr' })
    expect(await chatHeaders('ses_nospk')).toEqual({
      'x-roadie-pool': 'shared',
      'x-roadie-session': 'ses_nospk',
    })
  })

  test('per-person-fallback: owner pool first, then shared', async () => {
    setRoutingEnv({ mode: 'per-person-fallback', billing: 'owner' })
    await recordCredentialOwner({ sessionId: 'ses_fb', poolId: 'alice', personKey: 'discord:1' })
    expect(await chatHeaders('ses_fb')).toEqual({
      'x-roadie-pool': 'alice,shared',
      'x-roadie-session': 'ses_fb',
    })
    // Owner pinned to shared: the list never duplicates the pool.
    await recordCredentialOwner({ sessionId: 'ses_fb2', poolId: 'shared', personKey: 'guest' })
    expect(await chatHeaders('ses_fb2')).toEqual({
      'x-roadie-pool': 'shared',
      'x-roadie-session': 'ses_fb2',
    })
  })

  test('requests to other providers are not tagged (nothing to strip them)', async () => {
    setRoutingEnv({ mode: 'per-person', billing: 'owner' })
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

  test('owner rows round-trip through the db helpers', async () => {
    await recordCredentialOwner({ sessionId: 'ses_round', poolId: 'bob' })
    expect(await getSessionCredentialOwner('ses_round')).toEqual({ poolId: 'bob' })
    expect(await getSessionCredentialOwner('ses_missing')).toBeUndefined()
    // Re-records never move the owner.
    await recordCredentialOwner({ sessionId: 'ses_round', poolId: 'alice', personKey: 'discord:9' })
    expect(await getSessionCredentialOwner('ses_round')).toEqual({ poolId: 'bob' })
    expect(await getSessionTurnAttribution('ses_round')).toBeUndefined()
  })
})

describe('credentialPoolsPlugin event hook (turn affinity cleanup)', () => {
  const NOW = 1_000_000

  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credential-pools-plugin-events-'))
  })

  const ROUTE = {
    poolId: 'alice',
    accountId: 'acc_1',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4',
    rotation: 'default',
  }

  /** Instantiate the plugin with ROADIE_DATA_DIR pointing at the temp dir. */
  async function eventHook() {
    process.env[CREDENTIAL_POOLS_ENV] = '1'
    process.env.ROADIE_DATA_DIR = dataDir
    const hooks = await credentialPoolsPlugin({} as Parameters<typeof credentialPoolsPlugin>[0])
    expect(hooks).not.toBeNull()
    const hook = hooks && 'event' in hooks ? hooks.event : undefined
    expect(hook).toBeDefined()
    if (!hook) throw new Error('event hook missing')
    return hook
  }

  test('session.idle clears the session\'s held route', async () => {
    const hook = await eventHook()
    await setSessionRoute({ dataDir, sessionId: 'ses_idle', route: { ...ROUTE, pinnedAt: NOW }, now: NOW })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_idle', now: NOW })).toEqual({ ...ROUTE, pinnedAt: NOW })
    await hook({ event: { type: 'session.idle', properties: { sessionID: 'ses_idle' } } })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_idle', now: NOW })).toBeNull()
  })

  test('session.deleted clears the session\'s held route (keyed by info.id)', async () => {
    const hook = await eventHook()
    await setSessionRoute({ dataDir, sessionId: 'ses_dead', route: { ...ROUTE, pinnedAt: NOW }, now: NOW })
    await hook({
      event: { type: 'session.deleted', properties: { info: { id: 'ses_dead' } } } as Parameters<
        NonNullable<typeof hook>
      >[0]['event'],
    })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_dead', now: NOW })).toBeNull()
  })

  test('other events leave the route alone', async () => {
    const hook = await eventHook()
    await setSessionRoute({ dataDir, sessionId: 'ses_live', route: { ...ROUTE, pinnedAt: NOW }, now: NOW })
    await hook({ event: { type: 'session.error', properties: { sessionID: 'ses_live' } } })
    await hook({ event: { type: 'session.idle', properties: { sessionID: 'ses_other' } } })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_live', now: NOW })).toEqual({ ...ROUTE, pinnedAt: NOW })
  })
})
