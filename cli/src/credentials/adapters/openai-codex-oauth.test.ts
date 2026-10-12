import { describe, expect, test } from 'vitest'
import { buildCodexAuthorizeUrl, codexAccountId, exchangeCodexAuthorizationCode } from './openai-codex-oauth.js'

describe('Codex OAuth adapter', () => {
  test('authorize URL carries the Codex client, PKCE and simplified-flow params', () => {
    const url = new URL(buildCodexAuthorizeUrl({ challenge: 'ch', state: 'st' }))
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
      codex_cli_simplified_flow: 'true',
      originator: 'roadie',
    })
  })
  test('account id comes from the access token claims', () => {
    const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'abc' } })).toString('base64url')}.y`
    expect(codexAccountId(token)).toBe('abc')
    expect(codexAccountId('not-a-jwt')).toBeUndefined()
  })
  test('a rejected exchange is an error with the HTTP status', async () => {
    const result = await exchangeCodexAuthorizationCode({ code: 'c', verifier: 'v', fetchImpl: async () => new Response('bad', { status: 400 }) })
    expect(result instanceof Error && (result as Error & { status?: number }).status).toBe(400)
  })
})
