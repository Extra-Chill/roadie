// The pool proxy for HTTP backends (Pi): routing, Claude Code shaping, 429 failover,
// and every rotation entry behind one Anthropic Messages endpoint (#276).

import fs from 'node:fs'
import zlib from 'node:zlib'
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


// ---------------------------------------------------------------------------
// One endpoint, every wire format (#276): API-key and ChatGPT candidates are
// translated, and a rotation falls through its entries whatever their format.

const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'

const jwt = (accountId: string) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`
}

const sseBody = (events: unknown[], { done = false } = {}) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

/** A chat-completions stream: optional text, optional tool call, then usage. */
function chatStream({ text, tool }: { text?: string; tool?: { id: string; name: string; args: string } } = { text: 'ok' }) {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'glm-5.3-flash', choices: [{ index: 0, delta, finish_reason: finish }] })
  return () => sseBody([
    chunk({ role: 'assistant' }),
    ...(text ? [chunk({ content: text })] : []),
    ...(tool ? [chunk({ tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args } }] })] : []),
    chunk({}, tool ? 'tool_calls' : 'stop'),
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'glm-5.3-flash', choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
  ], { done: true })
}

/** A Codex Responses stream with one text message. */
function codexStream(text: string) {
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return () => sseBody([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg_1', part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } } },
  ])
}

type Call = { url: string; headers: Headers; body: string }

async function mixedSetup(responses: Array<() => Response>, {
  rotation,
  zai = ['a', 'b'],
  opencode = false,
  anthropic = false,
  codex = false,
  codexExpiresIn = 3_600_000,
}: { rotation: string[]; zai?: string[]; opencode?: boolean; anthropic?: boolean; codex?: boolean; codexExpiresIn?: number }) {
  const dataDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-mixed-'))
  const ids: Record<string, string> = {}
  const add = async (label: string, added: Promise<{ id: string } | Error>) => {
    const account = await added
    if (account instanceof Error) throw account
    ids[label] = account.id
  }
  for (const label of zai) await add(`zai-${label}`, addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'zai-coding-plan', key: `zai-key-${label}`, label }))
  if (opencode) await add('opencode', addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'opencode-go', key: 'opencode-key', baseURL: 'https://opencode.ai/zen/go/v1' }))
  if (anthropic) await add('anthropic', addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', label: 'anthropic', refresh: 'refresh-anthropic', access: 'access-anthropic', expires: Date.now() + 3_600_000 }))
  if (codex) await add('codex', addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'openai-codex', refresh: 'refresh-codex', access: jwt('acct-a'), expires: Date.now() + codexExpiresIn }))
  await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'subagent', entries: rotation })
  const seen: Call[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : init?.body instanceof Uint8Array ? zlib.zstdDecompressSync(init.body).toString('utf8') : String(init?.body ?? '') })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected upstream call ${String(input)}`)
    return next()
  }
  const mixed = await startMessagesProxy({
    dataDir,
    resolvePools: async () => SHARED_POOL_ID,
    fetchImpl,
    catalog: { 'zai-coding-plan': { id: 'zai-coding-plan', api: ZAI_BASE_URL } },
  })
  return { dataDir, ids, seen, proxy: mixed }
}

/** Parse an Anthropic SSE stream into its events. */
async function anthropicEvents(response: Response): Promise<Array<Record<string, any>>> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
}

const request = (overrides: Record<string, unknown> = {}) => ({
  model: 'subagent',
  stream: true,
  max_tokens: 1024,
  system: [{ type: 'text', text: 'You are pi.' }],
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
})

describe('messages proxy: API-key candidates, translated', () => {
  test('z.ai answers an Anthropic request as chat completions and streams back Anthropic events', async () => {
    const ctx = await mixedSetup([chatStream({ text: 'hello there' })], { rotation: ['zai-coding-plan/glm-5.3-flash'] })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-z1'), request({
      tools: [{ name: 'bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const events = await anthropicEvents(response)
    expect(events.map((event) => event.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(events[2]?.delta).toEqual({ type: 'text_delta', text: 'hello there' })
    expect(events[4]).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 11, output_tokens: 3 } })
    const [call] = ctx.seen
    expect(call?.url).toBe(`${ZAI_BASE_URL}/chat/completions`)
    expect(call?.headers.get('authorization')).toBe('Bearer zai-key-a')
    expect(call?.headers.get('x-roadie-key')).toBeNull()
    const body = JSON.parse(call!.body) as Record<string, any>
    expect(body.model).toBe('glm-5.3-flash')
    // z.ai's compat: a system (not developer) message, no store, max_tokens.
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are pi.' })
    expect(body.messages.some((message: { role: string }) => message.role === 'developer')).toBe(false)
    expect(body.store).toBeUndefined()
    expect(body.max_tokens).toBe(1024)
    expect(body.tools[0].function.name).toBe('bash')
    expect(readSessionRoute({ dataDir: ctx.dataDir, sessionId: 'ses-z1', now: Date.now() })?.accountId).toBe(ctx.ids['zai-a'])
  })

  test('tool history goes up as tool calls and results; a new tool call comes back as tool_use', async () => {
    const ctx = await mixedSetup([chatStream({ tool: { id: 'call:7', name: 'bash', args: '{"command":"ls"}' } })], { rotation: ['zai-coding-plan/glm-5.3-flash'] })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-z2'), request({
      messages: [
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should look', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'pwd' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/home' }] },
      ],
      tools: [{ name: 'bash', input_schema: { type: 'object' } }],
    }))
    const events = await anthropicEvents(response)
    const toolStart = events.find((event) => event.type === 'content_block_start')
    expect(toolStart?.content_block).toEqual({ type: 'tool_use', id: 'call_7', name: 'bash', input: {} })
    expect(events.find((event) => event.type === 'content_block_delta')?.delta).toEqual({ type: 'input_json_delta', partial_json: '{"command":"ls"}' })
    expect(events.find((event) => event.type === 'message_delta')?.delta.stop_reason).toBe('tool_use')
    const body = JSON.parse(ctx.seen[0]!.body) as { messages: Array<Record<string, any>> }
    const assistant = body.messages.find((message) => message.role === 'assistant')
    expect(assistant?.tool_calls[0]).toMatchObject({ id: 'toolu_1', function: { name: 'bash', arguments: '{"command":"pwd"}' } })
    expect(body.messages.find((message) => message.role === 'tool')).toMatchObject({ tool_call_id: 'toolu_1', content: '/home' })
  })

  test('a non-streaming request gets one Anthropic message', async () => {
    const ctx = await mixedSetup([chatStream({ text: 'whole' })], { rotation: ['zai-coding-plan/glm-5.3-flash'] })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-z3'), request({ stream: false }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'whole' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 3 } })
  })

  test('a 429 cools the account down and the next API-key account answers', async () => {
    const ctx = await mixedSetup([() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }), chatStream()], { rotation: ['zai-coding-plan/glm-5.3-flash'] })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-z4'), request())
    expect(response.status).toBe(200)
    expect(ctx.seen.map((call) => call.headers.get('authorization'))).toEqual(['Bearer zai-key-a', 'Bearer zai-key-b'])
    const state = readPoolState({ dataDir: ctx.dataDir, poolId: SHARED_POOL_ID })
    if (state instanceof Error) throw state
    expect(state.cooldowns[ctx.ids['zai-a']!]).toBeGreaterThan(Date.now() + 60_000)
  })

  test('a request error (400) goes back to the client without trying the next candidate', async () => {
    const ctx = await mixedSetup([() => Response.json({ error: { message: 'bad request' } }, { status: 400 })], { rotation: ['zai-coding-plan/glm-5.3-flash'] })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-z5'), request())
    expect(response.status).toBe(400)
    expect(ctx.seen).toHaveLength(1)
  })

  test('OpenCode Go gets a stable opaque session header derived from the pool session', async () => {
    const ctx = await mixedSetup([chatStream(), chatStream(), chatStream()], { rotation: ['opencode-go/glm-5.3-flash'], zai: [], opencode: true })
    proxy = ctx.proxy
    for (const sessionId of ['same-session', 'same-session', 'other-session']) {
      await (await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => sessionId), request())).text()
    }
    expect(ctx.seen[0]?.url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    const values = ctx.seen.map((call) => call.headers.get('x-opencode-session'))
    expect(values[0]).toMatch(/^[a-f0-9]{32}$/)
    expect(values[1]).toBe(values[0])
    expect(values[2]).not.toBe(values[0])
  })
})

describe('messages proxy: ChatGPT (Codex) candidates, translated', () => {
  test('an openai/ entry runs on the ChatGPT account as Codex Responses', async () => {
    const ctx = await mixedSetup([codexStream('from codex')], { rotation: ['openai/gpt-6-luna'], zai: [], codex: true })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-c1'), request())
    expect(response.status).toBe(200)
    const events = await anthropicEvents(response)
    expect(events.find((event) => event.type === 'content_block_delta')?.delta).toEqual({ type: 'text_delta', text: 'from codex' })
    expect(events.at(-1)?.type).toBe('message_stop')
    const [call] = ctx.seen
    expect(call?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(call?.headers.get('authorization')).toBe(`Bearer ${jwt('acct-a')}`)
    expect(call?.headers.get('chatgpt-account-id')).toBe('acct-a')
    const body = JSON.parse(call!.body) as Record<string, unknown>
    expect(body.model).toBe('gpt-6-luna')
    expect(body.instructions).toBe('You are pi.')
    expect(readSessionRoute({ dataDir: ctx.dataDir, sessionId: 'ses-c1', now: Date.now() })?.provider).toBe('openai-codex')
  })

  test('an expiring ChatGPT account is refreshed through the Codex token endpoint first', async () => {
    const ctx = await mixedSetup([
      () => Response.json({ access_token: jwt('acct-a'), refresh_token: 'refresh-next', expires_in: 3600 }),
      codexStream('fresh'),
    ], { rotation: ['openai/gpt-6-luna'], zai: [], codex: true, codexExpiresIn: 1_000 })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-c2'), request())
    expect(response.status).toBe(200)
    await response.text()
    expect(ctx.seen[0]?.url).toBe('https://auth.openai.com/oauth/token')
    expect(ctx.seen[0]?.body).toContain('grant_type=refresh_token')
    expect(ctx.seen[1]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
  })
})

describe('messages proxy: one rotation across formats', () => {
  test('falls through z.ai, OpenCode Go and ChatGPT to Anthropic, in rotation order', async () => {
    const ctx = await mixedSetup([
      () => new Response('{}', { status: 429 }),
      () => new Response('quota', { status: 403 }),
      () => new Response('down', { status: 503 }),
      sse,
    ], {
      rotation: ['zai-coding-plan/glm-5.3-flash', 'opencode-go/glm-5.3-flash', 'openai/gpt-6-luna', 'anthropic/claude-sonnet-5-5'],
      zai: ['a'], opencode: true, codex: true, anthropic: true,
    })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-x1'), request())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('message_stop')
    expect(ctx.seen.map((call) => new URL(call.url).host)).toEqual(['api.z.ai', 'opencode.ai', 'chatgpt.com', 'api.anthropic.com'])
    const anthropicBody = JSON.parse(ctx.seen[3]!.body) as Record<string, unknown>
    expect(anthropicBody.model).toBe('claude-sonnet-5-5')
    expect(readSessionRoute({ dataDir: ctx.dataDir, sessionId: 'ses-x1', now: Date.now() })).toMatchObject({ provider: 'anthropic', accountId: ctx.ids['anthropic'] })
    // Only the 429 cools an account down; the other failures fall through without one.
    const state = readPoolState({ dataDir: ctx.dataDir, poolId: SHARED_POOL_ID })
    if (state instanceof Error) throw state
    expect(Object.keys(state.cooldowns)).toEqual([ctx.ids['zai-a']])
  })

  test('an Anthropic 429 falls through to a translated candidate', async () => {
    const ctx = await mixedSetup([() => new Response('{}', { status: 429 }), chatStream({ text: 'glm here' })], {
      rotation: ['anthropic/claude-sonnet-5-5', 'zai-coding-plan/glm-5.3-flash'], zai: ['a'], anthropic: true,
    })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-x2'), request())
    const events = await anthropicEvents(response)
    expect(events.find((event) => event.type === 'content_block_delta')?.delta.text).toBe('glm here')
    expect(ctx.seen.map((call) => new URL(call.url).host)).toEqual(['api.anthropic.com', 'api.z.ai'])
  })

  test('the held route is tried first on the next request', async () => {
    const ctx = await mixedSetup([() => new Response('{}', { status: 503 }), chatStream(), chatStream()], {
      rotation: ['zai-coding-plan/glm-5.3-flash'],
    })
    proxy = ctx.proxy
    const key = ctx.proxy.issueKey(() => 'ses-x3')
    await (await post(ctx.proxy.baseUrl, key, request())).text()
    await (await post(ctx.proxy.baseUrl, key, request())).text()
    expect(ctx.seen.map((call) => call.headers.get('authorization'))).toEqual(['Bearer zai-key-a', 'Bearer zai-key-b', 'Bearer zai-key-b'])
  })

  test('every candidate rate limited is a 429', async () => {
    const ctx = await mixedSetup([() => new Response('{}', { status: 429 }), () => new Response('{}', { status: 429 })], { rotation: ['zai-coding-plan/glm-5.3-flash'] })
    proxy = ctx.proxy
    const response = await post(ctx.proxy.baseUrl, ctx.proxy.issueKey(() => 'ses-x4'), request())
    expect(response.status).toBe(429)
  })
})
