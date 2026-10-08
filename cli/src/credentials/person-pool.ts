// Person -> pool id derivation and per-person routing lists.
//
// Pure module: only node builtins plus credentials/store.js, so it can be
// imported by the provider module that runs inside the OpenCode server
// process (credentials/provider.ts) as well as by the bot process.
//
// The person key is the identity hook's person_id when present, otherwise
// `<platform>:<actorId>` (e.g. `discord:532385681268408341`). The pool id for
// a person key is the key itself when it already satisfies POOL_ID_PATTERN,
// else a deterministic hashed fallback, so any person id maps to a stable,
// valid pool directory. Keys are never case-folded: identity-hook person ids
// are opaque, and two ids differing only in case must never share a pool.

import crypto from 'node:crypto'
import { POOL_ID_PATTERN, SHARED_POOL_ID, isValidPoolId } from './store.js'

export const CREDENTIALS_MODE_ENV = 'ROADIE_CREDENTIALS'
export const THREAD_BILLING_ENV = 'ROADIE_THREAD_BILLING'

export type CredentialsMode = 'global' | 'per-person' | 'per-person-fallback'
export type ThreadBilling = 'owner' | 'speaker'

export const CREDENTIALS_MODES: readonly CredentialsMode[] = [
  'global',
  'per-person',
  'per-person-fallback',
]
export const THREAD_BILLINGS: readonly ThreadBilling[] = ['owner', 'speaker']

/** Person key: identity-hook person_id, else `<platform>:<actorId>`. */
export function personKeyFrom({
  personId,
  platform,
  actorId,
}: {
  personId?: string | null
  platform?: string | null
  actorId?: string | null
}): string | null {
  const person = personId?.trim()
  if (person) return person
  const host = platform?.trim()
  const actor = actorId?.trim()
  if (host && actor) return `${host}:${actor}`
  return null
}

/**
 * Pool id for a person key: the key itself when it is already a valid pool id
 * (e.g. `discord:532385681268408341`), otherwise
 * `person-<first 24 hex of sha256(key)>`. Deterministic, and injective in
 * practice: keys are never case-folded, because identity-hook person ids are
 * opaque and `Ab` and `aB` may be different people who must never share a
 * pool.
 */
export function poolIdForPersonKey(personKey: string): string {
  if (POOL_ID_PATTERN.test(personKey)) return personKey
  const hash = crypto.createHash('sha256').update(personKey).digest('hex').slice(0, 24)
  return `person-${hash}`
}

/**
 * Pool a person bills to: the identity hook's `credential_pool` override when
 * present and valid, else the derived pool id. An invalid override is ignored
 * so hooks that send a bad value behave as if they sent none.
 */
export function resolvePersonPoolId({
  personKey,
  credentialPoolOverride,
}: {
  personKey: string
  credentialPoolOverride?: string | null
}): string {
  const override = credentialPoolOverride?.trim()
  if (override && isValidPoolId(override)) return override
  return poolIdForPersonKey(personKey)
}

/**
 * The pool (and person key) a turn bills to, or undefined when the speaker
 * cannot be keyed (no actor on the turn).
 */
export function resolveTurnBilling({
  personId,
  platform,
  actorId,
  credentialPoolOverride,
}: {
  personId?: string | null
  platform?: string | null
  actorId?: string | null
  credentialPoolOverride?: string | null
}): { personKey: string; poolId: string } | undefined {
  const personKey = personKeyFrom({ personId, platform, actorId })
  if (!personKey) return undefined
  return {
    personKey,
    poolId: resolvePersonPoolId({ personKey, credentialPoolOverride }),
  }
}

/**
 * Pool (and person key) for one person record — the identity hook's person
 * (`person_id` plus its `credential_pool` override) or a bare platform actor.
 * The one shared helper for everything that resolves a person's pool: turn
 * routing (thread-session-runtime, slack-bot) and the /credentials command
 * call this, so a person always lands in the same pool everywhere. undefined
 * when there is no actor id to key.
 */
export function resolvePersonBillingPool({
  person,
  platform,
  actorId,
}: {
  person?: { personId?: string | null; credentialPool?: string | null } | null
  platform?: string | null
  actorId?: string | null
}): { personKey: string; poolId: string } | undefined {
  return resolveTurnBilling({
    personId: person?.personId,
    platform,
    actorId,
    credentialPoolOverride: person?.credentialPool,
  })
}

/**
 * Ordered pool list for one LLM request. `global` is today's behavior: the
 * shared pool only. Without a billed pool (no owner, no actor) the shared
 * pool answers. `per-person-fallback` appends the shared pool after the
 * billed person's pool.
 */
export function resolveBilledPoolList({
  mode,
  billedPoolId,
}: {
  mode: CredentialsMode
  billedPoolId?: string | null
}): string[] {
  if (mode === 'global') return [SHARED_POOL_ID]
  const billed = billedPoolId?.trim()
  if (!billed || !isValidPoolId(billed)) return [SHARED_POOL_ID]
  if (mode === 'per-person') return [billed]
  return billed === SHARED_POOL_ID ? [SHARED_POOL_ID] : [billed, SHARED_POOL_ID]
}

/**
 * Parse the `x-roadie-pool` header value into an ordered pool id list.
 * Tolerates stray whitespace and duplicate entries.
 */
export function parsePoolListHeader(value: string): string[] {
  const pools: string[] = []
  for (const part of value.split(',')) {
    const poolId = part.trim()
    if (poolId && !pools.includes(poolId)) pools.push(poolId)
  }
  return pools
}

/** Unknown or missing values fall back to the defaults (global / owner). */
export function parseCredentialsMode(value: string | undefined | null): CredentialsMode {
  return value === 'per-person' || value === 'per-person-fallback' ? value : 'global'
}

export function parseThreadBilling(value: string | undefined | null): ThreadBilling {
  return value === 'speaker' ? 'speaker' : 'owner'
}

/** Strict variants for CLI flags: an unknown value is a user error. */
export function parseCredentialsModeStrict(value: string): CredentialsMode | Error {
  if (value === 'global' || value === 'per-person' || value === 'per-person-fallback') {
    return value
  }
  return new Error(
    `Invalid credentials mode: ${value}. Use one of: global, per-person, per-person-fallback`,
  )
}

export function parseThreadBillingStrict(value: string): ThreadBilling | Error {
  if (value === 'owner' || value === 'speaker') return value
  return new Error(`Invalid thread billing: ${value}. Use one of: owner, speaker`)
}
