// Per-person MCP OAuth credentials.
//
// A person's sessions can talk to an MCP server as that person. The token for
// each (person, credential) pair lives in its own file:
//
//   <dataDir>/mcp-credentials/<person dir>/<credential>.json   (mode 0600)
//
// The person dir comes from poolIdForPersonKey, the same derivation credential
// pools use, so a person key maps to one directory and two different people can
// never share one. Directories are 0700 and writes go through the pool store's
// temp-file + rename helper, so the secret is never world-readable, even
// briefly. Tokens are never logged or returned by listing helpers.
//
// Refresh: when the access token is near expiry and the record holds a refresh
// token plus the token endpoint, the refresh runs under a per-record lock that
// re-reads the file first. The rotated refresh token is persisted before the
// new access token is handed out, because servers may invalidate the old one.
//
// Like the pool store, this stays dependency-light (node builtins, errore, the
// pool store) and takes the data directory explicitly.

import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'
import { poolIdForPersonKey } from './person-pool.js'
import { atomicWriteFileSync, withPoolLock } from './store.js'

/** Server names and credential references: safe in file names and tool ids. */
export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/

const REFRESH_SKEW_MS = 60_000
const REFRESH_TIMEOUT_MS = 15_000

export type PersonMcpToken = {
  access: string
  /** Epoch ms after which `access` is expired. Absent: never expires. */
  expires?: number
  refresh?: string
  /** OAuth token endpoint used to refresh. Without it the token cannot refresh. */
  tokenEndpoint?: string
  clientId?: string
  clientSecret?: string
  updatedAt: string
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/** https, or http for loopback (local development servers). */
export function isAllowedMcpUrl(value: string): boolean {
  const url = errore.try({ try: () => new URL(value), catch: () => null })
  if (!url) return false
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

export function personMcpDir({ dataDir, personKey }: { dataDir: string; personKey: string }): string {
  return path.join(dataDir, 'mcp-credentials', poolIdForPersonKey(personKey))
}

function tokenPath({ dataDir, personKey, credential }: { dataDir: string; personKey: string; credential: string }): string {
  return path.join(personMcpDir({ dataDir, personKey }), `${credential}.json`)
}

function lockKey({ dataDir, personKey, credential }: { dataDir: string; personKey: string; credential: string }): string {
  return `mcp:${tokenPath({ dataDir, personKey, credential })}`
}

function normalizeToken(value: unknown): PersonMcpToken | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.access !== 'string' || !record.access) return null
  const optionalString = (field: string) =>
    typeof record[field] === 'string' && record[field] ? (record[field] as string) : undefined
  return {
    access: record.access,
    ...(typeof record.expires === 'number' && Number.isFinite(record.expires) ? { expires: record.expires } : {}),
    ...(optionalString('refresh') ? { refresh: optionalString('refresh')! } : {}),
    ...(optionalString('tokenEndpoint') ? { tokenEndpoint: optionalString('tokenEndpoint')! } : {}),
    ...(optionalString('clientId') ? { clientId: optionalString('clientId')! } : {}),
    ...(optionalString('clientSecret') ? { clientSecret: optionalString('clientSecret')! } : {}),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

function readTokenFile(filePath: string): PersonMcpToken | null {
  const parsed = errore.try({
    try: () => JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown,
    catch: () => null,
  })
  return normalizeToken(parsed)
}

function validateRef({ personKey, credential }: { personKey: string; credential: string }): Error | null {
  if (!personKey.trim()) return new Error('Person key is required')
  if (!MCP_NAME_PATTERN.test(credential)) return new Error(`Invalid MCP credential name: ${credential}`)
  return null
}

/** Store (replace) a person's token for one MCP credential. */
export async function setPersonMcpToken({
  dataDir,
  personKey,
  credential,
  token,
  now = new Date(),
}: {
  dataDir: string
  personKey: string
  credential: string
  token: Omit<PersonMcpToken, 'updatedAt'>
  now?: Date
}): Promise<void | Error> {
  const invalid = validateRef({ personKey, credential })
  if (invalid) return invalid
  if (!token.access.trim()) return new Error('Access token is required')
  if (token.tokenEndpoint && !isAllowedMcpUrl(token.tokenEndpoint)) {
    return new Error('Token endpoint must be https (http only for loopback)')
  }
  return await withPoolLock(lockKey({ dataDir, personKey, credential }), () => {
    atomicWriteFileSync({
      filePath: tokenPath({ dataDir, personKey, credential }),
      data: JSON.stringify({ ...token, updatedAt: now.toISOString() }, null, 2),
    })
  })
}

/** Remove a person's stored token. Returns false when there was none. */
export async function removePersonMcpToken({
  dataDir,
  personKey,
  credential,
}: {
  dataDir: string
  personKey: string
  credential: string
}): Promise<boolean | Error> {
  const invalid = validateRef({ personKey, credential })
  if (invalid) return invalid
  return await withPoolLock(lockKey({ dataDir, personKey, credential }), () => {
    const filePath = tokenPath({ dataDir, personKey, credential })
    if (!fs.existsSync(filePath)) return false
    fs.rmSync(filePath)
    return true
  })
}

/** Names of the credentials a person has stored (never their contents). */
export function listPersonMcpCredentials({ dataDir, personKey }: { dataDir: string; personKey: string }): string[] {
  const dir = personMcpDir({ dataDir, personKey })
  const entries = errore.try({ try: () => fs.readdirSync(dir), catch: () => [] as string[] })
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .filter((name) => MCP_NAME_PATTERN.test(name))
    .sort()
}

async function refreshToken({
  token,
  now,
  fetchImpl,
}: {
  token: PersonMcpToken
  now: number
  fetchImpl: FetchLike
}): Promise<PersonMcpToken | Error> {
  if (!token.refresh || !token.tokenEndpoint) {
    return new Error('MCP token expired and cannot be refreshed')
  }
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh })
  if (token.clientId) body.set('client_id', token.clientId)
  if (token.clientSecret) body.set('client_secret', token.clientSecret)
  const response = await fetchImpl(token.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  }).catch((e: unknown) => new Error('MCP token refresh request failed', { cause: e }))
  if (response instanceof Error) return response
  if (!response.ok) return new Error(`MCP token refresh rejected (HTTP ${response.status})`)
  const data = await response.json().catch(() => null)
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (typeof record.access_token !== 'string' || !record.access_token) {
    return new Error('MCP token refresh returned no access token')
  }
  const expiresIn = typeof record.expires_in === 'number' && record.expires_in > 0 ? record.expires_in : undefined
  return {
    ...token,
    access: record.access_token,
    // Servers that rotate refresh tokens return a new one; keep the old one otherwise.
    refresh: typeof record.refresh_token === 'string' && record.refresh_token ? record.refresh_token : token.refresh,
    ...(expiresIn ? { expires: now + expiresIn * 1000 } : { expires: undefined }),
    updatedAt: new Date(now).toISOString(),
  }
}

/**
 * The person's current access token for one credential, refreshing it under
 * the record's lock when it is expired or about to be. Returns null when the
 * person has no such credential, an Error when it exists but cannot be used.
 */
export async function getPersonMcpAccessToken({
  dataDir,
  personKey,
  credential,
  now = Date.now(),
  fetchImpl = fetch as FetchLike,
}: {
  dataDir: string
  personKey: string
  credential: string
  now?: number
  fetchImpl?: FetchLike
}): Promise<string | null | Error> {
  const invalid = validateRef({ personKey, credential })
  if (invalid) return invalid
  const filePath = tokenPath({ dataDir, personKey, credential })
  const fresh = (token: PersonMcpToken) => token.expires === undefined || token.expires - REFRESH_SKEW_MS > now
  // Lock-free fast path: the common case is a valid token.
  const quick = readTokenFile(filePath)
  if (!quick) return null
  if (fresh(quick)) return quick.access

  return await withPoolLock(lockKey({ dataDir, personKey, credential }), async () => {
    // Re-read under the lock: another turn may have refreshed already.
    const current = readTokenFile(filePath)
    if (!current) return null
    if (fresh(current)) return current.access
    const refreshed = await refreshToken({ token: current, now, fetchImpl })
    if (refreshed instanceof Error) return refreshed
    atomicWriteFileSync({ filePath, data: JSON.stringify(refreshed, null, 2) })
    return refreshed.access
  })
}
