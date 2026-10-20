// SuperGrok credentials imported from OpenCode. Refresh tokens rotate: callers
// must persist both returned tokens under the pool lock before using them.
// A response without refresh_token keeps the current refresh token.
import type { OAuthTokens, TokenEndpointError, TokenFetch } from './anthropic-oauth.js'

export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_OAUTH_TOKEN_URL = 'https://auth.x.ai/oauth2/token'
export const XAI_API_BASE_URL = 'https://api.x.ai/v1'

export async function refreshXaiToken({
  refreshToken,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  refreshToken: string
  fetchImpl?: TokenFetch
  now?: number
}): Promise<OAuthTokens | TokenEndpointError> {
  let response: Response
  try {
    response = await fetchImpl(XAI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: XAI_OAUTH_CLIENT_ID }).toString(),
    })
  } catch (cause) {
    return new Error(`xAI OAuth token request failed for ${XAI_OAUTH_TOKEN_URL}`, { cause })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error: TokenEndpointError = new Error(`xAI OAuth token request failed with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
    error.status = response.status
    return error
  }
  const json = (await response.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null
  if (!json?.access_token || typeof json.expires_in !== 'number' || !Number.isFinite(json.expires_in) || json.expires_in <= 0) {
    return new Error('xAI OAuth token response is missing access_token or expires_in')
  }
  return { access: json.access_token, refresh: json.refresh_token || refreshToken, expires: now + json.expires_in * 1000 }
}
