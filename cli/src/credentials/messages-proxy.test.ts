// The pool proxy for HTTP backends (Pi): routing, Claude Code shaping, 429 failover,
// and OpenAI-compatible chat completions for API-key accounts (#176).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { startMessagesProxy, type MessagesProxy } from './messages-proxy.js'
import { addPoolAccount, addPoolOAuthAccount, readPoolState, setPoolRotation, SHARED_POOL_ID } from './store.js'
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

describe('messages proxy: ChatGPT (Codex) accounts', () => {
  const jwt = (accountId: string) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${part({ alg: 'none' })}.${part({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`
  }

  async function codexSetup(responses: Array<() => Response>, { expiresIn = 3_600_000 } = {}) {
    const dataDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-codex-'))
    const accounts = []
    for (const id of ['acct-a', 'acct-b']) {
      const added = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'openai-codex', refresh: `refresh-${id}`, access: jwt(id), expires: Date.now() + expiresIn })
      if (added instanceof Error) throw added
      accounts.push(added)
    }
    const seen: Array<{ url: string; headers: Headers; body: Uint8Array | string }> = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body as Uint8Array })
      return responses.shift()!()
    }
    const codexProxy = await startMessagesProxy({ dataDir, resolvePools: async () => SHARED_POOL_ID, fetchImpl })
    return { dataDir, accounts, seen, proxy: codexProxy }
  }

  const postCodex = (baseUrl: string, key: string, body: Uint8Array) => fetch(`${baseUrl}/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'zstd', authorization: `Bearer ${jwt('roadie-pool')}`, 'chatgpt-account-id': 'roadie-pool', 'x-roadie-key': key, originator: 'pi' },
    body,
  })

  test('swaps in the pool account token and account id; the body passes through byte for byte', async () => {
    const ctx = await codexSetup([sse])
    proxy = ctx.proxy
    const body = new Uint8Array([40, 181, 47, 253, 1, 2, 3])
    const response = await postCodex(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-c1'), body)
    expect(response.status).toBe(200)
    const [call] = ctx.seen
    expect(call?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(call?.headers.get('authorization')).toBe(`Bearer ${jwt('acct-a')}`)
    expect(call?.headers.get('chatgpt-account-id')).toBe('acct-a')
    expect(call?.headers.get('content-encoding')).toBe('zstd')
    expect(call?.headers.get('x-roadie-key')).toBeNull()
    expect(call?.headers.get('originator')).toBe('pi')
    expect(Buffer.from(call!.body as Uint8Array)).toEqual(Buffer.from(body))
  })

  test('a 429 rotates to the next ChatGPT account', async () => {
    const ctx = await codexSetup([() => new Response('{}', { status: 429 }), sse])
    proxy = ctx.proxy
    const response = await postCodex(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-c2'), new Uint8Array([1]))
    expect(response.status).toBe(200)
    expect(ctx.seen.map((s) => s.headers.get('chatgpt-account-id'))).toEqual(['acct-a', 'acct-b'])
  })

  test('an expiring account is refreshed through the Codex token endpoint first', async () => {
    const refreshed = jwt('acct-a')
    const ctx = await codexSetup([
      () => Response.json({ access_token: refreshed, refresh_token: 'refresh-next', expires_in: 3600 }),
      sse,
    ], { expiresIn: 1_000 })
    proxy = ctx.proxy
    const response = await postCodex(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-c3'), new Uint8Array([1]))
    expect(response.status).toBe(200)
    expect(ctx.seen[0]?.url).toBe('https://auth.openai.com/oauth/token')
    expect(String(ctx.seen[0]?.body)).toContain('grant_type=refresh_token')
    expect(String(ctx.seen[0]?.body)).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann')
    expect(ctx.seen[1]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
  })
})

describe('messages proxy: API-key (OpenAI-compatible) accounts', () => {
  const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'

  async function apiKeySetup(responses: Array<() => Response>, { rotationEntries = ['zai-coding-plan/glm-5.3-flash'], provider = 'zai-coding-plan' }: { rotationEntries?: string[]; provider?: string } = {}) {
    const dataDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-apikey-'))
    const accounts = []
    for (const label of ['a', 'b']) {
      const added = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider, key: `zai-key-${label}`, label, ...(provider === 'opencode-go' && { baseURL: ZAI_BASE_URL }) })
      if (added instanceof Error) throw added
      accounts.push(added)
    }
    const anthropicAccount = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', label: 'anthropic', refresh: 'refresh-anthropic', access: 'access-anthropic', expires: Date.now() + 3_600_000 })
    if (anthropicAccount instanceof Error) throw anthropicAccount
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'glm-best', entries: rotationEntries })
    const seen: Seen[] = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return responses.shift()!()
    }
    const apiKeyProxy = await startMessagesProxy({
      dataDir,
      resolvePools: async () => SHARED_POOL_ID,
      fetchImpl,
      catalog: { 'zai-coding-plan': { id: 'zai-coding-plan', api: ZAI_BASE_URL }, 'opencode-go': { id: 'opencode-go', api: ZAI_BASE_URL } },
    })
    return { dataDir, accounts, anthropicAccount, seen, proxy: apiKeyProxy }
  }

  const postChat = (baseUrl: string, key: string, body: Record<string, unknown>) => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer roadie-pool-managed', 'x-roadie-key': key },
    body: JSON.stringify(body),
  })

  test('an API-key rotation answers through the proxy with the pool account key', async () => {
    const ctx = await apiKeySetup([() => Response.json({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' } }] })])
    proxy = ctx.proxy
    const response = await postChat(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-k1'), { model: 'glm-best', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-1' })
    const [call] = ctx.seen
    expect(call?.url).toBe(`${ZAI_BASE_URL}/chat/completions`)
    expect(call?.body.model).toBe('glm-5.3-flash')
    expect(call?.headers.get('authorization')).toBe('Bearer zai-key-a')
    expect(call?.headers.get('x-api-key')).toBeNull()
    expect(call?.headers.get('x-roadie-key')).toBeNull()
    expect(readSessionRoute({ dataDir: ctx.dataDir, sessionId: 'ses-k1', now: Date.now() })?.accountId).toBe(ctx.accounts[0]!.id)
  })

  test('a 429 cools the account down and the next API-key account answers', async () => {
    const ctx = await apiKeySetup([() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }), () => Response.json({ choices: [] })])
    proxy = ctx.proxy
    const response = await postChat(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-k2'), { model: 'glm-best', messages: [] })
    expect(response.status).toBe(200)
    expect(ctx.seen.map((s) => s.headers.get('authorization'))).toEqual(['Bearer zai-key-a', 'Bearer zai-key-b'])
    const state = readPoolState({ dataDir: ctx.dataDir, poolId: SHARED_POOL_ID })
    if (state instanceof Error) throw state
    expect(state.cooldowns[ctx.accounts[0]!.id]).toBeGreaterThan(Date.now() + 60_000)
  })

  test('a mixed rotation falls through only within the OpenAI-compatible format', async () => {
    const ctx = await apiKeySetup([() => Response.json({ choices: [] })], { rotationEntries: ['anthropic/claude-opus-4-8', 'zai-coding-plan/glm-5.3-flash'] })
    proxy = ctx.proxy
    const response = await postChat(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-k3'), { model: 'glm-best', messages: [] })
    expect(response.status).toBe(200)
    expect(ctx.seen).toHaveLength(1)
    expect(ctx.seen[0]?.headers.get('authorization')).toBe('Bearer zai-key-a')
  })

  test('adds a stable opaque OpenCode Go session header derived from the pool session', async () => {
    const ctx = await apiKeySetup([() => Response.json({ choices: [] }), () => Response.json({ choices: [] }), () => Response.json({ choices: [] })], {
      rotationEntries: ['opencode-go/glm-5.3-flash'], provider: 'opencode-go',
    })
    proxy = ctx.proxy
    const postFor = (sessionId: string) => postChat(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => sessionId), { model: 'glm-best', messages: [] })
    await postFor('same-session')
    await postFor('same-session')
    await postFor('other-session')
    const values = ctx.seen.map((call) => call.headers.get('x-opencode-session'))
    expect(values[0]).toMatch(/^[a-f0-9]{32}$/)
    expect(values[1]).toBe(values[0])
    expect(values[2]).not.toBe(values[0])
  })

  test('does not add OpenCode Go session header for other providers and preserves a client value', async () => {
    const ctx = await apiKeySetup([() => Response.json({ choices: [] }), () => Response.json({ choices: [] })])
    proxy = ctx.proxy
    await postChat(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-no-opencode'), { model: 'glm-best', messages: [] })
    expect(ctx.seen[0]?.headers.has('x-opencode-session')).toBe(false)
    await ctx.proxy.close()
    const opencode = await apiKeySetup([() => Response.json({ choices: [] })], { rotationEntries: ['opencode-go/glm-5.3-flash'], provider: 'opencode-go' })
    proxy = opencode.proxy
    const response = await fetch(`${opencode.proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-roadie-key': opencode.proxy.issueKey(() => 'ses-client'), 'x-opencode-session': 'client-session' },
      body: JSON.stringify({ model: 'glm-best', messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(opencode.seen[0]?.headers.get('x-opencode-session')).toBe('client-session')
  })
})
