// Pool host admin API (#238).
//
// A bot that uses a remote pool (ROADIE_POOL_URL) manages the host's accounts
// through these routes, so /credentials and /login work from chat while the
// accounts and their refresh tokens stay on the host. Mounted by the pool host
// (credentials/serve.ts) under POOL_ADMIN_PATH:
//
//   GET    accounts?pool=<id>              listing (secret-free) + rotations
//   POST   accounts/api-key                {pool, provider, key, label?, baseURL?}
//   POST   oauth/start                     {pool, provider, label?} -> {flowId, authorizeUrl}
//   POST   oauth/complete                  {pool, flowId, input}
//   DELETE accounts/<id>?pool=<id>         -> {removed}
//   POST   accounts/reorder                {pool, accountId, position} -> {accounts}
//
// Only registered clients registered with --admin may call it, and only for
// pools in their own `pools` list. Every route delegates to the host's
// PoolAccounts, so the host applies the same validation as its own CLI.
// Responses never carry a key or token. Errors are { error: { message } }.

import type http from 'node:http'
import { POOL_ADMIN_PATH, PROXY_KEY_HEADER, readRawBody } from './messages-proxy.js'
import { resolvePoolClient } from './pool-clients.js'
import { isPoolOAuthProvider, type PoolAccounts } from './pool-accounts.js'

/** Larger bodies are refused; the biggest legitimate one is a pasted redirect URL. */
const MAX_BODY_BYTES = 64 * 1024

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function fail(res: http.ServerResponse, status: number, message: string) {
  reply(res, status, { error: { message } })
}

function str(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function createPoolAdminHandler({
  dataDir,
  accounts,
}: {
  dataDir: string
  accounts: PoolAccounts
}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const key = req.headers[PROXY_KEY_HEADER]
    const client = typeof key === 'string' && key ? resolvePoolClient({ dataDir, key }) : undefined
    if (!client) {
      fail(res, 401, 'unknown or missing roadie client key')
      return
    }
    if (!client.admin) {
      fail(res, 403, `client ${client.name} is not an admin client; register one with roadie credentials client add <name> --admin`)
      return
    }
    const url = new URL(req.url ?? '/', 'http://pool.invalid')
    const route = url.pathname.slice(POOL_ADMIN_PATH.length)

    let body: Record<string, unknown> = {}
    if (req.method === 'POST') {
      const raw = await readRawBody(req)
      if (raw.length > MAX_BODY_BYTES) {
        fail(res, 413, 'request body too large')
        return
      }
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as unknown
        body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      } catch {
        fail(res, 400, 'invalid JSON body')
        return
      }
    }

    const poolId = (req.method === 'POST' ? str(body, 'pool') : url.searchParams.get('pool')?.trim()) || undefined
    if (!poolId) {
      fail(res, 400, 'pool is required')
      return
    }
    if (!client.pools.includes(poolId)) {
      fail(res, 403, `client ${client.name} cannot manage pool ${poolId}`)
      return
    }

    const respond = (status: number, result: unknown) => {
      if (result instanceof Error) fail(res, 400, result.message)
      else reply(res, status, result)
    }

    if (req.method === 'GET' && route === 'accounts') {
      respond(200, await accounts.list({ poolId }))
      return
    }
    if (req.method === 'POST' && route === 'accounts/api-key') {
      const provider = str(body, 'provider')
      const apiKey = str(body, 'key')
      if (!provider || !apiKey) {
        fail(res, 400, 'provider and key are required')
        return
      }
      const label = str(body, 'label')
      const baseURL = str(body, 'baseURL')
      respond(201, await accounts.addApiKey({ poolId, provider, key: apiKey, ...(label && { label }), ...(baseURL && { baseURL }) }))
      return
    }
    if (req.method === 'POST' && route === 'oauth/start') {
      const provider = body['provider']
      if (!isPoolOAuthProvider(provider)) {
        fail(res, 400, 'provider must be anthropic or openai-codex')
        return
      }
      const label = str(body, 'label')
      respond(200, await accounts.startOAuth({ poolId, provider, ...(label && { label }) }))
      return
    }
    if (req.method === 'POST' && route === 'oauth/complete') {
      const flowId = str(body, 'flowId')
      const input = str(body, 'input')
      if (!flowId || !input) {
        fail(res, 400, 'flowId and input are required')
        return
      }
      respond(201, await accounts.completeOAuth({ poolId, flowId, input }))
      return
    }
    if (req.method === 'POST' && route === 'accounts/reorder') {
      const accountId = str(body, 'accountId')
      const position = body['position']
      if (!accountId || typeof position !== 'number') {
        fail(res, 400, 'accountId and a numeric position are required')
        return
      }
      const ordered = await accounts.move({ poolId, accountId, position })
      respond(200, ordered instanceof Error ? ordered : { accounts: ordered })
      return
    }
    if (req.method === 'DELETE' && route.startsWith('accounts/')) {
      const accountId = decodeURIComponent(route.slice('accounts/'.length))
      const removed = await accounts.remove({ poolId, accountId })
      respond(200, removed instanceof Error ? removed : { removed })
      return
    }
    fail(res, 404, 'not found')
  }
}
