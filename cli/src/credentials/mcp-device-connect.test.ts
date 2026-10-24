// OAuth connect for person-scoped MCP servers: discovery (RFC 9728 header +
// well-known fallback, RFC 8414), dynamic client registration caching, device
// authorization, polling states, token storage, disconnect — and the
// authorization code + S256 PKCE fallback for servers with no device grant
// (grant selection, PKCE/state, authorization URL, loopback receiver, paste,
// exchange, storage).

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  AUTHORIZATION_CODE_GRANT,
  DEVICE_CODE_GRANT,
  PKCE_CHALLENGE_METHOD,
  beginDeviceConnect,
  beginOAuthConnect,
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  discoverMcpAuthorization,
  disconnectPersonMcp,
  exchangeAuthorizationCode,
  getOrRegisterAuthorizationCodeClient,
  getOrRegisterClient,
  parseAuthorizationCodeRedirect,
  parseResourceMetadataUrl,
  pollDeviceToken,
  selectConnectGrant,
  startLoopbackRedirectListener,
  type ConnectFetch,
  type ConnectFetchResponse,
  type DeviceConnectError,
} from './mcp-device-connect.js'
import {
  getPersonMcpAccessToken,
  listPersonMcpCredentials,
  readPersonMcpToken,
} from './person-mcp-store.js'

const MCP_URL = 'https://auth.example.com/wp-json/acme/v1/mcp'
const ISSUER = 'https://auth.example.com'
const PRM_URL = 'https://auth.example.com/.well-known/oauth-protected-resource/wp-json/acme/v1/mcp'

type Call = { method: string; url: string; body?: string; headers: Record<string, string> }
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> }
type Route = (call: Call) => Reply | undefined

function fakeFetch(routes: Record<string, Reply | Route | Array<Reply | Route>>) {
  const calls: Call[] = []
  const counters = new Map<string, number>()
  const fetchImpl: ConnectFetch = async (url, init) => {
    const call: Call = { method: init.method, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) }
    calls.push(call)
    const key = `${init.method} ${url}`
    let entry = routes[key]
    if (Array.isArray(entry)) {
      const index = counters.get(key) ?? 0
      counters.set(key, index + 1)
      entry = entry[Math.min(index, entry.length - 1)]
    }
    const reply: Reply = (typeof entry === 'function' ? entry(call) : entry) ?? { status: 404, json: { error: 'not_found' } }
    const status = reply.status ?? 200
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    const response: ConnectFetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      json: async () => reply.json,
      body: { cancel: async () => undefined },
    }
    return response
  }
  return { fetchImpl, calls }
}

async function httpGet(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url)
  return { status: response.status, text: await response.text() }
}

const AS_METADATA = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/oauth/token`,
  device_authorization_endpoint: `${ISSUER}/oauth/device`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  grant_types_supported: [DEVICE_CODE_GRANT, 'refresh_token', 'authorization_code'],
}

function baseRoutes(): Record<string, Reply | Route | Array<Reply | Route>> {
  return {
    [`POST ${MCP_URL}`]: {
      status: 401,
      headers: { 'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${PRM_URL}"` },
    },
    [`GET ${PRM_URL}`]: {
      json: { resource: MCP_URL, authorization_servers: [ISSUER], scopes_supported: ['mcp', 'profile'] },
    },
    [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: { json: AS_METADATA },
    [`POST ${ISSUER}/oauth/register`]: { status: 201, json: { client_id: 'client-123' } },
    [`POST ${ISSUER}/oauth/device`]: {
      json: {
        device_code: 'DEVICE-SECRET',
        user_code: 'ABCD-EFGH',
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 5,
      },
    },
  }
}

let dataDir: string
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-mcp-connect-'))
})
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('discovery', () => {
  test('parses resource_metadata from WWW-Authenticate', () => {
    expect(parseResourceMetadataUrl(`Bearer resource_metadata="${PRM_URL}"`)).toBe(PRM_URL)
    expect(parseResourceMetadataUrl(`Bearer error="invalid_token", resource_metadata=${PRM_URL}`)).toBe(PRM_URL)
    expect(parseResourceMetadataUrl('Bearer realm="x"')).toBeUndefined()
    expect(parseResourceMetadataUrl(null)).toBeUndefined()
  })

  test('follows the WWW-Authenticate header to the authorization server', async () => {
    const { fetchImpl, calls } = fakeFetch(baseRoutes())
    const discovery = await discoverMcpAuthorization({ mcpUrl: MCP_URL, fetchImpl })
    if (discovery instanceof Error) throw discovery
    expect(discovery.resource).toBe(MCP_URL)
    expect(discovery.scopes).toEqual(['mcp', 'profile'])
    expect(discovery.authorizationServer).toMatchObject({
      issuer: ISSUER,
      tokenEndpoint: `${ISSUER}/oauth/token`,
      deviceAuthorizationEndpoint: `${ISSUER}/oauth/device`,
      registrationEndpoint: `${ISSUER}/oauth/register`,
      revocationEndpoint: `${ISSUER}/oauth/revoke`,
    })
    const initialize = calls[0]!
    expect(initialize.method).toBe('POST')
    expect(JSON.parse(initialize.body!).method).toBe('initialize')
    expect(initialize.headers.authorization).toBeUndefined()
  })

  test('falls back to the origin well-known URL without the header', async () => {
    const routes = baseRoutes()
    routes[`POST ${MCP_URL}`] = { status: 401 }
    delete routes[`GET ${PRM_URL}`]
    routes[`GET ${ISSUER}/.well-known/oauth-protected-resource`] = {
      json: { authorization_servers: [ISSUER] },
    }
    const { fetchImpl, calls } = fakeFetch(routes)
    const discovery = await discoverMcpAuthorization({ mcpUrl: MCP_URL, fetchImpl })
    if (discovery instanceof Error) throw discovery
    expect(discovery.resource).toBe(MCP_URL)
    expect(discovery.scopes).toBeUndefined()
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(`GET ${ISSUER}/.well-known/oauth-protected-resource`)
  })

  test('falls back to OpenID configuration for issuers with a path', async () => {
    const issuer = 'https://idp.example.com/tenant'
    const routes: Record<string, Reply> = {
      [`POST ${MCP_URL}`]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` } },
      [`GET ${PRM_URL}`]: { json: { authorization_servers: [issuer] } },
      [`GET ${issuer}/.well-known/openid-configuration`]: { json: { ...AS_METADATA, issuer } },
    }
    const { fetchImpl } = fakeFetch(routes)
    const discovery = await discoverMcpAuthorization({ mcpUrl: MCP_URL, fetchImpl })
    if (discovery instanceof Error) throw discovery
    expect(discovery.authorizationServer.issuer).toBe(issuer)
  })

  test('refuses non-https URLs and servers without metadata', async () => {
    const { fetchImpl } = fakeFetch({})
    const insecure = await discoverMcpAuthorization({ mcpUrl: 'http://example.com/mcp', fetchImpl })
    expect((insecure as DeviceConnectError).code).toBe('invalid_url')
    const missing = await discoverMcpAuthorization({ mcpUrl: MCP_URL, fetchImpl })
    expect((missing as DeviceConnectError).code).toBe('discovery')
  })

  test('ignores an advertised metadata URL that is not https', async () => {
    const routes = baseRoutes()
    routes[`POST ${MCP_URL}`] = { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="http://evil.example.com/prm"' } }
    const { fetchImpl, calls } = fakeFetch(routes)
    const discovery = await discoverMcpAuthorization({ mcpUrl: MCP_URL, fetchImpl })
    expect(discovery instanceof Error).toBe(false)
    expect(calls.some((call) => call.url.startsWith('http://'))).toBe(false)
  })

  test('a server without a device endpoint is reported as unsupported', async () => {
    const routes = baseRoutes()
    const { device_authorization_endpoint: _drop, ...noDevice } = AS_METADATA
    routes[`GET ${ISSUER}/.well-known/oauth-authorization-server`] = { json: noDevice }
    const { fetchImpl, calls } = fakeFetch(routes)
    const result = await beginDeviceConnect({
      dataDir,
      personKey: 'wp:1',
      target: { name: 'acme', url: MCP_URL, credential: 'acme' },
      fetchImpl,
    })
    expect((result as DeviceConnectError).code).toBe('unsupported')
    expect((result as Error).message).toMatch(/device/)
    expect(calls.some((call) => call.url.endsWith('/oauth/register'))).toBe(false)
  })

  test('a server whose grant list lacks device_code is unsupported', async () => {
    const routes = baseRoutes()
    routes[`GET ${ISSUER}/.well-known/oauth-authorization-server`] = {
      json: { ...AS_METADATA, grant_types_supported: ['authorization_code'] },
    }
    const { fetchImpl } = fakeFetch(routes)
    const result = await beginDeviceConnect({
      dataDir,
      personKey: 'wp:1',
      target: { name: 'acme', url: MCP_URL, credential: 'acme' },
      fetchImpl,
    })
    expect((result as DeviceConnectError).code).toBe('unsupported')
  })
})

describe('dynamic client registration', () => {
  const server = {
    issuer: ISSUER,
    tokenEndpoint: `${ISSUER}/oauth/token`,
    registrationEndpoint: `${ISSUER}/oauth/register`,
  }

  test('registers a public device client once and caches it per issuer (0600)', async () => {
    const { fetchImpl, calls } = fakeFetch(baseRoutes())
    const first = await getOrRegisterClient({ dataDir, server, fetchImpl })
    const second = await getOrRegisterClient({ dataDir, server, fetchImpl })
    expect(first).toEqual({ clientId: 'client-123' })
    expect(second).toEqual({ clientId: 'client-123' })
    const registrations = calls.filter((call) => call.url.endsWith('/oauth/register'))
    expect(registrations).toHaveLength(1)
    expect(JSON.parse(registrations[0]!.body!)).toEqual({
      client_name: 'Roadie',
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
    })
    const files = fs.readdirSync(path.join(dataDir, 'mcp-clients'))
    expect(files).toHaveLength(1)
    const mode = fs.statSync(path.join(dataDir, 'mcp-clients', files[0]!)).mode & 0o777
    expect(mode).toBe(0o600)

    // A different authorization server gets its own registration.
    const other = { ...server, issuer: 'https://other.example.com', registrationEndpoint: 'https://other.example.com/register' }
    const { fetchImpl: otherFetch, calls: otherCalls } = fakeFetch({
      'POST https://other.example.com/register': { json: { client_id: 'other-client' } },
    })
    expect(await getOrRegisterClient({ dataDir, server: other, fetchImpl: otherFetch })).toEqual({ clientId: 'other-client' })
    expect(otherCalls).toHaveLength(1)
  })

  test('a rejected registration is an error and is not cached', async () => {
    const { fetchImpl } = fakeFetch({ [`POST ${ISSUER}/oauth/register`]: { status: 400, json: { error: 'invalid_client_metadata' } } })
    const result = await getOrRegisterClient({ dataDir, server, fetchImpl })
    expect((result as DeviceConnectError).code).toBe('registration')
    expect(fs.existsSync(path.join(dataDir, 'mcp-clients'))).toBe(false)
  })
})

describe('token polling', () => {
  const client = { clientId: 'client-123' }
  const tokenEndpoint = `${ISSUER}/oauth/token`

  function clock() {
    let current = 1_000_000
    const sleeps: number[] = []
    return {
      now: () => current,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        current += ms
      },
      sleeps,
    }
  }

  test('authorization_pending and slow_down keep polling, slow_down adds 5s', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`POST ${tokenEndpoint}`]: [
        { status: 400, json: { error: 'authorization_pending' } },
        { status: 400, json: { error: 'slow_down' } },
        { status: 400, json: { error: 'authorization_pending' } },
        { json: { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600, token_type: 'Bearer' } },
      ],
    })
    const time = clock()
    const result = await pollDeviceToken({
      tokenEndpoint,
      client,
      deviceCode: 'DEVICE',
      intervalSeconds: 5,
      deadline: time.now() + 600_000,
      fetchImpl,
      sleep: time.sleep,
      now: time.now,
    })
    expect(result).toEqual({ access: 'ACCESS', refresh: 'REFRESH', expires: time.now() + 3600_000 })
    expect(time.sleeps).toEqual([5000, 5000, 10_000, 10_000])
    const body = new URLSearchParams(calls[0]!.body!)
    expect(body.get('grant_type')).toBe(DEVICE_CODE_GRANT)
    expect(body.get('device_code')).toBe('DEVICE')
    expect(body.get('client_id')).toBe('client-123')
  })

  test('expired_token and access_denied stop polling', async () => {
    for (const [error, code] of [['expired_token', 'expired'], ['access_denied', 'denied']] as const) {
      const { fetchImpl, calls } = fakeFetch({ [`POST ${tokenEndpoint}`]: { status: 400, json: { error } } })
      const time = clock()
      const result = await pollDeviceToken({
        tokenEndpoint, client, deviceCode: 'D', intervalSeconds: 5, deadline: time.now() + 600_000,
        fetchImpl, sleep: time.sleep, now: time.now,
      })
      expect((result as DeviceConnectError).code).toBe(code)
      expect(calls).toHaveLength(1)
    }
  })

  test('stops at the expires_in deadline', async () => {
    const { fetchImpl, calls } = fakeFetch({ [`POST ${tokenEndpoint}`]: { status: 400, json: { error: 'authorization_pending' } } })
    const time = clock()
    const result = await pollDeviceToken({
      tokenEndpoint, client, deviceCode: 'D', intervalSeconds: 5, deadline: time.now() + 20_000,
      fetchImpl, sleep: time.sleep, now: time.now,
    })
    expect((result as DeviceConnectError).code).toBe('expired')
    expect(calls).toHaveLength(4)
  })

  test('an abort signal cancels polling', async () => {
    const { fetchImpl } = fakeFetch({ [`POST ${tokenEndpoint}`]: { status: 400, json: { error: 'authorization_pending' } } })
    const controller = new AbortController()
    const time = clock()
    const result = await pollDeviceToken({
      tokenEndpoint, client, deviceCode: 'D', intervalSeconds: 5, deadline: time.now() + 600_000,
      fetchImpl, now: time.now, signal: controller.signal,
      sleep: async (ms) => { await time.sleep(ms); controller.abort() },
    })
    expect((result as DeviceConnectError).code).toBe('aborted')
  })

  test('errors never echo the device code or tokens', async () => {
    const { fetchImpl } = fakeFetch({ [`POST ${tokenEndpoint}`]: { status: 400, json: { error: 'invalid_grant', error_description: 'DEVICE-SECRET bad' } } })
    const time = clock()
    const result = await pollDeviceToken({
      tokenEndpoint, client, deviceCode: 'DEVICE-SECRET', intervalSeconds: 5, deadline: time.now() + 600_000,
      fetchImpl, sleep: time.sleep, now: time.now,
    })
    expect((result as Error).message).not.toContain('DEVICE-SECRET')
  })
})

describe('end to end connect and disconnect', () => {
  test('stores the token for the person only, then disconnect revokes and removes it', async () => {
    const routes = baseRoutes()
    routes[`POST ${ISSUER}/oauth/token`] = [
      { status: 400, json: { error: 'authorization_pending' } },
      { json: { access_token: 'ACCESS-1', refresh_token: 'REFRESH-1', expires_in: 3600 } },
    ]
    routes[`POST ${ISSUER}/oauth/revoke`] = { status: 200 }
    const { fetchImpl, calls } = fakeFetch(routes)
    let current = 5_000_000
    const session = await beginDeviceConnect({
      dataDir,
      personKey: 'wp:1',
      target: { name: 'acme', url: MCP_URL, credential: 'acme' },
      fetchImpl,
      now: () => current,
    })
    if (session instanceof Error) throw session
    expect(session.prompt).toEqual({
      verificationUri: `${ISSUER}/device`,
      verificationUriComplete: `${ISSUER}/device?user_code=ABCD-EFGH`,
      userCode: 'ABCD-EFGH',
      expiresAt: current + 600_000,
    })
    const deviceRequest = new URLSearchParams(calls.find((call) => call.url.endsWith('/oauth/device'))!.body!)
    expect(deviceRequest.get('client_id')).toBe('client-123')
    expect(deviceRequest.get('scope')).toBe('mcp profile')
    expect(deviceRequest.get('resource')).toBe(MCP_URL)

    const result = await session.complete({ sleep: async (ms) => { current += ms } })
    expect(result).toBeUndefined()

    const record = readPersonMcpToken({ dataDir, personKey: 'wp:1', credential: 'acme' })
    expect(record).toMatchObject({
      access: 'ACCESS-1',
      refresh: 'REFRESH-1',
      expires: current + 3600_000,
      tokenEndpoint: `${ISSUER}/oauth/token`,
      clientId: 'client-123',
      revocationEndpoint: `${ISSUER}/oauth/revoke`,
    })
    const tokenFile = path.join(dataDir, 'mcp-credentials', 'wp:1', 'acme.json')
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)
    expect(await getPersonMcpAccessToken({ dataDir, personKey: 'wp:1', credential: 'acme', now: current })).toBe('ACCESS-1')
    // Another person has nothing.
    expect(listPersonMcpCredentials({ dataDir, personKey: 'wp:2' })).toEqual([])
    expect(await getPersonMcpAccessToken({ dataDir, personKey: 'wp:2', credential: 'acme' })).toBeNull()

    // Another person disconnecting touches nothing of wp:1.
    expect(await disconnectPersonMcp({ dataDir, personKey: 'wp:2', credential: 'acme', fetchImpl })).toEqual({ removed: false, revoked: false })
    expect(listPersonMcpCredentials({ dataDir, personKey: 'wp:1' })).toEqual(['acme'])

    const disconnected = await disconnectPersonMcp({ dataDir, personKey: 'wp:1', credential: 'acme', fetchImpl })
    expect(disconnected).toEqual({ removed: true, revoked: true })
    const revoke = new URLSearchParams(calls.find((call) => call.url.endsWith('/oauth/revoke'))!.body!)
    expect(revoke.get('token')).toBe('REFRESH-1')
    expect(revoke.get('token_type_hint')).toBe('refresh_token')
    expect(listPersonMcpCredentials({ dataDir, personKey: 'wp:1' })).toEqual([])
  })

  test('re-registers once when the cached client is unknown to the server', async () => {
    const routes = baseRoutes()
    routes[`POST ${ISSUER}/oauth/register`] = [{ json: { client_id: 'stale' } }, { json: { client_id: 'fresh' } }]
    routes[`POST ${ISSUER}/oauth/device`] = (call) => {
      const clientId = new URLSearchParams(call.body!).get('client_id')
      if (clientId === 'stale') return { status: 401, json: { error: 'invalid_client' } }
      return (baseRoutes()[`POST ${ISSUER}/oauth/device`] as Reply)
    }
    const { fetchImpl, calls } = fakeFetch(routes)
    const target = { name: 'acme', url: MCP_URL, credential: 'acme' }
    // Prime the cache with the stale client.
    const discovered = await discoverMcpAuthorization({ mcpUrl: MCP_URL, fetchImpl })
    if (discovered instanceof Error) throw discovered
    await getOrRegisterClient({ dataDir, server: discovered.authorizationServer, fetchImpl })
    const session = await beginDeviceConnect({ dataDir, personKey: 'wp:1', target, fetchImpl })
    expect(session instanceof Error).toBe(false)
    expect(calls.filter((call) => call.url.endsWith('/oauth/register'))).toHaveLength(2)
  })
})

// ── Grant selection (issue #356) ────────────────────────────────

describe('grant selection', () => {
  const base = {
    issuer: ISSUER,
    tokenEndpoint: `${ISSUER}/oauth/token`,
    registrationEndpoint: `${ISSUER}/oauth/register`,
  }

  test('prefers the device grant when the server offers it', () => {
    expect(selectConnectGrant({ ...base, deviceAuthorizationEndpoint: `${ISSUER}/oauth/device` })).toEqual({ grant: 'device' })
    expect(
      selectConnectGrant({
        ...base,
        deviceAuthorizationEndpoint: `${ISSUER}/oauth/device`,
        authorizationEndpoint: `${ISSUER}/oauth/authorize`,
        grantTypesSupported: [DEVICE_CODE_GRANT, AUTHORIZATION_CODE_GRANT],
      }),
    ).toEqual({ grant: 'device' })
  })

  test('falls back to authorization code when the device grant is unavailable', () => {
    expect(
      selectConnectGrant({ ...base, authorizationEndpoint: `${ISSUER}/oauth/authorize`, codeChallengeMethodsSupported: [PKCE_CHALLENGE_METHOD] }),
    ).toEqual({ grant: 'authorization_code' })
    // A device endpoint that the grant list does not allow is not enough.
    expect(
      selectConnectGrant({
        ...base,
        deviceAuthorizationEndpoint: `${ISSUER}/oauth/device`,
        authorizationEndpoint: `${ISSUER}/oauth/authorize`,
        grantTypesSupported: [AUTHORIZATION_CODE_GRANT, 'refresh_token'],
        codeChallengeMethodsSupported: [PKCE_CHALLENGE_METHOD],
      }),
    ).toEqual({ grant: 'authorization_code' })
  })

  test('refuses unconnectable servers with specific reasons', () => {
    const noS256 = selectConnectGrant({ ...base, authorizationEndpoint: `${ISSUER}/oauth/authorize`, codeChallengeMethodsSupported: ['plain'] })
    expect((noS256 as DeviceConnectError).code).toBe('unsupported')
    expect((noS256 as Error).message).toMatch(/S256/)

    const neither = selectConnectGrant(base)
    expect((neither as DeviceConnectError).code).toBe('unsupported')
    expect((neither as Error).message).toMatch(/neither device sign-in nor browser sign-in/)

    const noRegistration = selectConnectGrant({ issuer: ISSUER, tokenEndpoint: `${ISSUER}/oauth/token` })
    expect((noRegistration as DeviceConnectError).code).toBe('unsupported')
    expect((noRegistration as Error).message).toMatch(/client registration/)
  })
})

// ── PKCE and state ──────────────────────────────────────────────

describe('pkce and state', () => {
  test('challenge is the S256 of the verifier, and state is independent randomness', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'))
    const state = createState()
    expect(state).toMatch(/^[A-Za-z0-9_-]{10,}$/)
    // state must not be derived from the verifier (issue #250): the URL and
    // the verifier travel differently.
    expect(state).not.toBe(challenge)
    expect(state).not.toBe(verifier)
    expect(createState()).not.toBe(state)
    expect(createPkcePair().verifier).not.toBe(verifier)
  })
})

// ── Authorization URL and pasted redirects ──────────────────────

describe('authorization url and pasted redirects', () => {
  test('builds the authorization URL with resource (RFC 8707) and scope', () => {
    const url = new URL(
      buildAuthorizationUrl({
        endpoint: 'https://auth.example.com/oauth/authorize',
        clientId: 'client-123',
        redirectUri: 'http://127.0.0.1:4919/callback',
        state: 'STATE',
        codeChallenge: 'CHALLENGE',
        scope: 'mcp profile',
        resource: MCP_URL,
      }),
    )
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.example.com/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-123',
      redirect_uri: 'http://127.0.0.1:4919/callback',
      state: 'STATE',
      code_challenge: 'CHALLENGE',
      code_challenge_method: 'S256',
      scope: 'mcp profile',
      resource: MCP_URL,
    })
    const minimal = new URL(
      buildAuthorizationUrl({
        endpoint: 'https://auth.example.com/oauth/authorize',
        clientId: 'c',
        redirectUri: 'http://127.0.0.1:9/callback',
        state: 's',
        codeChallenge: 'cc',
      }),
    )
    expect(minimal.searchParams.get('scope')).toBeNull()
    expect(minimal.searchParams.get('resource')).toBeNull()
  })

  test('parses a pasted redirect and refuses junk without echoing it as code', () => {
    expect(parseAuthorizationCodeRedirect('http://127.0.0.1:4919/callback?code=C&state=S')).toEqual({ code: 'C', state: 'S' })
    expect(parseAuthorizationCodeRedirect('  http://127.0.0.1:4919/callback?scope=mcp&code=C&state=S  ')).toEqual({ code: 'C', state: 'S' })
    const junk = parseAuthorizationCodeRedirect('not a url at all')
    expect((junk as DeviceConnectError).code).toBe('authorization')
    const missing = parseAuthorizationCodeRedirect('http://127.0.0.1:4919/callback?state=S')
    expect((missing as DeviceConnectError).code).toBe('authorization')
  })
})

// ── Loopback redirect receiver ──────────────────────────────────

describe('loopback redirect receiver', () => {
  test('binds 127.0.0.1, delivers exactly one redirect, then answers duplicates', async () => {
    const listener = await startLoopbackRedirectListener({ expectedState: 'S1', lifetimeMs: 60_000 })
    if (listener instanceof Error) throw listener
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const done = listener.wait()
    const page = await httpGet(`${listener.redirectUri}?code=C&state=S1`)
    expect(page.status).toBe(200)
    expect(page.text).toContain('close this tab')
    expect(await done).toEqual({ code: 'C', state: 'S1' })
    const again = await httpGet(`${listener.redirectUri}?code=C2&state=S1`)
    expect(again.status).toBe(200)
    expect(again.text).toContain('already completed')
    await listener.close()
  })

  test('a state mismatch gets an error page and does not consume the attempt', async () => {
    const listener = await startLoopbackRedirectListener({ expectedState: 'S1', lifetimeMs: 60_000 })
    if (listener instanceof Error) throw listener
    const done = listener.wait()
    const bad = await httpGet(`${listener.redirectUri}?code=C&state=WRONG`)
    expect(bad.status).toBe(400)
    expect(bad.text).toMatch(/not started by this connect attempt/)
    const good = await httpGet(`${listener.redirectUri}?code=C&state=S1`)
    expect(good.status).toBe(200)
    expect(await done).toEqual({ code: 'C', state: 'S1' })
    await listener.close()
  })

  test('expires after its lifetime', async () => {
    const listener = await startLoopbackRedirectListener({ expectedState: 'S1', lifetimeMs: 30 })
    if (listener instanceof Error) throw listener
    const result = await listener.wait()
    expect((result as DeviceConnectError).code).toBe('expired')
    await listener.close()
  })

  test('an access_denied redirect ends the attempt as denied', async () => {
    const listener = await startLoopbackRedirectListener({ expectedState: 'S1', lifetimeMs: 60_000 })
    if (listener instanceof Error) throw listener
    const done = listener.wait()
    const page = await httpGet(`${listener.redirectUri}?error=access_denied&state=S1`)
    expect(page.status).toBe(200)
    expect(((await done) as DeviceConnectError).code).toBe('denied')
    await listener.close()
  })

  test('unknown paths are 404 and never consume the attempt', async () => {
    const listener = await startLoopbackRedirectListener({ expectedState: 'S1', lifetimeMs: 60_000 })
    if (listener instanceof Error) throw listener
    const done = listener.wait()
    const other = await httpGet(`${listener.redirectUri.replace('/callback', '/other')}?code=C&state=S1`)
    expect(other.status).toBe(404)
    const missing = await httpGet(`${listener.redirectUri}?state=S1`)
    expect(missing.status).toBe(400)
    const good = await httpGet(`${listener.redirectUri}?code=C&state=S1`)
    expect(good.status).toBe(200)
    expect(await done).toEqual({ code: 'C', state: 'S1' })
    await listener.close()
  })
})

// ── Authorization-code client registration ──────────────────────

describe('authorization-code client registration', () => {
  const server = {
    issuer: ISSUER,
    tokenEndpoint: `${ISSUER}/oauth/token`,
    registrationEndpoint: `${ISSUER}/oauth/register`,
  }

  test('registers a public loopback client per redirect and caches it beside the device client', async () => {
    const { fetchImpl, calls } = fakeFetch({ [`POST ${ISSUER}/oauth/register`]: { status: 201, json: { client_id: 'ac-client' } } })
    const redirectUri = 'http://127.0.0.1:4919/callback'
    const first = await getOrRegisterAuthorizationCodeClient({ dataDir, server, redirectUri, fetchImpl })
    const second = await getOrRegisterAuthorizationCodeClient({ dataDir, server, redirectUri, fetchImpl })
    expect(first).toEqual({ clientId: 'ac-client' })
    expect(second).toEqual({ clientId: 'ac-client' })
    const registrations = calls.filter((call) => call.url.endsWith('/oauth/register'))
    expect(registrations).toHaveLength(1)
    expect(JSON.parse(registrations[0]!.body!)).toEqual({
      client_name: 'Roadie',
      token_endpoint_auth_method: 'none',
      grant_types: [AUTHORIZATION_CODE_GRANT, 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [redirectUri],
    })
    // The device client keeps its own cache entry: grants never clobber.
    const { fetchImpl: deviceFetch, calls: deviceCalls } = fakeFetch({
      [`POST ${ISSUER}/oauth/register`]: { json: { client_id: 'device-client' } },
    })
    expect(await getOrRegisterClient({ dataDir, server, fetchImpl: deviceFetch })).toEqual({ clientId: 'device-client' })
    expect(deviceCalls).toHaveLength(1)
    expect(fs.readdirSync(path.join(dataDir, 'mcp-clients'))).toHaveLength(2)
  })
})

// ── Authorization-code exchange ─────────────────────────────────

describe('authorization code exchange', () => {
  const tokenEndpoint = `${ISSUER}/oauth/token`
  const client = { clientId: 'client-123' }
  const base = {
    tokenEndpoint,
    client,
    code: 'CODE-SECRET',
    codeVerifier: 'VERIFIER-SECRET',
    redirectUri: 'http://127.0.0.1:4919/callback',
    resource: MCP_URL,
  }

  test('exchanges code + verifier for tokens', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`POST ${tokenEndpoint}`]: { json: { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600 } },
    })
    let current = 1_000_000
    const result = await exchangeAuthorizationCode({ ...base, fetchImpl, now: () => current })
    expect(result).toEqual({ access: 'ACCESS', refresh: 'REFRESH', expires: current + 3_600_000 })
    const body = new URLSearchParams(calls[0]!.body!)
    expect(body.get('grant_type')).toBe(AUTHORIZATION_CODE_GRANT)
    expect(body.get('code')).toBe('CODE-SECRET')
    expect(body.get('code_verifier')).toBe('VERIFIER-SECRET')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:4919/callback')
    expect(body.get('client_id')).toBe('client-123')
    expect(body.get('resource')).toBe(MCP_URL)
  })

  test('maps token errors to specific codes without echoing secrets', async () => {
    for (const [error, code] of [
      ['invalid_client', 'registration'],
      ['invalid_grant', 'authorization'],
      ['access_denied', 'denied'],
    ] as const) {
      const { fetchImpl } = fakeFetch({
        [`POST ${tokenEndpoint}`]: { status: 400, json: { error, error_description: 'CODE-SECRET VERIFIER-SECRET bad' } },
      })
      const result = await exchangeAuthorizationCode({ ...base, fetchImpl })
      expect((result as DeviceConnectError).code).toBe(code)
      expect((result as Error).message).not.toContain('CODE-SECRET')
      expect((result as Error).message).not.toContain('VERIFIER-SECRET')
    }
    const { fetchImpl } = fakeFetch({ [`POST ${tokenEndpoint}`]: { status: 500, json: { error: 'temporarily_unavailable' } } })
    expect(((await exchangeAuthorizationCode({ ...base, fetchImpl })) as DeviceConnectError).code).toBe('failed')
  })
})

// ── Authorization-code connect (the fallback for /connect) ──────

const AUTH_CODE_METADATA = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/oauth/token`,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  grant_types_supported: [AUTHORIZATION_CODE_GRANT, 'refresh_token'],
  code_challenge_methods_supported: [PKCE_CHALLENGE_METHOD],
}

function baseAuthCodeRoutes(): Record<string, Reply | Route | Array<Reply | Route>> {
  return {
    [`POST ${MCP_URL}`]: {
      status: 401,
      headers: { 'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${PRM_URL}"` },
    },
    [`GET ${PRM_URL}`]: {
      json: { resource: MCP_URL, authorization_servers: [ISSUER], scopes_supported: ['mcp', 'profile'] },
    },
    [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: { json: AUTH_CODE_METADATA },
    [`POST ${ISSUER}/oauth/register`]: { status: 201, json: { client_id: 'client-123' } },
    [`POST ${ISSUER}/oauth/token`]: {
      json: { access_token: 'ACCESS-AC', refresh_token: 'REFRESH-AC', expires_in: 3600 },
    },
  }
}

async function startAuthCodeConnect(
  fetchImpl: ConnectFetch,
  overrides: { routes?: Record<string, Reply | Route | Array<Reply | Route>>; dataDir?: string } = {},
) {
  const session = await beginOAuthConnect({
    dataDir: overrides.dataDir ?? dataDir,
    personKey: 'wp:1',
    target: { name: 'acme', url: MCP_URL, credential: 'acme' },
    fetchImpl,
  })
  if (session instanceof Error) throw session
  if (session.grant !== 'authorization_code') throw new Error('expected the authorization-code fallback')
  return session
}

describe('authorization code connect', () => {
  test('a server offering both grants still gets the device grant', async () => {
    const { fetchImpl, calls } = fakeFetch(baseRoutes())
    const selection = await beginOAuthConnect({
      dataDir,
      personKey: 'wp:1',
      target: { name: 'acme', url: MCP_URL, credential: 'acme' },
      fetchImpl,
    })
    if (selection instanceof Error) throw selection
    expect(selection.grant).toBe('device')
    expect(JSON.parse(calls.find((call) => call.url.endsWith('/oauth/register'))!.body!).grant_types).toContain(DEVICE_CODE_GRANT)
    expect(calls.some((call) => call.url.endsWith('/oauth/authorize'))).toBe(false)
  })

  test('registers a loopback client, signs in via the receiver, and stores a refreshable token', async () => {
    const { fetchImpl, calls } = fakeFetch(baseAuthCodeRoutes())
    const session = await startAuthCodeConnect(fetchImpl)

    const registration = JSON.parse(calls.find((call) => call.url.endsWith('/oauth/register'))!.body!)
    expect(registration).toEqual({
      client_name: 'Roadie',
      token_endpoint_auth_method: 'none',
      grant_types: [AUTHORIZATION_CODE_GRANT, 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [session.redirectUri],
    })

    const authorize = new URL(session.prompt.signInUrl)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/oauth/authorize`)
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-123',
      redirect_uri: session.redirectUri,
      resource: MCP_URL,
      scope: 'mcp profile',
      code_challenge_method: 'S256',
    })
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const completion = session.complete({ maxWaitMs: 60_000 })
    const page = await httpGet(`${session.redirectUri}?code=THE-CODE&state=${authorize.searchParams.get('state')}`)
    expect(page.status).toBe(200)
    expect(await completion).toBeUndefined()

    const exchange = new URLSearchParams(calls.find((call) => call.url.endsWith('/oauth/token'))!.body!)
    expect(exchange.get('grant_type')).toBe(AUTHORIZATION_CODE_GRANT)
    expect(exchange.get('code')).toBe('THE-CODE')
    expect(exchange.get('redirect_uri')).toBe(session.redirectUri)
    expect(exchange.get('client_id')).toBe('client-123')
    expect(exchange.get('resource')).toBe(MCP_URL)
    const verifier = exchange.get('code_verifier')!
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The verifier only ever travels to the token endpoint, never in a URL.
    expect(session.prompt.signInUrl.includes(verifier)).toBe(false)
    expect(authorize.searchParams.get('state')).not.toBe(verifier)

    expect(readPersonMcpToken({ dataDir, personKey: 'wp:1', credential: 'acme' })).toMatchObject({
      access: 'ACCESS-AC',
      refresh: 'REFRESH-AC',
      tokenEndpoint: `${ISSUER}/oauth/token`,
      clientId: 'client-123',
      revocationEndpoint: `${ISSUER}/oauth/revoke`,
    })

    // Single use and bounded: once the flow finished, the receiver is gone.
    await expect(httpGet(`${session.redirectUri}?code=THE-CODE&state=${authorize.searchParams.get('state')}`)).rejects.toThrow()
    expect(calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(1)
  })

  test('accepts a pasted redirect URL when the state matches, exactly once', async () => {
    const { fetchImpl, calls } = fakeFetch(baseAuthCodeRoutes())
    const session = await startAuthCodeConnect(fetchImpl)
    const state = new URL(session.prompt.signInUrl).searchParams.get('state')!
    expect(await session.submitRedirectUrl('not a url at all')).toEqual({ status: 'invalid' })
    expect(await session.submitRedirectUrl(`${session.redirectUri}?code=X&state=stale`)).toEqual({ status: 'mismatch' })

    const completion = session.complete({ maxWaitMs: 60_000 })
    expect(await session.submitRedirectUrl(`${session.redirectUri}?code=PASTED-CODE&state=${state}`)).toEqual({ status: 'accepted' })
    expect(await completion).toBeUndefined()
    const exchange = new URLSearchParams(calls.find((call) => call.url.endsWith('/oauth/token'))!.body!)
    expect(exchange.get('code')).toBe('PASTED-CODE')

    // The flow is over: another paste (even a valid one) is late, no second exchange.
    expect(await session.submitRedirectUrl(`${session.redirectUri}?code=PASTED-CODE&state=${state}`)).toEqual({ status: 'late' })
    expect(calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(1)
  })

  test('expires when no redirect arrives, and later pastes are late', async () => {
    const { fetchImpl } = fakeFetch(baseAuthCodeRoutes())
    const session = await startAuthCodeConnect(fetchImpl)
    const result = await session.complete({ maxWaitMs: 50 })
    expect((result as DeviceConnectError).code).toBe('expired')
    const state = new URL(session.prompt.signInUrl).searchParams.get('state')!
    expect(await session.submitRedirectUrl(`${session.redirectUri}?code=X&state=${state}`)).toEqual({ status: 'late' })
    expect(readPersonMcpToken({ dataDir, personKey: 'wp:1', credential: 'acme' })).toBeNull()
  })

  test('reports specific errors for no supported grant and a rejected registration', async () => {
    const noGrant = { ...AUTH_CODE_METADATA }
    delete (noGrant as Record<string, unknown>).authorization_endpoint
    noGrant.grant_types_supported = ['refresh_token']
    const { fetchImpl } = fakeFetch({
      [`POST ${MCP_URL}`]: { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${PRM_URL}"` } },
      [`GET ${PRM_URL}`]: { json: { authorization_servers: [ISSUER] } },
      [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: { json: noGrant },
    })
    const refused = await beginOAuthConnect({
      dataDir,
      personKey: 'wp:1',
      target: { name: 'acme', url: MCP_URL, credential: 'acme' },
      fetchImpl,
    })
    expect((refused as DeviceConnectError).code).toBe('unsupported')
    expect((refused as Error).message).toMatch(/neither device sign-in nor browser sign-in/)

    const { fetchImpl: rejectedFetch } = fakeFetch({
      ...baseAuthCodeRoutes(),
      [`POST ${ISSUER}/oauth/register`]: { status: 400, json: { error: 'invalid_redirect_uri' } },
    })
    const failed = await beginOAuthConnect({
      dataDir,
      personKey: 'wp:1',
      target: { name: 'acme', url: MCP_URL, credential: 'acme' },
      fetchImpl: rejectedFetch,
    })
    expect((failed as DeviceConnectError).code).toBe('registration')
  })
})
