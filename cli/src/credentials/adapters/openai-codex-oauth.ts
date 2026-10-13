// ChatGPT (Codex) subscription adapter for credential pools.
//
// The public Codex CLI OAuth client, as used by Codex and Pi: authorization
// code + PKCE, `refresh_token` refresh, and the account id read from the access
// token's JWT claims. OpenAI supports third-party coding agents on ChatGPT
// subscriptions, so requests go out as they are: the pool only supplies the
// account's bearer token and `chatgpt-account-id`.
//
// Dependency-free; HTTP calls take an injectable fetch so tests stub them.

import type { OAuthTokens, TokenEndpointError, TokenFetch } from './anthropic-oauth.js'

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const CODEX_OAUTH_SCOPE = 'openid profile email offline_access'
/** Base URL of the Codex Responses endpoint; SDKs append `/responses`. */
export const CODEX_RESPONSES_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CODEX_RESPONSES_URL = `${CODEX_RESPONSES_BASE_URL}/responses`
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

export function buildCodexAuthorizeUrl({ challenge, state, originator = 'roadie' }: { challenge: string; state: string; originator?: string }): string {
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CODEX_OAUTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', CODEX_OAUTH_REDIRECT_URI)
  url.searchParams.set('scope', CODEX_OAUTH_SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', originator)
  return url.toString()
}

/** The ChatGPT account id in an access token, or undefined when it is not a Codex token. */
export function codexAccountId(accessToken: string): string | undefined {
  const payload = accessToken.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, { chatgpt_account_id?: unknown } | undefined>
    const id = claims[JWT_CLAIM_PATH]?.chatgpt_account_id
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

async function postToken({ body, fetchImpl, now }: { body: URLSearchParams; fetchImpl: TokenFetch; now: number }): Promise<OAuthTokens | TokenEndpointError> {
  let response: Response
  try {
    response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (cause) {
    return new Error(`Codex OAuth token request failed for ${CODEX_OAUTH_TOKEN_URL}`, { cause })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error: TokenEndpointError = new Error(`Codex OAuth token request failed with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
    error.status = response.status
    return error
  }
  const json = (await response.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    return new Error('Codex OAuth token response is missing access_token, refresh_token or expires_in')
  }
  return { access: json.access_token, refresh: json.refresh_token, expires: now + json.expires_in * 1000 }
}

export function exchangeCodexAuthorizationCode({
  code,
  verifier,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  code: string
  verifier: string
  fetchImpl?: TokenFetch
  now?: number
}): Promise<OAuthTokens | TokenEndpointError> {
  return postToken({
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CODEX_OAUTH_CLIENT_ID, code, code_verifier: verifier, redirect_uri: CODEX_OAUTH_REDIRECT_URI }),
    fetchImpl,
    now,
  })
}

export function refreshCodexToken({
  refreshToken,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  refreshToken: string
  fetchImpl?: TokenFetch
  now?: number
}): Promise<OAuthTokens | TokenEndpointError> {
  return postToken({
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CODEX_OAUTH_CLIENT_ID }),
    fetchImpl,
    now,
  })
}
