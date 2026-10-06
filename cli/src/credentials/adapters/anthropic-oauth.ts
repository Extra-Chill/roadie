// Anthropic OAuth (Claude Pro/Max subscription) adapter for credential pools.
//
// Ported from Roadie's retired MIT-licensed cli/src/anthropic-auth-plugin.ts
// at c662ef44^ (our own history): the client id and token URL, the
// authorization-code + PKCE exchange, `refresh_token` refresh, the
// `anthropic-beta: oauth-2025-04-20` merge, `authorization: Bearer` with
// `x-api-key` removed, the Claude Code system-prompt prefix, and tool-name
// rewriting in both requests and responses. The retired multi-account
// rotation and its auth.json coupling stay retired: pools replace them.
//
// Dependency-free (node builtins + globals only): this module is imported by
// the provider module that runs inside the OpenCode server process. HTTP
// calls take an injectable fetch so tests can stub the token endpoint.

import * as errore from 'errore'

// --- Constants (ported verbatim) ---

const CLIENT_ID_ENCODED = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl'

export const ANTHROPIC_OAUTH_CLIENT_ID = Buffer.from(CLIENT_ID_ENCODED, 'base64').toString('utf8')
export const ANTHROPIC_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
/** The browser lands here; the user pastes the code#state from the address bar. */
export const ANTHROPIC_OAUTH_REDIRECT_URI = 'http://localhost:53692/callback'
export const ANTHROPIC_OAUTH_SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.280 (external, cli)'

export const CLAUDE_CODE_BETA = 'claude-code-20250219'
export const OAUTH_BETA = 'oauth-2025-04-20'
export const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14'
export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'

export const OPENCODE_TO_CLAUDE_CODE_TOOL_NAME: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  question: 'AskUserQuestion',
  read: 'Read',
  skill: 'Skill',
  task: 'Task',
  todowrite: 'TodoWrite',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  write: 'Write',
}

// --- Types ---

export type OAuthTokens = {
  refresh: string
  access: string
  /** Epoch ms after which `access` is expired (5 min ahead of the real expiry). */
  expires: number
}

export type TokenFetch = (input: string, init?: RequestInit) => Promise<Response>

/** Token-endpoint failure carrying the HTTP status when the endpoint answered. */
export type TokenEndpointError = Error & { status?: number }

// --- Token endpoint ---

function tokenEndpointError({ url, status, body }: { url: string; status?: number; body?: string }): TokenEndpointError {
  const error: TokenEndpointError = new Error(
    `Anthropic OAuth token request failed${status ? ` with HTTP ${status}` : ''} for ${url}${body ? `: ${body.slice(0, 300)}` : ''}`,
  )
  if (status !== undefined) error.status = status
  return error
}

/** True when the token endpoint itself rejected the refresh (revoked/expired refresh token). */
export function isPermanentRefreshFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    (error.status === 400 || error.status === 401)
  )
}

function parseTokenResponse(json: unknown, now: number): OAuthTokens | TokenEndpointError {
  if (!json || typeof json !== 'object') {
    return tokenEndpointError({ url: ANTHROPIC_OAUTH_TOKEN_URL, body: 'non-object token response' })
  }
  const data = json as Record<string, unknown>
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
    return tokenEndpointError({
      url: ANTHROPIC_OAUTH_TOKEN_URL,
      body: `invalid token response: ${JSON.stringify(json).slice(0, 300)}`,
    })
  }
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 0
  // Ported: consider the token expired 5 minutes before the real expiry.
  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: now + expiresIn * 1000 - 5 * 60 * 1000,
  }
}

async function postTokenRequest({
  body,
  fetchImpl,
  now,
}: {
  body: Record<string, string>
  fetchImpl: TokenFetch
  now: number
}): Promise<OAuthTokens | Error> {
  const response = await fetchImpl(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((cause: unknown) =>
    tokenEndpointError({
      url: ANTHROPIC_OAUTH_TOKEN_URL,
      body: cause instanceof Error ? cause.message : String(cause),
    }),
  )
  if (response instanceof Error) return response
  const responseText = await response.text().catch((cause: unknown) =>
    tokenEndpointError({
      url: ANTHROPIC_OAUTH_TOKEN_URL,
      body: cause instanceof Error ? cause.message : String(cause),
    }),
  )
  if (responseText instanceof Error) return responseText
  if (!response.ok) {
    return tokenEndpointError({ url: ANTHROPIC_OAUTH_TOKEN_URL, status: response.status, body: responseText })
  }
  const json = errore.try({
    try: () => JSON.parse(responseText) as unknown,
    catch: () => tokenEndpointError({ url: ANTHROPIC_OAUTH_TOKEN_URL, status: response.status, body: responseText }),
  })
  if (json instanceof Error) return json
  return parseTokenResponse(json, now)
}

/** Exchange a pasted `code#state` (PKCE) for OAuth tokens. */
export async function exchangeAuthorizationCode({
  code,
  state,
  verifier,
  redirectUri,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  code: string
  state: string
  verifier: string
  redirectUri: string
  fetchImpl?: TokenFetch
  now?: number
}): Promise<OAuthTokens | Error> {
  return await postTokenRequest({
    body: {
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code,
      state,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
    fetchImpl,
    now,
  })
}

/** Rotate an OAuth account's tokens. Anthropic rotates the refresh token too. */
export async function refreshAnthropicToken({
  refreshToken,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  refreshToken: string
  fetchImpl?: TokenFetch
  now?: number
}): Promise<OAuthTokens | Error> {
  return await postTokenRequest({
    body: {
      grant_type: 'refresh_token',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    },
    fetchImpl,
    now,
  })
}

// --- Login flow (pasted code, no local callback server) ---

// PKCE (Proof Key for Code Exchange) using Web Crypto API.
// Reference: https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/oauth/pkce.ts
function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string } | Error> {
  try {
    const verifierBytes = new Uint8Array(32)
    crypto.getRandomValues(verifierBytes)
    const verifier = base64urlEncode(verifierBytes)
    const data = new TextEncoder().encode(verifier)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const challenge = base64urlEncode(new Uint8Array(hashBuffer))
    return { verifier, challenge }
  } catch (cause) {
    return new Error('Failed to generate PKCE challenge', { cause })
  }
}

export function buildAuthorizeUrl({
  challenge,
  state,
  redirectUri,
}: {
  challenge: string
  state: string
  redirectUri: string
}): string {
  const authParams = new URLSearchParams({
    code: 'true',
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: ANTHROPIC_OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${ANTHROPIC_OAUTH_AUTHORIZE_URL}?${authParams.toString()}`
}

/** Accepts the full redirect URL, `code#state`, `code=..&state=..`, or a bare code. */
export function parseManualInput(input: string): { code: string; state: string } {
  const trimmed = input.trim()
  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    if (code) return { code, state: url.searchParams.get('state') || '' }
  } catch {
    // not a URL
  }
  if (trimmed.includes('#')) {
    const [code = '', state = ''] = trimmed.split('#', 2)
    return { code, state }
  }
  if (trimmed.includes('code=')) {
    const params = new URLSearchParams(trimmed)
    const code = params.get('code')
    if (code) return { code, state: params.get('state') || '' }
  }
  return { code: trimmed, state: '' }
}

// --- Request/response shaping (ported) ---

function toClaudeCodeToolName(name: string): string {
  return OPENCODE_TO_CLAUDE_CODE_TOOL_NAME[name.toLowerCase()] ?? name
}

function prependClaudeCodeIdentity(system: unknown): unknown[] {
  const identityBlock = {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY,
  }

  if (typeof system === 'undefined') return [identityBlock]

  if (typeof system === 'string') {
    if (system === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: 'text', text: system }]
  }

  if (!Array.isArray(system)) return [identityBlock, system]

  const mapped = system.map((item) => {
    if (typeof item === 'string') {
      return { type: 'text', text: item }
    }
    return item
  })

  const first = mapped[0]
  if (
    first &&
    typeof first === 'object' &&
    'type' in first &&
    first.type === 'text' &&
    'text' in first &&
    first.text === CLAUDE_CODE_IDENTITY
  ) {
    return mapped
  }
  return [identityBlock, ...mapped]
}

/**
 * Shape a serialized Messages request as Claude Code: rename opencode tool
 * names in `tools`, `tool_choice` and `tool_use` blocks, and prepend the
 * Claude Code identity to the system prompt. Returns the rewritten body plus
 * the reverse map to apply to the streamed response.
 */
export function rewriteRequestPayload(body: string | undefined): {
  body: string | undefined
  reverseToolNameMap: Map<string, string>
} {
  if (!body) {
    return { body, reverseToolNameMap: new Map<string, string>() }
  }
  const parse = errore.try({
    try: () => JSON.parse(body) as Record<string, unknown>,
    catch: () => null,
  })
  if (!parse || typeof parse !== 'object') {
    return { body, reverseToolNameMap: new Map<string, string>() }
  }
  const payload = parse
  const reverseToolNameMap = new Map<string, string>()

  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool
      const name = (tool as { name?: unknown }).name
      if (typeof name !== 'string') return tool
      const mapped = toClaudeCodeToolName(name)
      reverseToolNameMap.set(mapped, name)
      return { ...(tool as Record<string, unknown>), name: mapped }
    })
  }

  payload.system = prependClaudeCodeIdentity(payload.system)

  if (
    payload.tool_choice &&
    typeof payload.tool_choice === 'object' &&
    (payload.tool_choice as { type?: unknown }).type === 'tool'
  ) {
    const name = (payload.tool_choice as { name?: unknown }).name
    if (typeof name === 'string') {
      payload.tool_choice = {
        ...(payload.tool_choice as Record<string, unknown>),
        name: toClaudeCodeToolName(name),
      }
    }
  }

  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((message) => {
      if (!message || typeof message !== 'object') return message
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return message
      return {
        ...(message as Record<string, unknown>),
        content: content.map((block) => {
          if (!block || typeof block !== 'object') return block
          const b = block as { type?: unknown; name?: unknown }
          if (b.type !== 'tool_use' || typeof b.name !== 'string') return block
          return {
            ...(block as Record<string, unknown>),
            name: toClaudeCodeToolName(b.name),
          }
        }),
      }
    })
  }

  return { body: JSON.stringify(payload), reverseToolNameMap }
}

/**
 * Reverse the tool-name rewrite in a streamed JSON response so the SDK sees
 * the opencode tool names it sent. Carries 256 chars across chunk boundaries
 * so a split `"name":"…"` key is never missed.
 *
 * Ported from the retired plugin's pull-based stream with one mechanical
 * change: the read loop is pushed from `start` instead of `pull`, because
 * returning from `pull` without enqueueing never re-invokes it on node and
 * stalls small responses. Transform semantics are unchanged.
 */
export function wrapResponseStream(response: Response, reverseToolNameMap: Map<string, string>): Response {
  if (!response.body || reverseToolNameMap.size === 0) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let carry = ''
  let cancelled = false

  const transform = (text: string): string => {
    return text.replace(/"name"\s*:\s*"([^"]+)"/g, (full, name: string) => {
      const original = reverseToolNameMap.get(name)
      return original ? full.replace(`"${name}"`, `"${original}"`) : full
    })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) {
            const finalText = carry + decoder.decode()
            if (finalText) controller.enqueue(encoder.encode(transform(finalText)))
            controller.close()
            return
          }
          carry += decoder.decode(value, { stream: true })
          if (carry.length <= 256) continue
          const output = carry.slice(0, -256)
          carry = carry.slice(-256)
          controller.enqueue(encoder.encode(transform(output)))
        }
      } catch (cause) {
        if (!cancelled) controller.error(cause)
      }
    },
    async cancel(reason) {
      cancelled = true
      await reader.cancel(reason)
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

// --- Beta headers (ported) ---

export function getRequiredBetas(modelId: string | undefined): string[] {
  const betas = [CLAUDE_CODE_BETA, OAUTH_BETA, FINE_GRAINED_TOOL_STREAMING_BETA]
  const isAdaptive =
    modelId?.includes('opus-4-6') ||
    modelId?.includes('opus-4.6') ||
    modelId?.includes('sonnet-4-6') ||
    modelId?.includes('sonnet-4.6')
  if (!isAdaptive) betas.push(INTERLEAVED_THINKING_BETA)
  return betas
}

export function mergeBetas(existing: string | null, required: string[]): string {
  return [
    ...new Set([
      ...required,
      ...(existing || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  ].join(',')
}

/**
 * Full OAuth request header set, ported from the retired plugin's runRequest:
 * `authorization: Bearer` with `x-api-key` removed, the Claude Code client
 * identity, the merged `anthropic-beta` header (oauth-2025-04-20 among them),
 * and the direct-browser-access flag the OAuth flow requires.
 */
export function applyAnthropicOAuthRequestHeaders({
  headers,
  accessToken,
  modelId,
}: {
  headers: Headers
  accessToken: string
  modelId: string
}): void {
  headers.set('accept', 'application/json')
  headers.set('anthropic-beta', mergeBetas(headers.get('anthropic-beta'), getRequiredBetas(modelId)))
  headers.set('anthropic-dangerous-direct-browser-access', 'true')
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('user-agent', CLAUDE_CODE_USER_AGENT)
  headers.set('x-app', 'cli')
  headers.delete('x-api-key')
}
