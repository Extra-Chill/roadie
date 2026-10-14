// Headless credential pool host (`roadie credentials serve`, #226).
//
// One pool for many machines: a host runs the pool proxy with no chat
// platform and no agent backend, and every consumer (Roadie bots, Homeboy's
// Pi runner, other Pi clients) reaches it as a registered pool client (#171)
// with its own key. Accounts, OAuth refresh, rotation and 429 cooldowns live
// in this one place, so each refresh token has exactly one holder.
//
// A headless host has no Roadie sessions, so only registered client keys
// authorize; session keys never exist here. Admin clients (--admin) also
// manage the accounts through the admin API (pool-admin.ts, #238).

import { readPoolClients } from './pool-clients.js'
import { localPoolAccounts } from './pool-accounts.js'
import { createPoolAdminHandler } from './pool-admin.js'
import { startMessagesProxy, type MessagesProxy, type MessagesProxyOptions } from './messages-proxy.js'

export const DEFAULT_POOL_SERVE_HOST = '127.0.0.1'

export type PoolServeOptions = {
  dataDir: string
  host?: string
  port: number
} & Pick<MessagesProxyOptions, 'fetchImpl' | 'upstreamUrl' | 'catalog' | 'now' | 'shutdownGraceMs'>

/** Resolve the listen address from flags, then ROADIE_POOL_PROXY_HOST/PORT. A fixed port is required. */
export function resolvePoolServeAddress({
  host,
  port,
  env = process.env,
}: {
  host?: string
  port?: string
  env?: NodeJS.ProcessEnv
}): { host: string; port: number } | Error {
  const rawPort = (port ?? env['ROADIE_POOL_PROXY_PORT'] ?? '').trim()
  if (!rawPort) return new Error('a fixed port is required: pass --port or set ROADIE_POOL_PROXY_PORT (clients are configured with this address)')
  const parsed = Number(rawPort)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return new Error(`port must be 1-65535, got "${rawPort}"`)
  const resolvedHost = (host ?? env['ROADIE_POOL_PROXY_HOST'] ?? '').trim() || DEFAULT_POOL_SERVE_HOST
  return { host: resolvedHost, port: parsed }
}

/**
 * Start the pool proxy for registered clients only. Refuses to start without
 * a registered client: nothing could authenticate against it.
 */
export async function servePool(options: PoolServeOptions): Promise<MessagesProxy | Error> {
  const clients = readPoolClients(options.dataDir)
  if (clients instanceof Error) return clients
  if (clients.length === 0) {
    return new Error('no pool clients are registered; add one with `roadie credentials client add <name>` first')
  }
  const { dataDir, host, port, ...rest } = options
  return startMessagesProxy({
    dataDir,
    host: host ?? DEFAULT_POOL_SERVE_HOST,
    port,
    ...rest,
    // Admin clients manage this host's accounts remotely (#238).
    admin: createPoolAdminHandler({
      dataDir,
      accounts: localPoolAccounts({ dataDir, ...(rest.catalog && { catalog: rest.catalog }) }),
    }),
    // No sessions on a headless host: only registered client keys resolve,
    // and they carry their own pools. This is never consulted for them.
    resolvePools: async () => new Error('a headless pool host has no Roadie sessions'),
  }).catch((cause: unknown) => new Error(`pool proxy failed to listen on ${host ?? DEFAULT_POOL_SERVE_HOST}:${port}`, { cause }))
}
