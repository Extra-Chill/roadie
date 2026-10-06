import { test, expect, describe, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  addPoolAccount,
  getPoolDir,
  isValidPoolId,
  markCooldown,
  markUsed,
  readPoolAccounts,
  readPoolRotations,
  readPoolState,
  removePoolAccount,
  setPoolRotation,
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
