// The stateless 2026-07-28 MCP client: request envelope, discover fallback,
// tools/call continuation, and form schema rendering. Pure module, fake fetch.

import { describe, expect, test } from 'vitest'
import {
  MCP_PROTOCOL_VERSION,
  buildFormAnswer,
  buildRequestHeaders,
  buildRequestMeta,
  callTool,
  discoverServer,
  listTools,
  parseFormSchema,
  supportsNativeProtocol,
} from './mcp-native.js'

/** A fetch fake that answers every request from `routes` and records them. */
function fakeFetch(routes: Array<{ match: (url: string, body: Record<string, unknown>) => boolean; reply: (url: string, body: Record<string, unknown>) => unknown }>) {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    requests.push({ url, body, headers: init.headers as Record<string, string> })
    const route = routes.find((route) => route.match(url, body))
    const payload = route ? await route.reply(url, body) : { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

const HEADERS = { Authorization: 'Bearer secret-token' }

describe('request envelope', () => {
  test('_meta carries the protocol version, form elicitation capability and client info', () => {
    expect(buildRequestMeta({ version: '1.2.3' })).toEqual({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
      'io.modelcontextprotocol/clientInfo': { name: 'roadie', version: '1.2.3' },
    })
  })

  test('headers carry the revision, the method, the tool name and both media types', () => {
    expect(buildRequestHeaders({ method: 'tools/call', toolName: 'buy-plan' })).toEqual({
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'buy-plan',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    })
    expect(buildRequestHeaders({ method: 'server/discover' })).not.toHaveProperty('Mcp-Name')
  })

  test('every request body carries _meta; tools/call adds the tool name header', async () => {
    const { fetchImpl, requests } = fakeFetch([
      { match: (_url, body) => body.method === 'tools/list', reply: () => ({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) },
      { match: (_url, body) => body.method === 'tools/call', reply: () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }) },
    ])
    const listed = await listTools({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '9.9.9', fetchImpl })
    expect(listed).toEqual([])
    expect(requests[0]?.headers['Mcp-Method']).toBe('tools/list')
    expect(requests[0]?.headers.Authorization).toBe('Bearer secret-token')
    expect(requests[0]?.body.params).toMatchObject({ _meta: buildRequestMeta({ version: '9.9.9' }) })

    await callTool({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '9.9.9', tool: 'search', args: { q: 'x' }, fetchImpl })
    expect(requests[1]?.headers['Mcp-Name']).toBe('search')
    expect(requests[1]?.headers['Mcp-Method']).toBe('tools/call')
    expect(requests[1]?.body.params).toMatchObject({ name: 'search', arguments: { q: 'x' } })
  })

  test('the token only ever travels in headers', async () => {
    const { fetchImpl, requests } = fakeFetch([
      { match: () => true, reply: () => ({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) },
    ])
    await listTools({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', fetchImpl })
    expect(JSON.stringify(requests[0]?.body)).not.toContain('secret-token')
  })
})

describe('discover fallback', () => {
  test('a server advertising 2026-07-28 takes the native path', async () => {
    const { fetchImpl } = fakeFetch([
      {
        match: (_url, body) => body.method === 'server/discover',
        reply: () => ({ jsonrpc: '2.0', id: 1, result: { supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: {} }, instructions: 'be nice' } }),
      },
    ])
    const discover = await discoverServer({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', fetchImpl })
    expect(discover instanceof Error).toBe(false)
    if (discover instanceof Error) return
    expect(supportsNativeProtocol(discover)).toBe(true)
    expect(discover.instructions).toBe('be nice')
  })

  test('a server without 2026-07-28 keeps the built-in client', async () => {
    const { fetchImpl } = fakeFetch([
      { match: () => true, reply: () => ({ jsonrpc: '2.0', id: 1, result: { supportedVersions: ['2025-11-25'] } }) },
    ])
    const discover = await discoverServer({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', fetchImpl })
    if (discover instanceof Error) throw discover
    expect(supportsNativeProtocol(discover)).toBe(false)
  })

  test('discover failing with method-not-found keeps the built-in client', async () => {
    const { fetchImpl } = fakeFetch([]) // every request falls through to -32601
    const discover = await discoverServer({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', fetchImpl })
    expect(discover instanceof Error).toBe(true)
    expect((discover as Error & { code?: number }).code).toBe(-32601)
  })

  test('a transport failure keeps the built-in client', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const discover = await discoverServer({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', fetchImpl })
    expect(discover instanceof Error).toBe(true)
  })
})

describe('tools/call and input-required continuation', () => {
  test('input_required becomes inputRequired with the signed request state', async () => {
    const { fetchImpl } = fakeFetch([
      {
        match: () => true,
        reply: () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            resultType: 'input_required',
            inputRequests: { form1: { method: 'elicitation/create', params: { mode: 'form', message: 'Buy it?', requestedSchema: { type: 'object', properties: {} } } } },
            requestState: 'signed-state',
          },
        }),
      },
    ])
    const result = await callTool({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', tool: 'buy', args: {}, fetchImpl })
    if (result instanceof Error) throw result
    expect(result.inputRequired?.requestState).toBe('signed-state')
    expect(result.inputRequired?.inputRequests.form1?.params?.mode).toBe('form')
  })

  test('the continuation repeats the call with inputResponses and requestState', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { fetchImpl } = fakeFetch([
      {
        match: () => true,
        reply: (_url, body) => {
          calls.push(body)
          if (calls.length === 1) {
            return { jsonrpc: '2.0', id: 1, result: { resultType: 'input_required', inputRequests: { form1: { method: 'elicitation/create', params: { mode: 'form', message: 'Buy it?' } } }, requestState: 'signed-state' } }
          }
          return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'bought' }] } }
        },
      },
    ])
    const first = await callTool({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', tool: 'buy', args: { plan: 'pro' }, fetchImpl })
    if (first instanceof Error || !first.inputRequired) throw first instanceof Error ? first : new Error('no input request')
    const second = await callTool({
      url: 'https://mcp.example.com/v2',
      headers: HEADERS,
      version: '1.0.0',
      tool: 'buy',
      args: { plan: 'pro' },
      continuation: { inputResponses: { form1: { action: 'accept', content: { confirm: true } } }, requestState: first.inputRequired.requestState },
      fetchImpl,
    })
    if (second instanceof Error) throw second
    expect(second.content).toEqual([{ type: 'text', text: 'bought' }])
    expect(calls[1]?.params).toMatchObject({
      inputResponses: { form1: { action: 'accept', content: { confirm: true } } },
      requestState: 'signed-state',
      name: 'buy',
      arguments: { plan: 'pro' },
    })
  })

  test('a JSON-RPC error from the call is an Error carrying the server code', async () => {
    const { fetchImpl } = fakeFetch([
      { match: () => true, reply: () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'request state expired' } }) },
    ])
    const result = await callTool({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', tool: 'buy', args: {}, fetchImpl })
    expect(result instanceof Error).toBe(true)
    expect((result as Error).message).toContain('request state expired')
  })

  test('an SSE body is read from its data line', async () => {
    const fetchImpl = (async () => new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch
    const result = await callTool({ url: 'https://mcp.example.com/v2', headers: HEADERS, version: '1.0.0', tool: 'say', args: {}, fetchImpl })
    if (result instanceof Error) throw result
    expect(result.content[0]?.text).toBe('hello')
  })
})

describe('form answers', () => {
  test('accept with no content sends no content at all', () => {
    expect(buildFormAnswer({ action: 'accept' })).toEqual({ action: 'accept' })
    expect(buildFormAnswer({ action: 'accept', content: {} })).toEqual({ action: 'accept' })
    expect(buildFormAnswer({ action: 'accept', content: { confirm: true } })).toEqual({ action: 'accept', content: { confirm: true } })
    expect(buildFormAnswer({ action: 'decline' })).toEqual({ action: 'decline' })
    expect(buildFormAnswer({ action: 'cancel' })).toEqual({ action: 'cancel' })
  })
})

describe('form schema rendering', () => {
  test('no or empty properties renders a bare confirmation form', () => {
    expect(parseFormSchema(undefined)).toEqual({ ok: true, fields: [] })
    expect(parseFormSchema({ type: 'object' })).toEqual({ ok: true, fields: [] })
    expect(parseFormSchema({ type: 'object', properties: {} })).toEqual({ ok: true, fields: [] })
  })

  test('boolean, enum, string and number fields render, with required tracked', () => {
    const parsed = parseFormSchema({
      type: 'object',
      required: ['confirm', 'plan'],
      properties: {
        confirm: { type: 'boolean', title: 'Confirm purchase' },
        plan: { type: 'string', enum: ['pro', 'business'], title: 'Plan' },
        seats: { type: 'integer', title: 'Seats', description: 'How many seats' },
        note: { type: 'string' },
        amount: { type: 'number' },
      },
    })
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.fields).toEqual([
      { kind: 'select', name: 'confirm', title: 'Confirm purchase', required: true, options: [
        { value: 'true', label: 'Yes', content: true },
        { value: 'false', label: 'No', content: false },
      ] },
      { kind: 'select', name: 'plan', title: 'Plan', required: true, options: [
        { value: '0', label: 'pro', content: 'pro' },
        { value: '1', label: 'business', content: 'business' },
      ] },
      { kind: 'text', name: 'seats', title: 'Seats', required: false, inputType: 'integer', placeholder: 'How many seats' },
      { kind: 'text', name: 'note', title: 'note', required: false, inputType: 'string' },
      { kind: 'text', name: 'amount', title: 'amount', required: false, inputType: 'number' },
    ])
  })

  test('unrenderable fields refuse the whole form with the reason', () => {
    expect(parseFormSchema({ properties: { tags: { type: 'array', items: { type: 'string' } } } }).ok).toBe(false)
    expect(parseFormSchema({ properties: { meta: { type: 'object' } } }).ok).toBe(false)
    expect(parseFormSchema({ properties: { x: { enum: Array.from({ length: 26 }, (_, i) => i) } } }).ok).toBe(false)
    expect(parseFormSchema({ properties: { x: 42 } }).ok).toBe(false)
    const reason = parseFormSchema({ properties: { meta: { type: 'object' } } })
    expect(!reason.ok && reason.reason).toContain('"meta"')
  })

  test('too many fields to draw refuse the form', () => {
    const manySelects = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, { type: 'boolean' }]))
    expect(parseFormSchema({ properties: manySelects }).ok).toBe(false)
    const manyTexts = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, { type: 'string' }]))
    expect(parseFormSchema({ properties: manyTexts }).ok).toBe(false)
  })
})
