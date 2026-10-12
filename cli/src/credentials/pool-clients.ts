// Registered external clients of the credential-pool proxy (#171).
//
// A Pi process that is not a Roadie session (a Homeboy agent-task on a Lab
// runner, a script) still bills through the pools, so its requests get the
// same routing, OAuth refresh and 429 cooldown as Pi channels. It holds a
// client key, never a credential: the proxy maps the key to the client's own
// pool list and a stable synthetic session id (`client:<name>`), so route
// pinning and last-used behave per client.
//
// Stored at <dataDir>/credentials/clients.json (0600). Only a SHA-256 of each
// key is kept; the key itself is printed once by `client add`.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  atomicWriteFileSync,
  CREDENTIALS_DIR_MODE,
  isValidPoolId,
  SHARED_POOL_ID,
} from './store.js'

export const POOL_CLIENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** Synthetic session id prefix for registered clients. */
export const POOL_CLIENT_SESSION_PREFIX = 'client:'

export type PoolClient = {
  name: string
  /** sha256 hex of the client key. */
  keyHash: string
  pools: string[]
  createdAt: number
}

type ClientsFile = { version: 1; clients: PoolClient[] }

export function poolClientsPath(dataDir: string): string {
  return path.join(dataDir, 'credentials', 'clients.json')
}

export function hashPoolClientKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export function readPoolClients(dataDir: string): PoolClient[] | Error {
  const filePath = poolClientsPath(dataDir)
  if (!fs.existsSync(filePath)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ClientsFile>
    return Array.isArray(parsed.clients) ? parsed.clients : []
  } catch (cause) {
    return new Error(`read ${filePath}`, { cause })
  }
}

function writePoolClients(dataDir: string, clients: PoolClient[]): void {
  fs.mkdirSync(path.join(dataDir, 'credentials'), { recursive: true, mode: CREDENTIALS_DIR_MODE })
  const data: ClientsFile = { version: 1, clients }
  atomicWriteFileSync({ filePath: poolClientsPath(dataDir), data: `${JSON.stringify(data, null, 2)}\n` })
}

/** Register a client. Returns its key (shown once) or an Error. */
export function addPoolClient({
  dataDir,
  name,
  pools = [SHARED_POOL_ID],
  now = Date.now(),
}: {
  dataDir: string
  name: string
  pools?: string[]
  now?: number
}): { client: PoolClient; key: string } | Error {
  if (!POOL_CLIENT_NAME_PATTERN.test(name)) return new Error(`invalid client name "${name}"`)
  const poolIds = pools.length > 0 ? pools : [SHARED_POOL_ID]
  const invalid = poolIds.find((poolId) => !isValidPoolId(poolId))
  if (invalid) return new Error(`invalid pool id "${invalid}"`)
  const existing = readPoolClients(dataDir)
  if (existing instanceof Error) return existing
  if (existing.some((client) => client.name === name)) return new Error(`client "${name}" already exists; remove it first`)
  const key = `rpc_${crypto.randomBytes(24).toString('hex')}`
  const client: PoolClient = { name, keyHash: hashPoolClientKey(key), pools: [...new Set(poolIds)], createdAt: now }
  writePoolClients(dataDir, [...existing, client])
  return { client, key }
}

export function removePoolClient({ dataDir, name }: { dataDir: string; name: string }): boolean | Error {
  const existing = readPoolClients(dataDir)
  if (existing instanceof Error) return existing
  const remaining = existing.filter((client) => client.name !== name)
  if (remaining.length === existing.length) return false
  writePoolClients(dataDir, remaining)
  return true
}

/** The registered client a presented key belongs to, if any. Read per request, so removal is immediate. */
export function resolvePoolClient({ dataDir, key }: { dataDir: string; key: string }): PoolClient | undefined {
  const clients = readPoolClients(dataDir)
  if (clients instanceof Error || clients.length === 0) return undefined
  const presented = Buffer.from(hashPoolClientKey(key), 'hex')
  return clients.find((client) => {
    const stored = Buffer.from(client.keyHash, 'hex')
    return stored.length === presented.length && crypto.timingSafeEqual(stored, presented)
  })
}

export function poolClientSessionId(name: string): string {
  return `${POOL_CLIENT_SESSION_PREFIX}${name}`
}
