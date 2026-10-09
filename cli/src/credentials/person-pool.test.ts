// Person -> pool id derivation and pool-list routing (credential pools 2a).
// Pure functions: no db, no config, fully deterministic.

import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import {
  parseCredentialPoolsEnabled,
  parseCredentialsMode,
  parseCredentialsModeStrict,
  parsePoolListHeader,
  parseThreadBilling,
  parseThreadBillingStrict,
  personKeyFrom,
  poolIdForPersonKey,
  resolveBilledPoolList,
  resolvePersonPoolId,
  resolveTurnBilling,
} from './person-pool.js'
import { SHARED_POOL_ID } from './store.js'

describe('personKeyFrom', () => {
  test('prefers the identity-hook person id', () => {
    expect(personKeyFrom({ personId: 'wp:1', platform: 'discord', actorId: '42' })).toBe('wp:1')
  })

  test('falls back to <platform>:<actorId>', () => {
    expect(personKeyFrom({ platform: 'discord', actorId: '532385681268408341' })).toBe(
      'discord:532385681268408341',
    )
  })

  test('no actor means no person key', () => {
    expect(personKeyFrom({})).toBeNull()
    expect(personKeyFrom({ personId: '  ' })).toBeNull()
    expect(personKeyFrom({ platform: 'discord', actorId: '' })).toBeNull()
  })
})

describe('poolIdForPersonKey', () => {
  test('keeps a key that is already a valid pool id', () => {
    expect(poolIdForPersonKey('alice')).toBe('alice')
    expect(poolIdForPersonKey('discord:532385681268408341')).toBe('discord:532385681268408341')
  })

  test('never case-folds: ids differing only in case get different pools', () => {
    // Identity-hook person ids are opaque; folding case would let one person
    // bill another's pool.
    expect(poolIdForPersonKey('Ab')).not.toBe(poolIdForPersonKey('aB'))
    expect(poolIdForPersonKey('Alice')).not.toBe('alice')
    expect(poolIdForPersonKey('Alice')).toMatch(/^person-[0-9a-f]{24}$/)
  })

  test('hashes an invalid key, deterministically', () => {
    const invalid = 'Alice in Wonderland!';
    const expected = `person-${createHash('sha256').update(invalid).digest('hex').slice(0, 24)}`
    expect(poolIdForPersonKey(invalid)).toBe(expected)
    expect(poolIdForPersonKey(invalid)).toBe(poolIdForPersonKey(invalid))
    // 24 hex chars after the prefix, and a valid pool id.
    expect(expected).toMatch(/^person-[0-9a-f]{24}$/)
  })

  test('different people get different pools', () => {
    expect(poolIdForPersonKey('a b!')).not.toBe(poolIdForPersonKey('a c!'))
  })
})

describe('resolvePersonPoolId', () => {
  test('the identity hook override wins when it is a valid pool id', () => {
    expect(resolvePersonPoolId({ personKey: 'alice', credentialPoolOverride: 'team' })).toBe('team')
    expect(resolvePersonPoolId({ personKey: 'alice', credentialPoolOverride: 'shared' })).toBe('shared')
  })

  test('an invalid override is ignored (hooks without it behave as before)', () => {
    expect(resolvePersonPoolId({ personKey: 'alice', credentialPoolOverride: 'Not Valid!' })).toBe('alice')
    expect(resolvePersonPoolId({ personKey: 'alice', credentialPoolOverride: '' })).toBe('alice')
    expect(resolvePersonPoolId({ personKey: 'alice' })).toBe('alice')
  })
})

describe('resolveTurnBilling', () => {
  test('derives pool and person key from the speaker', () => {
    expect(resolveTurnBilling({ platform: 'discord', actorId: '77' })).toEqual({
      personKey: 'discord:77',
      poolId: 'discord:77',
    })
  })

  test('undefined when there is no speaker to key', () => {
    expect(resolveTurnBilling({})).toBeUndefined()
    expect(resolveTurnBilling({ personId: 'wp:1', platform: 'discord' })).toEqual({
      personKey: 'wp:1',
      poolId: 'wp:1',
    })
  })
})

describe('resolveBilledPoolList', () => {
  test('global is today\'s behavior: shared only, whatever the billed pool', () => {
    expect(resolveBilledPoolList({ mode: 'global', billedPoolId: 'alice' })).toEqual([SHARED_POOL_ID])
    expect(resolveBilledPoolList({ mode: 'global' })).toEqual([SHARED_POOL_ID])
  })

  test('per-person: the billed pool only, shared when there is none', () => {
    expect(resolveBilledPoolList({ mode: 'per-person', billedPoolId: 'alice' })).toEqual(['alice'])
    expect(resolveBilledPoolList({ mode: 'per-person' })).toEqual([SHARED_POOL_ID])
    expect(resolveBilledPoolList({ mode: 'per-person', billedPoolId: 'not a pool!' })).toEqual([SHARED_POOL_ID])
  })

  test('per-person-fallback: billed pool first, then shared (never duplicated)', () => {
    expect(resolveBilledPoolList({ mode: 'per-person-fallback', billedPoolId: 'alice' })).toEqual([
      'alice',
      SHARED_POOL_ID,
    ])
    expect(resolveBilledPoolList({ mode: 'per-person-fallback', billedPoolId: 'shared' })).toEqual([
      SHARED_POOL_ID,
    ])
    expect(resolveBilledPoolList({ mode: 'per-person-fallback' })).toEqual([SHARED_POOL_ID])
  })
})

describe('parsePoolListHeader', () => {
  test('splits, trims and dedupes while keeping order', () => {
    expect(parsePoolListHeader('alice,shared')).toEqual(['alice', 'shared'])
    expect(parsePoolListHeader(' alice , shared ,alice')).toEqual(['alice', 'shared'])
    expect(parsePoolListHeader('shared')).toEqual(['shared'])
    expect(parsePoolListHeader(',,')).toEqual([])
  })
})

describe('env and flag parsing', () => {
  test('permissive parsing defaults unknown values', () => {
    expect(parseCredentialsMode(undefined)).toBe('global')
    expect(parseCredentialsMode('per-person')).toBe('per-person')
    expect(parseCredentialsMode('per-person-fallback')).toBe('per-person-fallback')
    expect(parseCredentialsMode('bogus')).toBe('global')
    expect(parseThreadBilling(undefined)).toBe('owner')
    expect(parseThreadBilling('speaker')).toBe('speaker')
    expect(parseThreadBilling('bogus')).toBe('owner')
  })

  test('strict parsing rejects unknown flag values with an Error', () => {
    expect(parseCredentialsModeStrict('global')).toBe('global')
    expect(parseThreadBillingStrict('speaker')).toBe('speaker')
    expect(parseCredentialsModeStrict('perons')).toBeInstanceOf(Error)
    expect(parseThreadBillingStrict('everyone')).toBeInstanceOf(Error)
  })

  test('credential pools are on by default; only 0 disables (phase 4a)', () => {
    expect(parseCredentialPoolsEnabled(undefined)).toBe(true)
    expect(parseCredentialPoolsEnabled(null)).toBe(true)
    expect(parseCredentialPoolsEnabled('')).toBe(true)
    expect(parseCredentialPoolsEnabled('1')).toBe(true)
    expect(parseCredentialPoolsEnabled('0')).toBe(false)
  })
})
