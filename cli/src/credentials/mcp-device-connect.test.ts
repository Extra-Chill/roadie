// OAuth device-grant connect for person-scoped MCP servers: discovery (RFC
// 9728 header + well-known fallback, RFC 8414), dynamic client registration
// caching, device authorization, polling states, token storage, disconnect.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  DEVICE_CODE_GRANT,
  beginDeviceConnect,
  discoverMcpAuthorization,
  disconnectPersonMcp,
  getOrRegisterClient,
  parseResourceMetadataUrl,
  pollDeviceToken,
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
