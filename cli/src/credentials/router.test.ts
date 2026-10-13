import { test, expect, describe, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  addPoolAccount,
  markUsed,
  setPoolRotation,
  SHARED_POOL_ID,
  type PoolAccount,
} from './store.js'
import {
  accountServesProvider,
  isCoolingDown,
  markCooldown,
  parseRotationEntry,
  resolveCandidates,
  resolvePoolCandidates,
  type PoolCandidate,
} from './router.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-router-'))
})

describe('parseRotationEntry', () => {
  test('splits on the first slash, keeping slashes in the model id', () => {
    expect(parseRotationEntry('anthropic/claude-sonnet-4')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    })
    expect(parseRotationEntry('openai/deep/research')).toEqual({
      provider: 'openai',
      modelId: 'deep/research',
    })
  })

  test('returns null for malformed entries', () => {
    expect(parseRotationEntry('no-slash')).toBeNull()
    expect(parseRotationEntry('/leading')).toBeNull()
    expect(parseRotationEntry('trailing/')).toBeNull()
    expect(parseRotationEntry('a/ b')).toBeNull()
  })
})

describe('isCoolingDown', () => {
  test('true only while the cooldown is in the future', () => {
    const cooldowns = { a: 100, b: 50 }
    expect(isCoolingDown({ cooldowns, accountId: 'a', now: 100 })).toBe(false)
    expect(isCoolingDown({ cooldowns, accountId: 'a', now: 99 })).toBe(true)
    expect(isCoolingDown({ cooldowns, accountId: 'b', now: 99 })).toBe(false)
    expect(isCoolingDown({ cooldowns, accountId: 'missing', now: 0 })).toBe(false)
  })
})

const NOW = 1000

function candidateKey(candidate: PoolCandidate): string {
  return `${candidate.provider}/${candidate.modelId}:${candidate.account.id}`
}

describe('resolveCandidates', () => {
  const accounts: PoolAccount[] = [
    { id: 'a1', provider: 'anthropic', type: 'api', key: 'k1', addedAt: '2026-01-01', lastUsed: null },
    { id: 'a2', provider: 'anthropic', type: 'api', key: 'k2', addedAt: '2026-01-02', lastUsed: null },
    { id: 'o1', provider: 'openai', type: 'api', key: 'k3', addedAt: '2026-01-03', lastUsed: null },
  ]

  test('orders by rotation entry, then account order', () => {
    const candidates = resolveCandidates({
      poolId: SHARED_POOL_ID,
      rotation: ['openai/gpt-5.1', 'anthropic/claude-sonnet-4'],
      accounts,
      cooldowns: {},
      now: NOW,
    })
    expect(candidates.map(candidateKey)).toEqual([
      'openai/gpt-5.1:o1',
      'anthropic/claude-sonnet-4:a1',
      'anthropic/claude-sonnet-4:a2',
    ])
  })

  test('skips cooled-down accounts', () => {
    const candidates = resolveCandidates({
      poolId: SHARED_POOL_ID,
      rotation: ['anthropic/claude-sonnet-4'],
      accounts,
      cooldowns: { a1: NOW + 60_000 },
      now: NOW,
    })
    expect(candidates.map(candidateKey)).toEqual(['anthropic/claude-sonnet-4:a2'])
  })

  test('keeps an account whose cooldown already expired', () => {
    const candidates = resolveCandidates({
      poolId: SHARED_POOL_ID,
      rotation: ['anthropic/claude-sonnet-4'],
      accounts,
      cooldowns: { a1: NOW },
      now: NOW,
    })
    expect(candidates.map(candidateKey)).toEqual([
      'anthropic/claude-sonnet-4:a1',
      'anthropic/claude-sonnet-4:a2',
    ])
  })

  test('skips malformed rotation entries and unknown providers', () => {
    const candidates = resolveCandidates({
      poolId: SHARED_POOL_ID,
      rotation: ['garbage', 'mistral/unknown-model', 'anthropic/claude-sonnet-4'],
      accounts,
      cooldowns: {},
      now: NOW,
    })
    expect(candidates.map(candidateKey)).toEqual([
      'anthropic/claude-sonnet-4:a1',
      'anthropic/claude-sonnet-4:a2',
    ])
  })

  test('empty rotation or empty accounts yield no candidates', () => {
    expect(
      resolveCandidates({ poolId: SHARED_POOL_ID, rotation: [], accounts, cooldowns: {}, now: NOW }),
    ).toEqual([])
    expect(
      resolveCandidates({
        poolId: SHARED_POOL_ID,
        rotation: ['anthropic/claude-sonnet-4'],
        accounts: [],
        cooldowns: {},
        now: NOW,
      }),
    ).toEqual([])
  })
})

describe('resolvePoolCandidates + markCooldown integration', () => {
  test('cooled accounts are skipped and recover when the cooldown expires', async () => {
    const first = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'k1' })
    const second = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'k2' })
    expect(first).not.toBeInstanceOf(Error)
    expect(second).not.toBeInstanceOf(Error)
    if (first instanceof Error || second instanceof Error) return
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['anthropic/claude-sonnet-4'],
    })
    await markUsed({ dataDir, poolId: SHARED_POOL_ID, accountId: first.id, now: NOW })

    const initial = await resolvePoolCandidates({ dataDir, poolId: SHARED_POOL_ID, rotationName: 'default', now: NOW })
    if (initial instanceof Error) throw initial
    expect(initial.map((candidate) => candidate.account.id)).toEqual([first.id, second.id])

    const cooled = await markCooldown({
      dataDir,
      poolId: SHARED_POOL_ID,
      accountId: first.id,
      untilMs: NOW + 30_000,
    })
    expect(cooled).toBe(true)

    const after = await resolvePoolCandidates({ dataDir, poolId: SHARED_POOL_ID, rotationName: 'default', now: NOW + 1 })
    if (after instanceof Error) throw after
    expect(after.map((candidate) => candidate.account.id)).toEqual([second.id])

    const recovered = await resolvePoolCandidates({
      dataDir,
      poolId: SHARED_POOL_ID,
      rotationName: 'default',
      now: NOW + 30_000,
    })
    if (recovered instanceof Error) throw recovered
    expect(recovered.map((candidate) => candidate.account.id)).toEqual([first.id, second.id])
  })

  test('unknown rotation name yields no candidates', async () => {
    await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', key: 'k1' })
    const candidates = await resolvePoolCandidates({
      dataDir,
      poolId: SHARED_POOL_ID,
      rotationName: 'missing',
      now: NOW,
    })
    if (candidates instanceof Error) throw candidates
    expect(candidates).toEqual([])
  })
})

describe('ChatGPT subscriptions serve openai/ entries (#198)', () => {
  const codexOauth: PoolAccount = {
    id: 'codex',
    provider: 'openai-codex',
    type: 'oauth',
    refresh: 'rt',
    access: 'at',
    expires: 0,
    addedAt: '',
    lastUsed: null,
  }
  const codexApi: PoolAccount = { id: 'codex-key', provider: 'openai-codex', type: 'api', key: 'k', addedAt: '', lastUsed: null }
  const openaiKey: PoolAccount = { id: 'openai-key', provider: 'openai', type: 'api', key: 'sk', addedAt: '', lastUsed: null }
  const anthropicKey: PoolAccount = { id: 'ant', provider: 'anthropic', type: 'api', key: 'sk-ant', addedAt: '', lastUsed: null }

  test('accountServesProvider maps only openai entries onto ChatGPT oauth accounts', () => {
    expect(accountServesProvider({ account: codexOauth, provider: 'openai' })).toBe('openai-codex')
    expect(accountServesProvider({ account: codexOauth, provider: 'openai-codex' })).toBe('openai-codex')
    expect(accountServesProvider({ account: codexApi, provider: 'openai' })).toBeNull()
    expect(accountServesProvider({ account: codexOauth, provider: 'anthropic' })).toBeNull()
    expect(accountServesProvider({ account: openaiKey, provider: 'openai' })).toBe('openai')
    expect(accountServesProvider({ account: openaiKey, provider: 'openai-codex' })).toBeNull()
  })

  test('an openai/<model> entry resolves the subscription as an openai-codex candidate, in order', () => {
    const candidates = resolveCandidates({
      poolId: SHARED_POOL_ID,
      rotation: ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5-5'],
      accounts: [anthropicKey, codexOauth, openaiKey, codexApi],
      cooldowns: {},
      now: NOW,
    })
    expect(candidates.map(candidateKey)).toEqual([
      'openai-codex/gpt-6.1-sol:codex',
      'openai/gpt-6.1-sol:openai-key',
      'anthropic/claude-sonnet-5-5:ant',
    ])
  })

  test('the Pi proxy openai-codex/codex entry resolves exactly as before', () => {
    const candidates = resolveCandidates({
      poolId: SHARED_POOL_ID,
      rotation: ['openai-codex/codex'],
      accounts: [openaiKey, codexOauth, codexApi],
      cooldowns: {},
      now: NOW,
    })
    expect(candidates.map(candidateKey)).toEqual(['openai-codex/codex:codex', 'openai-codex/codex:codex-key'])
  })

  test('a cooling subscription is skipped', () => {
    const candidates = resolveCandidates({
      poolId: SHARED_POOL_ID,
      rotation: ['openai/gpt-6.1-sol'],
      accounts: [codexOauth],
      cooldowns: { codex: NOW + 1 },
      now: NOW,
    })
    expect(candidates).toEqual([])
  })
})
