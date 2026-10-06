import { test, expect, describe, vi } from 'vitest'
import {
  type TokenFetch,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_TOKEN_URL,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePKCE,
  getRequiredBetas,
  isPermanentRefreshFailure,
  mergeBetas,
  parseManualInput,
  refreshAnthropicToken,
  rewriteRequestPayload,
  wrapResponseStream,
  CLAUDE_CODE_IDENTITY,
  OAUTH_BETA,
  INTERLEAVED_THINKING_BETA,
  CLAUDE_CODE_BETA,
  FINE_GRAINED_TOOL_STREAMING_BETA,
} from './anthropic-oauth.js'

const NOW = 1_000_000

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('token endpoint', () => {
  test('exchangeAuthorizationCode posts the PKCE payload and maps the response', async () => {
    const fetchImpl = vi.fn<TokenFetch>(async () =>
      tokenResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
    )
    const tokens = await exchangeAuthorizationCode({
      code: 'code#abc',
      state: 'state-1',
      verifier: 'verifier-1',
      redirectUri: 'http://localhost:53692/callback',
      fetchImpl,
      now: NOW,
    })
    expect(tokens).not.toBeInstanceOf(Error)
    if (tokens instanceof Error) return
    expect(tokens).toEqual({ access: 'at-1', refresh: 'rt-1', expires: NOW + 3600 * 1000 - 5 * 60 * 1000 })
    expect(fetchImpl).toHaveBeenCalledWith(
      ANTHROPIC_OAUTH_TOKEN_URL,
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, string>
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: 'code#abc',
      state: 'state-1',
      code_verifier: 'verifier-1',
    })
  })

  test('refreshAnthropicToken posts the refresh grant', async () => {
    const fetchImpl = vi.fn<TokenFetch>(async () =>
      tokenResponse({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
    )
    const tokens = await refreshAnthropicToken({ refreshToken: 'rt-1', fetchImpl, now: NOW })
    expect(tokens).toEqual({ access: 'at-2', refresh: 'rt-2', expires: NOW + 3600 * 1000 - 5 * 60 * 1000 })
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, string>
    expect(body).toEqual({
      grant_type: 'refresh_token',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: 'rt-1',
    })
  })

  test('an HTTP 400 answer becomes a permanent refresh failure', async () => {
    const fetchImpl = vi.fn<TokenFetch>(async () => tokenResponse({ error: 'invalid_grant' }, 400))
    const tokens = await refreshAnthropicToken({ refreshToken: 'rt-dead', fetchImpl, now: NOW })
    expect(tokens).toBeInstanceOf(Error)
    expect(isPermanentRefreshFailure(tokens)).toBe(true)
  })

  test('an HTTP 401 answer is permanent, a 500 answer is not', async () => {
    const unauthorized = vi.fn<TokenFetch>(async () => tokenResponse({}, 401))
    expect(isPermanentRefreshFailure(await refreshAnthropicToken({ refreshToken: 'r', fetchImpl: unauthorized, now: NOW }))).toBe(true)
    const serverError = vi.fn<TokenFetch>(async () => tokenResponse({}, 500))
    expect(isPermanentRefreshFailure(await refreshAnthropicToken({ refreshToken: 'r', fetchImpl: serverError, now: NOW }))).toBe(false)
  })

  test('a network failure is an Error value and not a permanent refresh failure', async () => {
    const fetchImpl = vi.fn<TokenFetch>(async () => {
      throw new Error('ECONNREFUSED')
    })
    const tokens = await refreshAnthropicToken({ refreshToken: 'r', fetchImpl, now: NOW })
    expect(tokens).toBeInstanceOf(Error)
    expect(isPermanentRefreshFailure(tokens)).toBe(false)
  })

  test('a malformed token body is rejected', async () => {
    const fetchImpl = vi.fn<TokenFetch>(async () => tokenResponse({ access_token: 'at-only' }))
    const tokens = await refreshAnthropicToken({ refreshToken: 'r', fetchImpl, now: NOW })
    expect(tokens).toBeInstanceOf(Error)
  })
})

describe('login flow helpers', () => {
  test('generatePKCE produces an S256 pair', async () => {
    const pkce = await generatePKCE()
    expect(pkce).not.toBeInstanceOf(Error)
    if (pkce instanceof Error) return
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(pkce.challenge).not.toBe(pkce.verifier)
  })

  test('buildAuthorizeUrl carries the client, PKCE and scope parameters', () => {
    const url = new URL(
      buildAuthorizeUrl({ challenge: 'challenge-1', state: 'state-1', redirectUri: 'http://localhost:53692/callback' }),
    )
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('https://claude.ai/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe(ANTHROPIC_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53692/callback')
    expect(url.searchParams.get('scope')).toContain('user:inference')
  })

  test('parseManualInput accepts full redirect URLs, code#state, query strings and bare codes', () => {
    expect(
      parseManualInput('http://localhost:53692/callback?code=abc123&state=st8'),
    ).toEqual({ code: 'abc123', state: 'st8' })
    expect(parseManualInput('abc123#st8')).toEqual({ code: 'abc123', state: 'st8' })
    expect(parseManualInput('code=abc123&state=st8')).toEqual({ code: 'abc123', state: 'st8' })
    expect(parseManualInput('  bare-code  ')).toEqual({ code: 'bare-code', state: '' })
  })
})

describe('beta headers', () => {
  test('getRequiredBetas includes the oauth beta and adds interleaved thinking only for non-adaptive models', () => {
    expect(getRequiredBetas('claude-sonnet-4')).toEqual([
      CLAUDE_CODE_BETA,
      OAUTH_BETA,
      FINE_GRAINED_TOOL_STREAMING_BETA,
      INTERLEAVED_THINKING_BETA,
    ])
    expect(getRequiredBetas('claude-opus-4-6')).toEqual([
      CLAUDE_CODE_BETA,
      OAUTH_BETA,
      FINE_GRAINED_TOOL_STREAMING_BETA,
    ])
    expect(getRequiredBetas('claude-sonnet-4.6')).not.toContain(INTERLEAVED_THINKING_BETA)
    expect(getRequiredBetas(undefined)).toContain(INTERLEAVED_THINKING_BETA)
  })

  test('mergeBetas prepends required betas and dedupes against the existing header', () => {
    expect(mergeBetas(null, [OAUTH_BETA])).toBe(OAUTH_BETA)
    expect(mergeBetas('beta-a, beta-b', [OAUTH_BETA, 'beta-a'])).toBe(`${OAUTH_BETA},beta-a,beta-b`)
    expect(mergeBetas('', [OAUTH_BETA, OAUTH_BETA])).toBe(OAUTH_BETA)
  })
})

describe('request/response shaping', () => {
  test('rewriteRequestPayload renames tools everywhere and prepends the Claude Code identity', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4',
      system: 'You are OpenCode.',
      tools: [
        { name: 'bash', description: 'run a command' },
        { name: 'read', description: 'read a file' },
        { name: 'custom-tool', description: 'kept as-is' },
      ],
      tool_choice: { type: 'tool', name: 'bash' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      ],
    })
    const rewritten = rewriteRequestPayload(body)
    const payload = JSON.parse(String(rewritten.body)) as {
      system: Array<{ type: string; text: string }>
      tools: Array<{ name: string }>
      tool_choice: { name: string }
      messages: Array<{ content: Array<{ type: string; name?: string }> }>
    }
    expect(payload.system).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'You are OpenCode.' },
    ])
    expect(payload.tools.map((tool) => tool.name)).toEqual(['Bash', 'Read', 'custom-tool'])
    expect(payload.tool_choice.name).toBe('Bash')
    expect(payload.messages[1]?.content[0]?.name).toBe('Read')

    const reverse = rewritten.reverseToolNameMap
    expect(reverse.get('Bash')).toBe('bash')
    expect(reverse.get('Read')).toBe('read')
    // Unknown tools map to themselves and reverse to themselves.
    expect(reverse.get('custom-tool')).toBe('custom-tool')
  })

  test('rewriteRequestPayload handles a string-less system and passes garbage through', () => {
    const identityOnly = rewriteRequestPayload(JSON.stringify({ system: CLAUDE_CODE_IDENTITY }))
    expect(JSON.parse(String(identityOnly.body))).toMatchObject({
      system: [{ type: 'text', text: CLAUDE_CODE_IDENTITY }],
    })
    expect(rewriteRequestPayload(undefined).body).toBeUndefined()
    expect(rewriteRequestPayload('not json').body).toBe('not json')
    expect(rewriteRequestPayload('not json').reverseToolNameMap.size).toBe(0)
  })

  test('wrapResponseStream reverses tool names in the streamed body', async () => {
    const rewritten = rewriteRequestPayload(
      JSON.stringify({ tools: [{ name: 'bash' }], messages: [] }),
    )
    const response = new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'Bash', input: {} }],
      }),
      { status: 200 },
    )
    const wrapped = wrapResponseStream(response, rewritten.reverseToolNameMap)
    const body = await wrapped.json()
    expect(body).toEqual({ content: [{ type: 'tool_use', name: 'bash', input: {} }] })
  })

  test('wrapResponseStream passes through when nothing was renamed', async () => {
    const response = new Response('plain', { status: 200 })
    expect(wrapResponseStream(response, new Map())).toBe(response)
  })

  test('wrapResponseStream reassembles a name split across chunks', async () => {
    const rewritten = rewriteRequestPayload(
      JSON.stringify({ tools: [{ name: 'todowrite' }], messages: [] }),
    )
    const longPrefix = 'x'.repeat(400)
    const chunks = [
      `{"pad":"${longPrefix}`,
      '","name":"TodoWr',
      'ite","ok":true}',
    ]
    let index = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(new TextEncoder().encode(chunks[index]))
          index += 1
          return
        }
        controller.close()
      },
    })
    const wrapped = wrapResponseStream(new Response(stream), rewritten.reverseToolNameMap)
    const body = await wrapped.text()
    expect(body).toBe(`{"pad":"${longPrefix}","name":"todowrite","ok":true}`)
  })
})
