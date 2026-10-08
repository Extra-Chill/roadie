import { test, expect, describe, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  addPoolAccount,
  addPoolOAuthAccount,
  getPoolDir,
  isValidPoolId,
  markCooldown,
  markUsed,
  movePoolAccount,
  readPoolAccounts,
  readPoolRotations,
  readPoolState,
  removePoolAccount,
  setPoolRotation,
  updatePoolAccount,
  SHARED_POOL_ID,
  withPoolLock,
  CREDENTIALS_DIR_MODE,
  CREDENTIALS_FILE_MODE,
} from './store.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-store-'))
})

describe('isValidPoolId', () => {
  test('accepts shared and typical pool ids', () => {
    expect(isValidPoolId(SHARED_POOL_ID)).toBe(true)
    expect(isValidPoolId('alice')).toBe(true)
    expect(isValidPoolId('team.1-dev_2:x')).toBe(true)
  })

  test('rejects empty, uppercase and bad-start ids', () => {
    expect(isValidPoolId('')).toBe(false)
    expect(isValidPoolId('-leading-dash')).toBe(false)
    expect(isValidPoolId('.leading-dot')).toBe(false)
    expect(isValidPoolId('Has-Upper')).toBe(false)
    expect(isValidPoolId('has space')).toBe(false)
    expect(isValidPoolId(`${'a'.repeat(129)}`)).toBe(false)
  })

  test('accepts a 128-char id', () => {
    expect(isValidPoolId(`${'a'.repeat(128)}`)).toBe(true)
  })
})

describe('addPoolAccount', () => {
  test('writes accounts.json with the account shape and restrictive modes', async () => {
    const account = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      key: 'sk-ant-secret',
      label: 'main',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(account).not.toBeInstanceOf(Error)
    if (account instanceof Error) return
    expect(account).toMatchObject({
      provider: 'anthropic',
      type: 'api',
      key: 'sk-ant-secret',
      label: 'main',
      addedAt: '2026-01-01T00:00:00.000Z',
      lastUsed: null,
    })
    expect(account.id).toBeTruthy()

    const poolDir = getPoolDir({ dataDir, poolId: SHARED_POOL_ID })
    expect(fs.statSync(poolDir).mode & 0o777).toBe(CREDENTIALS_DIR_MODE)
    const accountsPath = path.join(poolDir, 'accounts.json')
    expect(fs.statSync(accountsPath).mode & 0o777).toBe(CREDENTIALS_FILE_MODE)
    const stored = JSON.parse(fs.readFileSync(accountsPath, 'utf8')) as {
      accounts: Array<{ id: string }>
    }
    expect(stored.accounts).toHaveLength(1)
    expect(stored.accounts[0]?.id).toBe(account.id)
    expect(await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([account])
  })

  test('an optional baseURL round-trips, and absent means absent (legacy files)', async () => {
    const account = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'zai-coding-plan',
      key: 'zai-secret',
      baseURL: ' https://self-hosted.example.com/v4 ',
    })
    expect(account).not.toBeInstanceOf(Error)
    if (account instanceof Error) return
    expect(account.baseURL).toBe('https://self-hosted.example.com/v4')
    const reread = await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (reread instanceof Error) throw reread
    expect(reread[0]).toMatchObject({ provider: 'zai-coding-plan', baseURL: 'https://self-hosted.example.com/v4' })

    const without = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      key: 'sk-ant-no-base',
    })
    expect(without).not.toBeInstanceOf(Error)
    if (without instanceof Error) return
    expect('baseURL' in without).toBe(false)
  })

  test('rejects invalid pool ids and empty provider/key', async () => {
    expect(
      await addPoolAccount({ dataDir, poolId: 'BAD POOL', provider: 'anthropic', key: 'k' }),
    ).toBeInstanceOf(Error)
    expect(
      await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: '  ', key: 'k' }),
    ).toBeInstanceOf(Error)
    expect(
      await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: ' ' }),
    ).toBeInstanceOf(Error)
  })
})

describe('addPoolOAuthAccount', () => {
  test('writes an oauth account with tokens and restrictive modes', async () => {
    const account = await addPoolOAuthAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      refresh: 'rt-subscription',
      access: 'at-subscription',
      expires: 1_900_000,
      label: 'claude max',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(account).not.toBeInstanceOf(Error)
    if (account instanceof Error || account.type !== 'oauth') return
    expect(account).toMatchObject({
      provider: 'anthropic',
      type: 'oauth',
      refresh: 'rt-subscription',
      access: 'at-subscription',
      expires: 1_900_000,
      label: 'claude max',
      addedAt: '2026-01-01T00:00:00.000Z',
      lastUsed: null,
    })
    expect(account.id).toBeTruthy()

    const poolDir = getPoolDir({ dataDir, poolId: SHARED_POOL_ID })
    expect(fs.statSync(poolDir).mode & 0o777).toBe(CREDENTIALS_DIR_MODE)
    const accountsPath = path.join(poolDir, 'accounts.json')
    expect(fs.statSync(accountsPath).mode & 0o777).toBe(CREDENTIALS_FILE_MODE)
    expect(await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([account])
  })

  test('rejects invalid pool ids, empty tokens and bad expiry', async () => {
    expect(
      await addPoolOAuthAccount({ dataDir, poolId: 'BAD POOL', provider: 'anthropic', refresh: 'r', access: 'a', expires: 1 }),
    ).toBeInstanceOf(Error)
    expect(
      await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: ' ', refresh: 'r', access: 'a', expires: 1 }),
    ).toBeInstanceOf(Error)
    expect(
      await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', refresh: ' ', access: 'a', expires: 1 }),
    ).toBeInstanceOf(Error)
    expect(
      await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', refresh: 'r', access: ' ', expires: 1 }),
    ).toBeInstanceOf(Error)
    expect(
      await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', refresh: 'r', access: 'a', expires: 0 }),
    ).toBeInstanceOf(Error)
    expect(
      await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', refresh: 'r', access: 'a', expires: Number.NaN }),
    ).toBeInstanceOf(Error)
  })
})

describe('mixed account types', () => {
  test('api and oauth accounts round-trip together in order', async () => {
    const api = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      key: 'sk-ant-secret',
    })
    expect(api).not.toBeInstanceOf(Error)
    const oauth = await addPoolOAuthAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      refresh: 'rt-1',
      access: 'at-1',
      expires: 1_000_000,
    })
    expect(oauth).not.toBeInstanceOf(Error)

    const accounts = await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) throw accounts
    expect(accounts.map((account) => account.type)).toEqual(['api', 'oauth'])
    expect(accounts).toEqual([api, oauth])
  })

  test('a legacy phase-1a accounts.json still loads unchanged', async () => {
    const legacyAccounts = {
      accounts: [
        {
          id: 'legacy-1',
          provider: 'anthropic',
          type: 'api',
          key: 'sk-ant-legacy',
          label: 'main',
          addedAt: '2026-01-01T00:00:00.000Z',
          lastUsed: null,
        },
        {
          id: 'legacy-2',
          provider: 'openai',
          // Even older files may omit the type field.
          key: 'sk-oai-legacy',
          addedAt: '2026-01-02T00:00:00.000Z',
          lastUsed: '2026-01-03T00:00:00.000Z',
        },
      ],
    }
    const poolDir = getPoolDir({ dataDir, poolId: SHARED_POOL_ID })
    fs.mkdirSync(poolDir, { recursive: true })
    fs.writeFileSync(path.join(poolDir, 'accounts.json'), JSON.stringify(legacyAccounts, null, 2))

    const accounts = await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) throw accounts
    expect(accounts).toEqual([
      {
        id: 'legacy-1',
        provider: 'anthropic',
        type: 'api',
        key: 'sk-ant-legacy',
        label: 'main',
        addedAt: '2026-01-01T00:00:00.000Z',
        lastUsed: null,
      },
      {
        id: 'legacy-2',
        provider: 'openai',
        type: 'api',
        key: 'sk-oai-legacy',
        addedAt: '2026-01-02T00:00:00.000Z',
        lastUsed: '2026-01-03T00:00:00.000Z',
      },
    ])
  })

  test('malformed oauth accounts are dropped on load', async () => {
    const poolDir = getPoolDir({ dataDir, poolId: SHARED_POOL_ID })
    fs.mkdirSync(poolDir, { recursive: true })
    fs.writeFileSync(
      path.join(poolDir, 'accounts.json'),
      JSON.stringify({
        accounts: [
          { id: 'bad-1', provider: 'anthropic', type: 'oauth', refresh: 'r' },
          { id: 'bad-2', provider: 'anthropic', type: 'oauth' },
          { id: 'bad-3', provider: 'anthropic', type: 'api' },
          'nope',
        ],
      }),
    )
    expect(await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([])
  })
})

describe('updatePoolAccount', () => {
  test('writes rotated tokens back and keeps the other fields', async () => {
    const account = await addPoolOAuthAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      refresh: 'rt-old',
      access: 'at-old',
      expires: 1_000,
      label: 'mine',
    })
    expect(account).not.toBeInstanceOf(Error)
    if (account instanceof Error) return
    await markUsed({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id, now: 500 })

    const updated = await updatePoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      accountId: account.id,
      refresh: 'rt-new',
      access: 'at-new',
      expires: 2_000,
    })
    expect(updated).not.toBeInstanceOf(Error)
    if (updated instanceof Error || updated.type !== 'oauth') return
    expect(updated).toMatchObject({
      id: account.id,
      provider: 'anthropic',
      type: 'oauth',
      refresh: 'rt-new',
      access: 'at-new',
      expires: 2_000,
      label: 'mine',
      lastUsed: new Date(500).toISOString(),
    })
    expect(await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([updated])
  })

  test('returns an error for unknown ids and api accounts', async () => {
    const api = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'k' })
    expect(api).not.toBeInstanceOf(Error)
    expect(
      await updatePoolAccount({
        dataDir,
        poolId: SHARED_POOL_ID,
        accountId: 'missing',
        refresh: 'r',
        access: 'a',
        expires: 1,
      }),
    ).toBeInstanceOf(Error)
    if (api instanceof Error) return
    expect(
      await updatePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: api.id, refresh: 'r', access: 'a', expires: 1 }),
    ).toBeInstanceOf(Error)
  })

  test('rejects empty tokens and bad expiry', async () => {
    const account = await addPoolOAuthAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      refresh: 'r',
      access: 'a',
      expires: 1,
    })
    expect(account).not.toBeInstanceOf(Error)
    if (account instanceof Error) return
    expect(
      await updatePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id, refresh: ' ', access: 'a', expires: 2 }),
    ).toBeInstanceOf(Error)
    expect(
      await updatePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id, refresh: 'r', access: '', expires: 2 }),
    ).toBeInstanceOf(Error)
    expect(
      await updatePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id, refresh: 'r', access: 'a', expires: -1 }),
    ).toBeInstanceOf(Error)
  })
})

describe('removePoolAccount', () => {
  test('removes the account and prunes its state entries', async () => {
    const account = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'openai',
      key: 'sk-openai-secret',
    })
    expect(account).not.toBeInstanceOf(Error)
    if (account instanceof Error) return
    await markUsed({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id, now: 1000 })
    await markCooldown({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id, untilMs: 5000 })

    const removed = await removePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id })
    expect(removed).toBe(true)
    expect(await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([])
    const state = await readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    expect(state).toEqual({ cooldowns: {}, lastUsed: {} })
  })

  test('returns false for unknown ids', async () => {
    expect(
      await removePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: 'missing' }),
    ).toBe(false)
  })
})

describe('movePoolAccount', () => {
  async function addThreeAccounts(): Promise<Array<{ id: string; provider: string }>> {
    const accounts: Array<{ id: string; provider: string }> = []
    for (const provider of ['anthropic', 'openai', 'groq']) {
      const account = await addPoolAccount({
        dataDir,
        poolId: SHARED_POOL_ID,
        provider,
        key: `sk-${provider}-secret`,
      })
      if (account instanceof Error) throw account
      accounts.push({ id: account.id, provider })
    }
    return accounts
  }

  test('moves an account to a 1-based position and persists the new order', async () => {
    const [first, second, third] = await addThreeAccounts()
    const moved = await movePoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      accountId: third!.id,
      position: 1,
    })
    expect(moved).not.toBeInstanceOf(Error)
    expect((moved as Array<{ id: string }>).map((account) => account.id)).toEqual([
      third!.id,
      first!.id,
      second!.id,
    ])
    const reread = await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (reread instanceof Error) throw reread
    expect(reread.map((account) => account.id)).toEqual([
      third!.id,
      first!.id,
      second!.id,
    ])
  })

  test('moving an account later in the list keeps the relative order', async () => {
    const [first, second, third] = await addThreeAccounts()
    const moved = await movePoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      accountId: first!.id,
      position: 3,
    })
    expect(moved).not.toBeInstanceOf(Error)
    expect((moved as Array<{ id: string }>).map((account) => account.id)).toEqual([
      second!.id,
      third!.id,
      first!.id,
    ])
  })

  test('moving to the current position is a no-op reorder', async () => {
    const [first, second] = await addThreeAccounts()
    const moved = await movePoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      accountId: second!.id,
      position: 2,
    })
    expect(moved).not.toBeInstanceOf(Error)
    expect((moved as Array<{ id: string }>).map((account) => account.id)).toEqual([
      first!.id,
      second!.id,
      expect.any(String),
    ])
  })

  test('rejects unknown accounts, out-of-range and non-integer positions', async () => {
    const [first] = await addThreeAccounts()
    expect(
      await movePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: 'missing', position: 1 }),
    ).toBeInstanceOf(Error)
    expect(
      await movePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: first!.id, position: 0 }),
    ).toBeInstanceOf(Error)
    expect(
      await movePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: first!.id, position: 4 }),
    ).toBeInstanceOf(Error)
    expect(
      await movePoolAccount({ dataDir, poolId: SHARED_POOL_ID, accountId: first!.id, position: 1.5 }),
    ).toBeInstanceOf(Error)
    expect(
      await movePoolAccount({ dataDir, poolId: 'BAD POOL', accountId: first!.id, position: 1 }),
    ).toBeInstanceOf(Error)
    // Nothing was moved by the failed calls.
    const reread = await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (reread instanceof Error) throw reread
    expect(reread.map((account) => account.provider)).toEqual(['anthropic', 'openai', 'groq'])
  })

  test('keeps cooldown and last-used state keyed by account id', async () => {
    const [first, second] = await addThreeAccounts()
    await markCooldown({ dataDir, poolId: SHARED_POOL_ID, accountId: second!.id, untilMs: 5000 })
    const moved = await movePoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      accountId: second!.id,
      position: 1,
    })
    expect(moved).not.toBeInstanceOf(Error)
    const state = await readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    if (state instanceof Error) throw state
    expect(state.cooldowns).toEqual({ [second!.id]: 5000 })
  })
})

describe('pool state', () => {
  test('markCooldown and markUsed round-trip', async () => {
    const account = await addPoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      provider: 'anthropic',
      key: 'k',
    })
    expect(account).not.toBeInstanceOf(Error)
    if (account instanceof Error) return

    expect(await markCooldown({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id, untilMs: 12345 })).toBe(true)
    expect(await markUsed({ dataDir, poolId: SHARED_POOL_ID, accountId: account.id, now: 999 })).toBe(true)

    const state = await readPoolState({ dataDir, poolId: SHARED_POOL_ID })
    expect(state).toEqual({ cooldowns: { [account.id]: 12345 }, lastUsed: { [account.id]: 999 } })

    // markUsed also stamps the account record
    const accounts = await readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) throw accounts
    expect(accounts[0]?.lastUsed).toBe(new Date(999).toISOString())
  })

  test('missing state file reads as empty', () => {
    expect(readPoolState({ dataDir, poolId: SHARED_POOL_ID })).toEqual({
      cooldowns: {},
      lastUsed: {},
    })
  })
})

describe('rotations', () => {
  test('setPoolRotation stores ordered provider/model entries', async () => {
    const result = await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['anthropic/claude-sonnet-4', 'openai/gpt-5.1'],
    })
    expect(result).toBe(true)
    expect(await readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toEqual({
      default: ['anthropic/claude-sonnet-4', 'openai/gpt-5.1'],
    })
  })

  test('replaces an existing rotation and removes on empty entries', async () => {
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['a/m1'] })
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['a/m2'] })
    expect(await readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toEqual({ default: ['a/m2'] })
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: [] })
    expect(await readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toEqual({})
  })

  test('rejects invalid rotation names and malformed entries', async () => {
    expect(
      await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'bad name!', entries: ['a/m'] }),
    ).toBeInstanceOf(Error)
    expect(
      await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['no-slash'] }),
    ).toBeInstanceOf(Error)
    expect(
      await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['a/'] }),
    ).toBeInstanceOf(Error)
    expect(
      await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['a b/c'] }),
    ).toBeInstanceOf(Error)
  })

  test('missing rotation file reads as empty', () => {
    expect(readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toEqual({})
  })
})

describe('withPoolLock', () => {
  test('serializes concurrent writers so no write is lost', async () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      withPoolLock(SHARED_POOL_ID, () => {
        const filePath = path.join(dataDir, 'counter.json')
        const current = fs.existsSync(filePath)
          ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as { n: number }).n
          : 0
        fs.writeFileSync(filePath, JSON.stringify({ n: current + 1 }))
        return current + 1
      }),
    )
    const results = await Promise.all(runs)
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    const final = JSON.parse(fs.readFileSync(path.join(dataDir, 'counter.json'), 'utf8')) as { n: number }
    expect(final.n).toBe(20)
  })

  test('a failed task does not poison the chain', async () => {
    const failing = withPoolLock(SHARED_POOL_ID, () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')
    const value = await withPoolLock(SHARED_POOL_ID, () => 'still-works')
    expect(value).toBe('still-works')
  })
})
