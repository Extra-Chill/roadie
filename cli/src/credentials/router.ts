// Credential pool router: turn a pool's rotation entries plus its accounts
// and cooldown state into an ordered candidate list.
//
// Pure where possible: resolveCandidates() takes plain data and is fully
// deterministic given `now`. Persistence helpers (markCooldown) delegate to
// the per-pool store. The delegating LanguageModel in credentials/provider.ts
// consumes the candidate list top to bottom, cooling accounts down on a 429
// APICallError.

import * as errore from 'errore'
import {
  isValidPoolId,
  markCooldown as markCooldownInStore,
  readPoolAccounts,
  readPoolRotations,
  readPoolState,
  type PoolAccount,
} from './store.js'

/** A rotation entry like `anthropic/claude-sonnet-4`. */
export type RotationEntry = {
  provider: string
  modelId: string
}

export type PoolCandidate = {
  poolId: string
  provider: string
  modelId: string
  account: PoolAccount
}

/** Split `provider/model` on the first slash; model ids may contain more. */
export function parseRotationEntry(entry: string): RotationEntry | null {
  if (!entry.trim() || /\s/.test(entry)) return null
  const slashIndex = entry.indexOf('/')
  if (slashIndex <= 0 || slashIndex === entry.length - 1) return null
  const provider = entry.slice(0, slashIndex).trim()
  const modelId = entry.slice(slashIndex + 1).trim()
  if (!provider || !modelId) return null
  return { provider, modelId }
}

export function isCoolingDown({
  cooldowns,
  accountId,
  now,
}: {
  cooldowns: Record<string, number>
  accountId: string
  now: number
}): boolean {
  const until = cooldowns[accountId]
  return typeof until === 'number' && until > now
}

/**
 * Ordered candidates: rotation entries tried top to bottom, each paired with
 * the pool's non-cooled accounts of the matching provider in account order.
 */
export function resolveCandidates({
  poolId,
  rotation,
  accounts,
  cooldowns,
  now,
}: {
  poolId: string
  rotation: string[]
  accounts: PoolAccount[]
  cooldowns: Record<string, number>
  now: number
}): PoolCandidate[] {
  const candidates: PoolCandidate[] = []
  for (const entry of rotation) {
    const parsed = parseRotationEntry(entry)
    if (!parsed) continue
    for (const account of accounts) {
      if (account.provider !== parsed.provider) continue
      if (isCoolingDown({ cooldowns, accountId: account.id, now })) continue
      candidates.push({
        poolId,
        provider: parsed.provider,
        modelId: parsed.modelId,
        account,
      })
    }
  }
  return candidates
}

/**
 * Read a pool from disk and resolve the candidates for one of its named
 * rotations. Returns an empty list when the rotation or the pool is empty.
 */
export async function resolvePoolCandidates({
  dataDir,
  poolId,
  rotationName,
  now = Date.now(),
}: {
  dataDir: string
  poolId: string
  rotationName: string
  now?: number
}): Promise<PoolCandidate[] | Error> {
  if (!isValidPoolId(poolId)) {
    return new Error(`Invalid pool id: ${poolId}`)
  }
  const accounts = readPoolAccounts({ dataDir, poolId })
  if (accounts instanceof Error) return accounts
  const rotations = readPoolRotations({ dataDir, poolId })
  if (rotations instanceof Error) return rotations
  const state = readPoolState({ dataDir, poolId })
  if (state instanceof Error) return state
  const rotation = rotations[rotationName] ?? []
  return resolveCandidates({
    poolId,
    rotation,
    accounts,
    cooldowns: state.cooldowns,
    now,
  })
}

/** Cool an account down until `untilMs` (epoch ms). */
export async function markCooldown({
  dataDir,
  poolId,
  accountId,
  untilMs,
}: {
  dataDir: string
  poolId: string
  accountId: string
  untilMs: number
}): Promise<true | Error> {
  return await errore.try({
    try: () => markCooldownInStore({ dataDir, poolId, accountId, untilMs }),
    catch: (cause) => new Error(`Failed to mark cooldown for account ${accountId}`, { cause }),
  })
}
