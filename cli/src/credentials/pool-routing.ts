// Credential pool routing shared by Pi's pool proxy (./messages-proxy.ts) and
// the pool lock child (./pool-lock-child.ts).
//
// - resolvePoolListCandidates resolves a request's ordered pool list into
//   candidates through the per-pool rotation, cooldowns and accounts
//   (./router.js). An unusable pool is skipped; the next pool answers.
// - heldCandidate applies turn affinity: when the session holds a live route
//   (./routes.ts) whose candidate is still resolved, it is tried first, so tool
//   follow-ups stay on one account until the session is idle.
// - ensureFreshOAuthAccount refreshes an OAuth account under the pool lock
//   before it is used, and cools it down on a permanent refresh failure.
// - makeAnthropicOAuthFetch shapes an Anthropic OAuth request as Claude Code
//   (./adapters/anthropic-oauth.ts).
// - cooldownUntilFromRetryAfter turns a 429's `retry-after` into a cooldown.
//
// State lives in <dataDir>/credentials/ via ./store.ts.

import {
  markCooldownLocked,
  readPoolAccounts,
  readPoolRotations,
  readPoolState,
  updatePoolAccountLocked,
  withPoolLockAt,
  type PoolAccount,
} from './store.js'
import { resolveCandidates, type PoolCandidate } from './router.js'
import { readSessionRoute } from './routes.js'
import {
  applyAnthropicOAuthRequestHeaders,
  isPermanentRefreshFailure,
  refreshAnthropicToken,
  rewriteRequestPayload,
  wrapResponseStream,
} from './adapters/anthropic-oauth.js'
import { refreshCodexToken } from './adapters/openai-codex-oauth.js'
import { refreshXaiToken } from './adapters/xai-oauth.js'

/** OAuth providers the pool can refresh, by pool provider id. */
const OAUTH_REFRESHERS: Record<string, (input: { refreshToken: string; fetchImpl: PoolFetch }) => Promise<{ refresh: string; access: string; expires: number } | Error>> = {
  anthropic: refreshAnthropicToken,
  xai: refreshXaiToken,
  'openai-codex': refreshCodexToken,
}

/** Model provider id under which `roadie/<rotation>` pool models are served. */
export const ROADIE_PROVIDER_ID = 'roadie'
/**
 * After the subrouter handoff, `subrouter/<rotation>` model choices resolve
 * like `roadie/<rotation>`, so host configs that still name subrouter models
 * keep working.
 */
export const SUBROUTER_ALIAS_PROVIDER_ID = 'subrouter'

const DEFAULT_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** Refresh an OAuth access token when it expires within this window. */
const OAUTH_REFRESH_LEAD_MS = 60_000
/** Cooldown after a permanent (HTTP 400/401) refresh failure. */
const OAUTH_REFRESH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000

/** `retry-after` seconds when parseable (capped), else the 60s default. */
export function cooldownUntilFromRetryAfter({ retryAfter, now }: { retryAfter: string | null; now: number }): number {
  const seconds = Number.parseFloat(retryAfter ?? '')
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(now + Math.round(seconds * 1000), now + MAX_COOLDOWN_MS)
  }
  return now + DEFAULT_COOLDOWN_MS
}

export type PoolFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Refresh an OAuth account whose access token expires within
 * OAUTH_REFRESH_LEAD_MS. The check-and-refresh runs inside withPoolLock and
 * re-reads the account under the lock, so concurrent requests on one pool
 * trigger at most one refresh and every request sees the rotated tokens
 * (including the rotated refresh token, written back with
 * updatePoolAccountLocked while the lock is held).
 *
 * A refresh rejected with HTTP 400/401 (revoked or expired refresh token)
 * cools the account down for OAUTH_REFRESH_FAILURE_COOLDOWN_MS and the caller
 * moves on to the next candidate. Any other failure skips the candidate for
 * this request without a cooldown. A returned Error never escapes as a crash;
 * it only means "skip this candidate".
 */
export async function ensureFreshOAuthAccount({
  dataDir,
  poolId,
  account,
  now,
  fetchImpl,
}: {
  dataDir: string
  poolId: string
  account: PoolAccount
  now: number
  fetchImpl: PoolFetch
}): Promise<PoolAccount | Error> {
  try {
    // Refresh dispatches per provider through OAUTH_REFRESHERS; oauth
    // providers without a registered adapter are served as-is.
    if (account.type !== 'oauth' || !OAUTH_REFRESHERS[account.provider]) return account
    if (account.expires > now + OAUTH_REFRESH_LEAD_MS) return account
    return await withPoolLockAt(dataDir, poolId, async () => {
      // Re-read under the lock: a concurrent request may have refreshed already.
      const accounts = readPoolAccounts({ dataDir, poolId })
      if (accounts instanceof Error) return accounts
      const latest = accounts.find((entry) => entry.id === account.id)
      if (!latest) {
        return new Error(`oauth account ${account.id} disappeared from pool ${poolId}`)
      }
      if (latest.type !== 'oauth') {
        return new Error(`account ${latest.id} is no longer an oauth account`)
      }
      if (latest.expires > now + OAUTH_REFRESH_LEAD_MS) return latest
      const refreshed = await OAUTH_REFRESHERS[latest.provider]!({ refreshToken: latest.refresh, fetchImpl })
      if (refreshed instanceof Error) {
        if (isPermanentRefreshFailure(refreshed)) {
          const cooldown = markCooldownLocked({
            dataDir,
            poolId,
            accountId: latest.id,
            untilMs: now + OAUTH_REFRESH_FAILURE_COOLDOWN_MS,
          })
          if (cooldown instanceof Error) {
            // Swallowed on purpose: losing the cooldown write only means the
            // dead account is retried on a later request.
          }
        }
        return refreshed
      }
      return updatePoolAccountLocked({
        dataDir,
        poolId,
        accountId: latest.id,
        refresh: refreshed.refresh,
        access: refreshed.access,
        expires: refreshed.expires,
      })
    })
  } catch (cause) {
    // A store write failure or anything else unexpected must never crash the
    // request: the caller just skips to the next candidate.
    return new Error(`oauth refresh for account ${account.id} failed`, { cause })
  }
}

/**
 * Resolved candidates for one pool in the request's list, or why the pool was
 * skipped. An unusable pool (empty, cooling down, or missing the rotation)
 * never fails the request on its own: the next pool answers, and only when
 * every listed pool is unusable does the request fail.
 */
export type PoolResolution =
  | { poolId: string; candidates: PoolCandidate[] }
  | { poolId: string; candidates: PoolCandidate[]; skipped: string }

export function resolvePoolListCandidates({
  poolIds,
  dataDir,
  rotationName,
  now,
}: {
  poolIds: string[]
  dataDir: string
  rotationName: string
  now: number
}): PoolResolution[] {
  return poolIds.map((poolId) => {
    const accounts = readPoolAccounts({ dataDir, poolId })
    if (accounts instanceof Error) {
      return { poolId, candidates: [], skipped: accounts.message }
    }
    if (accounts.length === 0) {
      return { poolId, candidates: [], skipped: `pool ${poolId} has no accounts` }
    }
    const rotations = readPoolRotations({ dataDir, poolId })
    if (rotations instanceof Error) {
      return { poolId, candidates: [], skipped: rotations.message }
    }
    const rotation = rotations[rotationName] ?? []
    if (rotation.length === 0) {
      return {
        poolId,
        candidates: [],
        skipped: `pool ${poolId} has no rotation named ${rotationName}`,
      }
    }
    const state = readPoolState({ dataDir, poolId })
    if (state instanceof Error) {
      return { poolId, candidates: [], skipped: state.message }
    }
    return {
      poolId,
      candidates: resolveCandidates({
        poolId,
        rotation,
        accounts,
        cooldowns: state.cooldowns,
        now,
      }),
    }
  })
}

/**
 * Anthropic OAuth shaping fetch, ported from the old wire-level candidate
 * shaping: `authorization: Bearer` with `x-api-key` removed, the merged beta
 * header, the Claude Code system prefix and tool-name rewrite in the request
 * body, and the tool-name reversal in the streamed response.
 */
export function makeAnthropicOAuthFetch({
  accessToken,
  modelId,
  fetchImpl,
}: {
  accessToken: string
  modelId: string
  fetchImpl: PoolFetch
}): PoolFetch {
  const oauthFetch: PoolFetch = async (input, init = {}) => {
    // Mirrors @subrouter/cli's anthropic buildFetch: the body may arrive on a
    // Request rather than init.body, and must be shaped either way or the
    // request goes out without the Claude Code signature.
    const originalBody =
      typeof init.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input
              .clone()
              .text()
              .catch(() => undefined)
          : undefined
    const shaped = rewriteRequestPayload(originalBody)
    const headers = new Headers(init.headers)
    if (input instanceof Request) {
      input.headers.forEach((value, name) => {
        if (!headers.has(name)) headers.set(name, value)
      })
    }
    applyAnthropicOAuthRequestHeaders({ headers, accessToken, modelId: shaped.modelId ?? modelId })
    headers.delete('content-length')
    const response = await fetchImpl(input, { ...init, headers, body: shaped.body ?? init.body })
    return wrapResponseStream(response, shaped.reverseToolNameMap)
  }
  return oauthFetch
}

/**
 * The resolved candidate a session's held route points at, or null. The route
 * only applies when it was pinned under this rotation and its exact
 * (pool, account, provider, model) is still in the resolved candidate list:
 * a cooling-down or removed account never pins, a pool that fell out of the
 * request's list never pins, and a /model switch (a different rotation name)
 * starts a fresh resolution. The candidate set itself is never expanded, so
 * fail-closed 401s and fallback lists behave exactly as without affinity.
 */
export function heldCandidate({
  sessionId,
  rotationName,
  candidates,
  dataDir,
  now,
}: {
  sessionId: string | null
  rotationName: string
  candidates: PoolCandidate[]
  dataDir: string
  now: number
}): PoolCandidate | null {
  if (!sessionId) return null
  const route = readSessionRoute({ dataDir, sessionId, now })
  if (!route || route.rotation !== rotationName) return null
  return (
    candidates.find(
      (candidate) =>
        candidate.poolId === route.poolId &&
        candidate.account.id === route.accountId &&
        candidate.provider === route.provider &&
        candidate.modelId === route.modelId,
    ) ?? null
  )
}
