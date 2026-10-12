// The pool proxy for HTTP backends (Pi): routing, Claude Code shaping, 429 failover.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { startMessagesProxy, type MessagesProxy } from './messages-proxy.js'
import { addPoolOAuthAccount, readPoolState, setPoolRotation, SHARED_POOL_ID } from './store.js'
import { readSessionRoute } from './routes.js'
import { CLAUDE_CODE_IDENTITY } from './adapters/anthropic-oauth.js'

type Seen = { url: string; headers: Headers; body: Record<string, unknown> }

async function setup(responses: Array<() => Response>) {
  const dataDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-proxy-'))
  const accounts = []
  for (const label of ['a', 'b']) {
    const added = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', label, refresh: `refresh-${label}`, access: `access-${label}`, expires: Date.now() + 3_600_000 })
    if (added instanceof Error) throw added
    accounts.push(added)
  }
  await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'claude-best', entries: ['anthropic/claude-opus-4-8'] })
  const seen: Seen[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    return responses.shift()!()
  }
  const proxy = await startMessagesProxy({ dataDir, resolvePools: async () => SHARED_POOL_ID, fetchImpl })
  return { dataDir, accounts, seen, proxy }
}

let proxy: MessagesProxy | undefined
afterEach(async () => {
  await proxy?.close()
  proxy = undefined
})

const sse = () => new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })

function post(baseUrl: string, key: string | undefined, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'ROADIE_PI_KEY', ...(key && { 'x-roadie-key': key }) },
    body: JSON.stringify(body),
  })
}

describe('messages proxy', () => {
  test('an unknown key is refused before anything goes upstream', async () => {
    const ctx = await setup([])
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, 'nope', { model: 'claude-best', messages: [] })
    expect(response.status).toBe(401)
    expect(ctx.seen).toHaveLength(0)
  })

  test('routes a rotation to an account as Claude Code, streams back, pins the route', async () => {
    const ctx = await setup([sse])
    proxy = ctx.proxy
    const key = ctx.proxy.issueKey(() => 'ses-1')
    const response = await post(ctx.proxy.baseUrl, key, { model: 'claude-best', system: 'You are pi.', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'bash', input_schema: {} }] })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('message_stop')
    const [call] = ctx.seen
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call?.body.model).toBe('claude-opus-4-8')
    expect((call?.body.system as Array<{ text: string }>)[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(call?.headers.get('authorization')).toBe('Bearer access-a')
    expect(call?.headers.get('x-api-key')).toBeNull()
    expect(call?.headers.get('x-roadie-key')).toBeNull()
    expect(call?.headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(readSessionRoute({ dataDir: ctx.dataDir, sessionId: 'ses-1', now: Date.now() })?.accountId).toBe(ctx.accounts[0]!.id)
  })

  test('a 429 cools the account down and the next account answers', async () => {
    const ctx = await setup([() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }), sse])
    proxy = ctx.proxy
    const key = ctx.proxy.issueKey(() => 'ses-2')
    const response = await post(ctx.proxy.baseUrl, key, { model: 'claude-best', messages: [] })
    expect(response.status).toBe(200)
    expect(ctx.seen.map((s) => s.headers.get('authorization'))).toEqual(['Bearer access-a', 'Bearer access-b'])
    const state = readPoolState({ dataDir: ctx.dataDir, poolId: SHARED_POOL_ID })
    if (state instanceof Error) throw state
    expect(state.cooldowns[ctx.accounts[0]!.id]).toBeGreaterThan(Date.now() + 60_000)
  })

  test('a revoked key stops working', async () => {
    const ctx = await setup([])
    proxy = ctx.proxy
    const key = ctx.proxy.issueKey(() => 'ses-3')
    ctx.proxy.revokeKey(key)
    expect((await post(ctx.proxy.baseUrl, key, { model: 'claude-best', messages: [] })).status).toBe(401)
  })
})
