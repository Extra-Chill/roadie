// Connect a person's own account to a person-scoped MCP server (OAuth device
// grant, or authorization code + PKCE when the server has no device grant).
//
// Everything is discovered from the MCP server itself; nothing here knows a
// vendor:
//
//   1. Discovery. Request the MCP endpoint unauthenticated (JSON-RPC
//      `initialize`) and read `WWW-Authenticate: Bearer resource_metadata="…"`
//      (RFC 9728). Without that header, fall back to the well-known protected
//      resource metadata URLs. Take `authorization_servers[0]` and fetch its
//      metadata (RFC 8414, falling back to OpenID Connect discovery).
//   2. Grant selection. The device grant (RFC 8628) when the server advertises
//      a `device_authorization_endpoint`; otherwise authorization code + S256
//      PKCE (RFC 6749 / 7636) when it advertises an `authorization_endpoint`
//      and accepts `S256`. Without either, the flow is unsupported.
//   3. Dynamic client registration (RFC 7591) as a public client
//      (`token_endpoint_auth_method: none`), cached per authorization server
//      and grant in `<dataDir>/mcp-clients/` (0600, atomic writes). The
//      authorization-code client is registered with a loopback redirect URI
//      (`http://127.0.0.1:<port>/callback`) and is cached under a key that
//      names the grant and redirect, so it never clobbers the device client.
//   4a. Device authorization request. The caller shows
//      `verification_uri_complete` (or `verification_uri` + `user_code`)
//      privately to the person.
//   4b. Authorization request. The caller sends the person the authorization
//      URL privately; the code comes back either on a short-lived single-use
//      loopback listener that validates `state`, or pasted into chat from the
//      person's redirected browser tab. `state` is independent random, the
//      PKCE verifier is never sent before the token exchange.
//   5. Device: poll the token endpoint at `interval`, honouring
//      `authorization_pending` and `slow_down`, until success,
//      `expired_token`, `access_denied` or the `expires_in` deadline.
//      Authorization code: exchange the code once (code_verifier,
//      redirect_uri, client_id, resource) when it arrives. Either way the
//      token is stored for the person through person-mcp-store
//      (setPersonMcpToken).
//
// Disconnect removes the stored token and, when the authorization server has a
// `revocation_endpoint` (RFC 7009), revokes it best effort.
//
// Every URL must pass isAllowedMcpUrl (https, http only for loopback), every
// request has a timeout, and no token, code, verifier, device code or client
// secret is ever logged or put into an error message. fetch is injectable for
// tests.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import * as errore from 'errore'
import { atomicWriteFileSync, withPoolLock } from './store.js'
import {
  isAllowedMcpUrl,
  readPersonMcpToken,
  removePersonMcpToken,
  setPersonMcpToken,
} from './person-mcp-store.js'

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
export const AUTHORIZATION_CODE_GRANT = 'authorization_code'
export const REFRESH_TOKEN_GRANT = 'refresh_token'
export const PKCE_CHALLENGE_METHOD = 'S256'
export const CLIENT_NAME = 'Roadie'
const HTTP_TIMEOUT_MS = 15_000
const DEFAULT_INTERVAL_SECONDS = 5
const SLOW_DOWN_SECONDS = 5
const DEFAULT_DEVICE_EXPIRES_SECONDS = 600
const MAX_TRANSIENT_POLL_FAILURES = 3
const MCP_PROTOCOL_VERSION = '2025-06-18'

// ── Loopback redirect receiver (authorization code flow) ────────

export const LOOPBACK_HOST = '127.0.0.1'
export const LOOPBACK_REDIRECT_PATH = '/callback'
// Bounded lifetime: the authorization code and this receiver both die soon;
// chat reply lifetimes are shorter anyway (commands/connect.ts).
export const LOOPBACK_LIFETIME_MS = 10 * 60_000

export type ConnectFetchResponse = {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  body?: { cancel(): Promise<void> } | null
}

export type ConnectFetch = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
  },
) => Promise<ConnectFetchResponse>

export type DeviceConnectErrorCode =
  | 'invalid_url'
  | 'discovery'
  | 'unsupported'
  | 'registration'
  | 'authorization'
  | 'expired'
  | 'denied'
  | 'aborted'
  | 'failed'

/** Errors carry a code for the UI and a message safe to show the person. */
export class DeviceConnectError extends Error {
  readonly code: DeviceConnectErrorCode
  constructor(code: DeviceConnectErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DeviceConnectError'
    this.code = code
  }
}

export type AuthorizationServerMetadata = {
  issuer: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint?: string
  authorizationEndpoint?: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  grantTypesSupported?: string[]
  codeChallengeMethodsSupported?: string[]
}

export type McpAuthDiscovery = {
  /** Resource indicator (RFC 8707) for this MCP server. */
  resource: string
  scopes?: string[]
  authorizationServer: AuthorizationServerMetadata
}

export type RegisteredClient = {
  clientId: string
  clientSecret?: string
}

// ── HTTP helpers ────────────────────────────────────────────────

function defaultFetch(): ConnectFetch {
  return fetch as unknown as ConnectFetch
}

async function request(
  fetchImpl: ConnectFetch,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<ConnectFetchResponse | Error> {
  if (!isAllowedMcpUrl(url)) {
    return new DeviceConnectError('invalid_url', `Refusing non-https URL: ${safeUrl(url)}`)
  }
  return await fetchImpl(url, {
    method: init.method,
    headers: { accept: 'application/json', ...init.headers },
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  }).catch((e: unknown) => new Error(`Request to ${safeUrl(url)} failed`, { cause: e }))
}

async function readJson(response: ConnectFetchResponse): Promise<Record<string, unknown> | null> {
  const data = await response.json().catch(() => null)
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
}

async function getJson(fetchImpl: ConnectFetch, url: string): Promise<Record<string, unknown> | null> {
  const response = await request(fetchImpl, url, { method: 'GET' })
  if (response instanceof Error || !response.ok) return null
  return await readJson(response)
}

function form(params: Record<string, string | undefined>): string {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') body.set(key, value)
  }
  return body.toString()
}

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

/** URL without query or fragment, for messages (query strings may carry codes). */
function safeUrl(value: string): string {
  const url = errore.try({ try: () => new URL(value), catch: () => null })
  if (!url) return '(invalid URL)'
  return `${url.origin}${url.pathname}`
}

function str(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function strArray(record: Record<string, unknown> | null, key: string): string[] | undefined {
  const value = record?.[key]
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : undefined
}

function positiveNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function allowedOrUndefined(value: string | undefined): string | undefined {
  return value && isAllowedMcpUrl(value) ? value : undefined
}

// ── 1. Discovery ────────────────────────────────────────────────

/** `resource_metadata` from a `WWW-Authenticate` header (RFC 9728 §5.1). */
export function parseResourceMetadataUrl(header: string | null): string | undefined {
  if (!header) return undefined
  const match = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i.exec(header)
  const value = match?.[1] ?? match?.[2]
  return value?.trim() || undefined
}

/** Well-known URL with the path suffix rule of RFC 8414 §3 / RFC 9728 §3. */
function insertWellKnown(base: URL, suffix: string): string {
  const pathname = base.pathname.replace(/\/+$/, '')
  return `${base.origin}/.well-known/${suffix}${pathname}`
}

function appendWellKnown(base: URL, suffix: string): string {
  const pathname = base.pathname.replace(/\/+$/, '')
  return `${base.origin}${pathname}/.well-known/${suffix}`
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function protectedResourceMetadataCandidates(mcpUrl: string): string[] {
  const url = new URL(mcpUrl)
  return unique([
    insertWellKnown(url, 'oauth-protected-resource'),
    `${url.origin}/.well-known/oauth-protected-resource`,
  ])
}

export function authorizationServerMetadataCandidates(issuer: string): string[] {
  const url = new URL(issuer)
  return unique([
    insertWellKnown(url, 'oauth-authorization-server'),
    appendWellKnown(url, 'oauth-authorization-server'),
    insertWellKnown(url, 'openid-configuration'),
    appendWellKnown(url, 'openid-configuration'),
  ])
}

async function probeResourceMetadataUrl(fetchImpl: ConnectFetch, mcpUrl: string): Promise<string | undefined> {
  const response = await request(fetchImpl, mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'roadie', version: '1' },
      },
    }),
  })
  if (response instanceof Error) return undefined
  // Never read the body: an unauthenticated success may be an open stream.
  await response.body?.cancel().catch(() => undefined)
  return parseResourceMetadataUrl(response.headers.get('www-authenticate'))
}

/** Discover the authorization server for an MCP endpoint. */
export async function discoverMcpAuthorization({
  mcpUrl,
  fetchImpl = defaultFetch(),
}: {
  mcpUrl: string
  fetchImpl?: ConnectFetch
}): Promise<McpAuthDiscovery | DeviceConnectError> {
  if (!isAllowedMcpUrl(mcpUrl)) {
    return new DeviceConnectError('invalid_url', 'The MCP server URL must be https (http only for loopback).')
  }

  const advertised = await probeResourceMetadataUrl(fetchImpl, mcpUrl)
  const candidates = unique([
    ...(advertised && isAllowedMcpUrl(advertised) ? [advertised] : []),
    ...protectedResourceMetadataCandidates(mcpUrl),
  ])
  let resourceMetadata: Record<string, unknown> | null = null
  for (const candidate of candidates) {
    resourceMetadata = await getJson(fetchImpl, candidate)
    if (strArray(resourceMetadata, 'authorization_servers')) break
    resourceMetadata = null
  }
  if (!resourceMetadata) {
    return new DeviceConnectError(
      'discovery',
      'The MCP server does not publish OAuth protected resource metadata, so it cannot be connected from chat.',
    )
  }

  const declaredResource = str(resourceMetadata, 'resource')
  if (declaredResource) {
    const declared = errore.try({ try: () => new URL(declaredResource), catch: () => null })
    if (!declared || declared.origin !== new URL(mcpUrl).origin) {
      return new DeviceConnectError('discovery', 'The MCP server metadata names a different resource.')
    }
  }
  const issuer = strArray(resourceMetadata, 'authorization_servers')![0]!
  if (!isAllowedMcpUrl(issuer)) {
    return new DeviceConnectError('invalid_url', 'The authorization server URL must be https.')
  }

  let serverMetadata: Record<string, unknown> | null = null
  for (const candidate of authorizationServerMetadataCandidates(issuer)) {
    serverMetadata = await getJson(fetchImpl, candidate)
    if (str(serverMetadata, 'token_endpoint')) break
    serverMetadata = null
  }
  if (!serverMetadata) {
    return new DeviceConnectError('discovery', 'Could not read the authorization server metadata.')
  }
  const tokenEndpoint = str(serverMetadata, 'token_endpoint')!
  if (!isAllowedMcpUrl(tokenEndpoint)) {
    return new DeviceConnectError('invalid_url', 'The token endpoint must be https.')
  }

  const scopes = strArray(resourceMetadata, 'scopes_supported')
  return {
    resource: declaredResource ?? mcpUrl,
    ...(scopes ? { scopes } : {}),
    authorizationServer: {
      issuer: str(serverMetadata, 'issuer') ?? issuer,
      tokenEndpoint,
      ...optional('deviceAuthorizationEndpoint', allowedOrUndefined(str(serverMetadata, 'device_authorization_endpoint'))),
      ...optional('authorizationEndpoint', allowedOrUndefined(str(serverMetadata, 'authorization_endpoint'))),
      ...optional('registrationEndpoint', allowedOrUndefined(str(serverMetadata, 'registration_endpoint'))),
      ...optional('revocationEndpoint', allowedOrUndefined(str(serverMetadata, 'revocation_endpoint'))),
      ...optional('grantTypesSupported', strArray(serverMetadata, 'grant_types_supported')),
      ...optional('codeChallengeMethodsSupported', strArray(serverMetadata, 'code_challenge_methods_supported')),
    },
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

/** Null when the device flow can run against this server, else why not. */
export function deviceFlowUnsupportedReason(server: AuthorizationServerMetadata): string | null {
  if (!server.deviceAuthorizationEndpoint) {
    return 'This server does not offer device sign-in (no device authorization endpoint), so it cannot be connected from chat.'
  }
  if (server.grantTypesSupported && !server.grantTypesSupported.includes(DEVICE_CODE_GRANT)) {
    return 'This server does not support the device code grant, so it cannot be connected from chat.'
  }
  if (!server.registrationEndpoint) {
    return 'This server does not allow client registration, so Roadie cannot sign in to it from chat.'
  }
  return null
}

export type ConnectGrant = 'device' | 'authorization_code'

/**
 * Which OAuth grant to run against this server: the device grant when it is
 * offered, else authorization code + S256 PKCE (the fallback for servers with
 * no device grant, e.g. WordPress.com). An `unsupported` Error carries the
 * user-facing reason nothing can run. Device-first keeps the flow that needs
 * no browser on the Roadie host; selectConnectGrant never invents server
 * specifics, it only reads the discovered metadata.
 */
export function selectConnectGrant(server: AuthorizationServerMetadata): { grant: ConnectGrant } | DeviceConnectError {
  if (!server.registrationEndpoint) {
    return new DeviceConnectError('unsupported', 'This server does not allow client registration, so Roadie cannot sign in to it from chat.')
  }
  const grants = server.grantTypesSupported
  const allows = (grant: string): boolean => !grants || grants.includes(grant)
  if (server.deviceAuthorizationEndpoint && allows(DEVICE_CODE_GRANT)) return { grant: 'device' }
  const methods = server.codeChallengeMethodsSupported
  if (server.authorizationEndpoint && allows(AUTHORIZATION_CODE_GRANT)) {
    if (!methods || methods.includes(PKCE_CHALLENGE_METHOD)) return { grant: 'authorization_code' }
    return new DeviceConnectError(
      'unsupported',
      'This server does not accept the S256 PKCE code challenge method that browser sign-in needs, so it cannot be connected from chat.',
    )
  }
  return new DeviceConnectError(
    'unsupported',
    'This server supports neither device sign-in nor browser sign-in with PKCE, so it cannot be connected from chat.',
  )
}

// ── 3. Dynamic client registration (cached) ─────────────────────

/**
 * Cache file for one registered client. `variant` separates clients for the
 * same authorization server that were registered for different grants: the
 * device client (no variant, the historical key) and the authorization-code
 * client (variant names the grant and redirect) must not clobber each other.
 */
function clientCachePath({ dataDir, issuer, registrationEndpoint, variant }: { dataDir: string; issuer: string; registrationEndpoint: string; variant?: string }): string {
  const hash = crypto.createHash('sha256').update(`${issuer}\n${registrationEndpoint}${variant ? `\n${variant}` : ''}`).digest('hex').slice(0, 32)
  return path.join(dataDir, 'mcp-clients', `${hash}.json`)
}

function readCachedClient(filePath: string): RegisteredClient | null {
  const parsed = errore.try({
    try: () => JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>,
    catch: () => null,
  })
  const clientId = str(parsed, 'clientId')
  if (!clientId) return null
  const clientSecret = str(parsed, 'clientSecret')
  return { clientId, ...(clientSecret ? { clientSecret } : {}) }
}

/**
 * Drop a cached client for a server (e.g. after `invalid_client`). Pass the
 * same `variant` the client was registered with.
 */
export function forgetRegisteredClient({ dataDir, server, variant }: { dataDir: string; server: AuthorizationServerMetadata; variant?: string }): void {
  if (!server.registrationEndpoint) return
  const filePath = clientCachePath({ dataDir, issuer: server.issuer, registrationEndpoint: server.registrationEndpoint, ...(variant ? { variant } : {}) })
  errore.try({ try: () => fs.rmSync(filePath, { force: true }), catch: () => undefined })
}

/** Register (or read back) one client for this authorization server. */
async function registerAndCacheClient({
  dataDir,
  server,
  variant,
  registration,
  fetchImpl,
  now,
}: {
  dataDir: string
  server: AuthorizationServerMetadata
  variant?: string
  registration: Record<string, unknown>
  fetchImpl: ConnectFetch
  now: () => Date
}): Promise<RegisteredClient | DeviceConnectError> {
  const registrationEndpoint = server.registrationEndpoint
  if (!registrationEndpoint) {
    return new DeviceConnectError('unsupported', 'This server does not allow client registration.')
  }
  const filePath = clientCachePath({ dataDir, issuer: server.issuer, registrationEndpoint, ...(variant ? { variant } : {}) })
  return await withPoolLock(`mcp-client:${filePath}`, async () => {
    const cached = readCachedClient(filePath)
    if (cached) return cached
    const response = await request(fetchImpl, registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration),
    })
    if (response instanceof Error) {
      return new DeviceConnectError('registration', 'Client registration request failed.', { cause: response })
    }
    const data = await readJson(response)
    const clientId = str(data, 'client_id')
    if (!response.ok || !clientId) {
      return new DeviceConnectError('registration', `Client registration was rejected (HTTP ${response.status}).`)
    }
    const clientSecret = str(data, 'client_secret')
    atomicWriteFileSync({
      filePath,
      data: JSON.stringify(
        { issuer: server.issuer, registrationEndpoint, clientId, ...(clientSecret ? { clientSecret } : {}), registeredAt: now().toISOString() },
        null,
        2,
      ),
    })
    return { clientId, ...(clientSecret ? { clientSecret } : {}) }
  })
}

/** The cached public device client for this authorization server, registering one if needed. */
export async function getOrRegisterClient({
  dataDir,
  server,
  fetchImpl = defaultFetch(),
  now = () => new Date(),
}: {
  dataDir: string
  server: AuthorizationServerMetadata
  fetchImpl?: ConnectFetch
  now?: () => Date
}): Promise<RegisteredClient | DeviceConnectError> {
  return await registerAndCacheClient({
    dataDir,
    server,
    registration: {
      client_name: CLIENT_NAME,
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
    },
    fetchImpl,
    now,
  })
}

/**
 * The cached public authorization-code client for this server and loopback
 * redirect, registering one if needed. Keyed by grant + redirect, so it lives
 * beside (never instead of) the device client.
 */
export async function getOrRegisterAuthorizationCodeClient({
  dataDir,
  server,
  redirectUri,
  fetchImpl = defaultFetch(),
  now = () => new Date(),
}: {
  dataDir: string
  server: AuthorizationServerMetadata
  redirectUri: string
  fetchImpl?: ConnectFetch
  now?: () => Date
}): Promise<RegisteredClient | DeviceConnectError> {
  return await registerAndCacheClient({
    dataDir,
    server,
    variant: `authorization_code\n${redirectUri}`,
    registration: {
      client_name: CLIENT_NAME,
      token_endpoint_auth_method: 'none',
      grant_types: [AUTHORIZATION_CODE_GRANT, 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [redirectUri],
    },
    fetchImpl,
    now,
  })
}

// ── 4. Device authorization ─────────────────────────────────────

export type DeviceAuthorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresInSeconds: number
  intervalSeconds: number
}

export async function requestDeviceAuthorization({
  endpoint,
  client,
  scope,
  resource,
  fetchImpl = defaultFetch(),
}: {
  endpoint: string
  client: RegisteredClient
  scope?: string
  resource?: string
  fetchImpl?: ConnectFetch
}): Promise<DeviceAuthorization | DeviceConnectError> {
  const response = await request(fetchImpl, endpoint, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: form({ client_id: client.clientId, client_secret: client.clientSecret, scope, resource }),
  })
  if (response instanceof Error) {
    return new DeviceConnectError('authorization', 'Device authorization request failed.', { cause: response })
  }
  const data = await readJson(response)
  if (!response.ok) {
    const error = str(data, 'error')
    return new DeviceConnectError(
      'authorization',
      error === 'invalid_client' ? 'invalid_client' : `Device authorization was rejected (HTTP ${response.status}).`,
    )
  }
  const deviceCode = str(data, 'device_code')
  const userCode = str(data, 'user_code')
  const verificationUri = str(data, 'verification_uri') ?? str(data, 'verification_url')
  if (!deviceCode || !userCode || !verificationUri || !isAllowedMcpUrl(verificationUri)) {
    return new DeviceConnectError('authorization', 'The server returned an incomplete device authorization.')
  }
  const complete = allowedOrUndefined(str(data, 'verification_uri_complete'))
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete ? { verificationUriComplete: complete } : {}),
    expiresInSeconds: positiveNumber(data, 'expires_in') ?? DEFAULT_DEVICE_EXPIRES_SECONDS,
    intervalSeconds: positiveNumber(data, 'interval') ?? DEFAULT_INTERVAL_SECONDS,
  }
}

// ── 5. Token polling ────────────────────────────────────────────

export type DeviceTokenResult = {
  access: string
  /** Epoch ms. */
  expires?: number
  refresh?: string
}

export async function pollDeviceToken({
  tokenEndpoint,
  client,
  deviceCode,
  intervalSeconds,
  deadline,
  resource,
  fetchImpl = defaultFetch(),
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  signal,
}: {
  tokenEndpoint: string
  client: RegisteredClient
  deviceCode: string
  intervalSeconds: number
  /** Epoch ms after which polling stops (device code expiry). */
  deadline: number
  resource?: string
  fetchImpl?: ConnectFetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  signal?: AbortSignal
}): Promise<DeviceTokenResult | DeviceConnectError> {
  let interval = Math.max(1, intervalSeconds)
  let transientFailures = 0
  for (;;) {
    if (signal?.aborted) return new DeviceConnectError('aborted', 'Sign-in was cancelled.')
    if (now() + interval * 1000 > deadline) {
      return new DeviceConnectError('expired', 'The sign-in code expired before it was approved.')
    }
    await sleep(interval * 1000)
    if (signal?.aborted) return new DeviceConnectError('aborted', 'Sign-in was cancelled.')

    const response = await request(fetchImpl, tokenEndpoint, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: form({
        grant_type: DEVICE_CODE_GRANT,
        device_code: deviceCode,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        resource,
      }),
    })
    if (response instanceof Error) {
      transientFailures += 1
      if (transientFailures >= MAX_TRANSIENT_POLL_FAILURES) {
        return new DeviceConnectError('failed', 'Could not reach the token endpoint.', { cause: response })
      }
      continue
    }
    const data = await readJson(response)
    if (response.ok) {
      const access = str(data, 'access_token')
      if (!access) return new DeviceConnectError('failed', 'The server returned no access token.')
      const expiresIn = positiveNumber(data, 'expires_in')
      const refresh = str(data, 'refresh_token')
      return {
        access,
        ...(expiresIn ? { expires: now() + expiresIn * 1000 } : {}),
        ...(refresh ? { refresh } : {}),
      }
    }
    transientFailures = 0
    const error = str(data, 'error')
    switch (error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        interval += SLOW_DOWN_SECONDS
        continue
      case 'expired_token':
        return new DeviceConnectError('expired', 'The sign-in code expired before it was approved.')
      case 'access_denied':
        return new DeviceConnectError('denied', 'Sign-in was denied.')
      default:
        if (response.status >= 500) {
          transientFailures += 1
          if (transientFailures < MAX_TRANSIENT_POLL_FAILURES) continue
        }
        return new DeviceConnectError(
          'failed',
          `The token endpoint rejected the sign-in${error && /^[a-z_]{1,64}$/.test(error) ? ` (${error})` : ''} (HTTP ${response.status}).`,
        )
    }
  }
}

// ── 6. Authorization code + PKCE ─────────────────────────────────────────

/**
 * A verifier/challenge pair for PKCE (RFC 7636, S256). The verifier is a
 * 43-character base64url string; only it can redeem the code, and it is never
 * sent until the token exchange.
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Random `state` for an authorization request. Independent of the PKCE
 * verifier on purpose (issue #250): anything derived from the verifier would
 * leak it in the authorization URL.
 */
export function createState(): string {
  return crypto.randomBytes(16).toString('base64url')
}

/** The authorization redirect URL a person opens in their browser. */
export function buildAuthorizationUrl({
  endpoint,
  clientId,
  redirectUri,
  state,
  codeChallenge,
  scope,
  resource,
}: {
  endpoint: string
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scope?: string
  resource?: string
}): string {
  const url = new URL(endpoint)
  const params = url.searchParams
  params.set('response_type', 'code')
  params.set('client_id', clientId)
  params.set('redirect_uri', redirectUri)
  params.set('state', state)
  params.set('code_challenge', codeChallenge)
  params.set('code_challenge_method', PKCE_CHALLENGE_METHOD)
  if (scope) params.set('scope', scope)
  // RFC 8707: name the MCP server the token will be used against.
  if (resource) params.set('resource', resource)
  return url.toString()
}

/**
 * Parse a redirect URL a person pasted from their browser's address bar.
 * Only the presence of `code` and `state` is checked here; `state` equality
 * with the pending attempt is checked by the session, and the code is checked
 * by the authorization server at the exchange.
 */
export function parseAuthorizationCodeRedirect(url: string): { code: string; state: string } | DeviceConnectError {
  const parsed = errore.try({ try: () => new URL(url.trim()), catch: () => null })
  if (!parsed) return new DeviceConnectError('authorization', 'That does not look like a URL. Paste the whole address your browser was redirected to.')
  const code = parsed.searchParams.get('code')?.trim() ?? ''
  const state = parsed.searchParams.get('state')?.trim() ?? ''
  if (!code || !state) {
    return new DeviceConnectError('authorization', 'That URL is missing the sign-in details. Paste the whole address your browser was redirected to.')
  }
  return { code, state }
}

/**
 * Exchange the authorization code for tokens (RFC 6749 §4.1.3): one attempt,
 * bound to the code_verifier and the exact redirect_uri of the authorization
 * request. Never logs the code or verifier.
 */
export async function exchangeAuthorizationCode({
  tokenEndpoint,
  client,
  code,
  codeVerifier,
  redirectUri,
  resource,
  fetchImpl = defaultFetch(),
  now = Date.now,
}: {
  tokenEndpoint: string
  client: RegisteredClient
  code: string
  codeVerifier: string
  redirectUri: string
  resource?: string
  fetchImpl?: ConnectFetch
  now?: () => number
}): Promise<DeviceTokenResult | DeviceConnectError> {
  const response = await request(fetchImpl, tokenEndpoint, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: form({
      grant_type: AUTHORIZATION_CODE_GRANT,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      resource,
    }),
  })
  if (response instanceof Error) {
    return new DeviceConnectError('failed', 'Could not reach the token endpoint.', { cause: response })
  }
  const data = await readJson(response)
  if (!response.ok) {
    const error = str(data, 'error')
    if (error === 'invalid_client') {
      return new DeviceConnectError('registration', 'The server rejected Roadie as a client. Start over with a new connect.')
    }
    if (error === 'invalid_grant') {
      return new DeviceConnectError('authorization', 'The server rejected the sign-in; the link may have expired or was used already. Start over with a new connect.')
    }
    if (error === 'access_denied') return new DeviceConnectError('denied', 'Sign-in was denied.')
    return new DeviceConnectError(
      'failed',
      `The token endpoint rejected the sign-in${error && /^[a-z_]{1,64}$/.test(error) ? ` (${error})` : ''} (HTTP ${response.status}).`,
    )
  }
  const access = str(data, 'access_token')
  if (!access) return new DeviceConnectError('failed', 'The server returned no access token.')
  const expiresIn = positiveNumber(data, 'expires_in')
  const refresh = str(data, 'refresh_token')
  return {
    access,
    ...(expiresIn ? { expires: now() + expiresIn * 1000 } : {}),
    ...(refresh ? { refresh } : {}),
  }
}

// ── 7. Loopback redirect receiver ───────────────────────────────────────

export type LoopbackDelivery = { code: string; state: string }

export type LoopbackRedirectListener = {
  /** The redirect URI this listener accepts: http://127.0.0.1:<port>/callback. */
  redirectUri: string
  /** Resolves once one valid redirect arrives, or on expiry. Single use. */
  wait(): Promise<LoopbackDelivery | DeviceConnectError>
  /** Stop listening early; never throws. */
  close(): Promise<void>
}

// Plain text pages: nothing to read, the chat reply tells the person what next.
const CLOSE_TAB_PAGE = 'You can close this tab.'

/**
 * A short-lived, single-use HTTP listener on 127.0.0.1 for the authorization
 * redirect (RFC 8252 §7). It binds an ephemeral port, accepts exactly one
 * redirect whose `state` matches this attempt, answers the browser with a
 * plain close-this-tab page, and dies after `lifetimeMs` at the latest. A
 * `state` mismatch is answered with an error page and does not consume the
 * attempt: a stale tab must not kill the person's pending sign-in.
 */
export async function startLoopbackRedirectListener({
  expectedState,
  lifetimeMs = LOOPBACK_LIFETIME_MS,
}: {
  expectedState: string
  lifetimeMs?: number
}): Promise<LoopbackRedirectListener | Error> {
  let consumed = false
  let deliver: ((delivery: LoopbackDelivery | DeviceConnectError) => void) | undefined
  const result = new Promise<LoopbackDelivery | DeviceConnectError>((resolve) => {
    deliver = resolve
  })

  const server = http.createServer((req, res) => {
    void handleRedirect(req, res).catch(() => {
      errore.try({ try: () => {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Something went wrong.')
      }, catch: () => undefined })
    })
  })

  const bound = await new Promise<Error | null>((resolve) => {
    server.once('error', (error: unknown) => resolve(error instanceof Error ? error : new Error(String(error))))
    server.listen(0, LOOPBACK_HOST, () => resolve(null))
  })
  if (bound) {
    errore.try({ try: () => server.close(), catch: () => undefined })
    return bound
  }
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) {
    errore.try({ try: () => server.close(), catch: () => undefined })
    return new Error('Could not determine the loopback listener port.')
  }
  const redirectUri = `http://${LOOPBACK_HOST}:${port}${LOOPBACK_REDIRECT_PATH}`

  const finish = (outcome: LoopbackDelivery | DeviceConnectError): void => {
    if (!deliver) return
    clearTimeout(timer)
    const resolve = deliver
    deliver = undefined
    resolve(outcome)
  }
  // unref: an abandoned attempt must never keep the process alive.
  const timer = setTimeout(() => finish(new DeviceConnectError('expired', 'The sign-in window ran out before the redirect arrived.')), Math.max(1, lifetimeMs))
  timer.unref?.()
  server.unref()

  async function handleRedirect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Method not allowed.')
      return
    }
    const url = errore.try({ try: () => new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`), catch: () => null })
    if (!url || url.pathname !== LOOPBACK_REDIRECT_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found.')
      return
    }
    if (consumed) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`This sign-in was already completed. ${CLOSE_TAB_PAGE}`)
      return
    }
    const code = url.searchParams.get('code')?.trim() ?? ''
    const state = url.searchParams.get('state')?.trim() ?? ''
    const oauthError = url.searchParams.get('error')?.trim() ?? ''
    if (oauthError) {
      // The authorization server sent the person back with an error
      // (RFC 6749 §4.1.2.1): that ends the attempt.
      consumed = true
      const denied = oauthError === 'access_denied'
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`${denied ? 'Sign-in was denied.' : 'The sign-in failed.'} ${CLOSE_TAB_PAGE}`)
      finish(new DeviceConnectError(denied ? 'denied' : 'authorization', denied ? 'Sign-in was denied.' : 'The authorization server reported an error at the redirect.'))
      return
    }
    if (!code || !state) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`This URL is missing the sign-in details. ${CLOSE_TAB_PAGE}`)
      return
    }
    if (state !== expectedState) {
      // Not our redirect (a stale tab, a foreign attempt): refuse it and keep
      // waiting. The pending sign-in must not die because of someone else's
      // link; the state check plus the PKCE verifier keep this safe.
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`This sign-in link was not started by this connect attempt. ${CLOSE_TAB_PAGE}`)
      return
    }
    consumed = true
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`Signed in. ${CLOSE_TAB_PAGE}`)
    finish({ code, state })
  }

  return {
    redirectUri,
    wait: () => result,
    async close() {
      finish(new DeviceConnectError('aborted', 'Sign-in was cancelled.'))
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      server.closeAllConnections?.()
    },
  }
}

// ── Orchestration ───────────────────────────────────────────────

export type ConnectTarget = {
  /** Server name from the person's mcp_servers. */
  name: string
  url: string
  /** Stored credential name. */
  credential: string
}

export type DeviceConnectPrompt = {
  verificationUri: string
  verificationUriComplete?: string
  userCode: string
  /** Epoch ms after which the code is no longer valid. */
  expiresAt: number
}

export type DeviceConnectSession = {
  prompt: DeviceConnectPrompt
  /** Poll until the person approves (token stored) or the flow ends. */
  complete(options?: DeviceGrantCompleteOptions): Promise<void | DeviceConnectError>
}

export type DeviceGrantCompleteOptions = {
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  /** Stop earlier than the device code expiry (e.g. chat reply token lifetime). */
  maxWaitMs?: number
}

/**
 * A token obtained by the device grant, with what is needed to refresh or
 * revoke it. Never log it.
 */
export type DeviceGrantToken = {
  access: string
  /** Epoch ms. */
  expires?: number
  refresh?: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  revocationEndpoint?: string
}

export type DeviceGrantSession = {
  prompt: DeviceConnectPrompt
  /** Poll until the person approves (returns the token, unstored) or the flow ends. */
  complete(options?: DeviceGrantCompleteOptions): Promise<DeviceGrantToken | DeviceConnectError>
}

/**
 * Everything the device grant needs after discovery: register the device
 * client and ask for a device code. The unsupported check is the caller's
 * (beginDeviceGrant wants device-specific refusal reasons).
 */
async function deviceGrantSession({
  discovery,
  dataDir,
  fetchImpl,
  now,
}: {
  discovery: McpAuthDiscovery
  dataDir: string
  fetchImpl: ConnectFetch
  now: () => number
}): Promise<DeviceGrantSession | DeviceConnectError> {
  const server = discovery.authorizationServer
  const scope = discovery.scopes?.join(' ')
  let client = await getOrRegisterClient({ dataDir, server, fetchImpl })
  if (client instanceof Error) return client
  let authorization = await requestDeviceAuthorization({
    endpoint: server.deviceAuthorizationEndpoint!,
    client,
    scope,
    resource: discovery.resource,
    fetchImpl,
  })
  if (authorization instanceof Error && authorization.message === 'invalid_client') {
    // The server forgot our cached registration: register again once.
    forgetRegisteredClient({ dataDir, server })
    client = await getOrRegisterClient({ dataDir, server, fetchImpl })
    if (client instanceof Error) return client
    authorization = await requestDeviceAuthorization({
      endpoint: server.deviceAuthorizationEndpoint!,
      client,
      scope,
      resource: discovery.resource,
      fetchImpl,
    })
  }
  if (authorization instanceof Error) {
    return authorization.message === 'invalid_client'
      ? new DeviceConnectError('authorization', 'The server rejected Roadie as a client.')
      : authorization
  }

  const registered = client
  const device = authorization
  const startedAt = now()
  const expiresAt = startedAt + device.expiresInSeconds * 1000
  return {
    prompt: {
      verificationUri: device.verificationUri,
      ...(device.verificationUriComplete ? { verificationUriComplete: device.verificationUriComplete } : {}),
      userCode: device.userCode,
      expiresAt,
    },
    async complete({ signal, sleep, maxWaitMs } = {}) {
      const deadline = maxWaitMs ? Math.min(expiresAt, startedAt + maxWaitMs) : expiresAt
      const token = await pollDeviceToken({
        tokenEndpoint: server.tokenEndpoint,
        client: registered,
        deviceCode: device.deviceCode,
        intervalSeconds: device.intervalSeconds,
        deadline,
        resource: discovery.resource,
        fetchImpl,
        now,
        ...(sleep ? { sleep } : {}),
        ...(signal ? { signal } : {}),
      })
      if (token instanceof Error) return token
      return {
        access: token.access,
        ...(token.expires ? { expires: token.expires } : {}),
        ...(token.refresh ? { refresh: token.refresh } : {}),
        tokenEndpoint: server.tokenEndpoint,
        clientId: registered.clientId,
        ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}),
        ...(server.revocationEndpoint ? { revocationEndpoint: server.revocationEndpoint } : {}),
      }
    },
  }
}

/**
 * Start a device grant against the authorization server of an OAuth-protected
 * resource (an MCP server URL): discovery, client registration and device
 * authorization. `complete()` polls and returns the token without storing it;
 * the caller decides where it goes (beginDeviceConnect stores it for a person,
 * identity linking hands it to the host first). Device-only by design: servers
 * without a device grant are refused here even when /connect could fall back
 * to authorization code + PKCE, because identity linking has no redirect
 * receiver to take a browser code.
 */
export async function beginDeviceGrant({
  dataDir,
  resourceUrl,
  fetchImpl = defaultFetch(),
  now = () => Date.now(),
}: {
  dataDir: string
  resourceUrl: string
  fetchImpl?: ConnectFetch
  now?: () => number
}): Promise<DeviceGrantSession | DeviceConnectError> {
  const discovery = await discoverMcpAuthorization({ mcpUrl: resourceUrl, fetchImpl })
  if (discovery instanceof Error) return discovery
  const unsupported = deviceFlowUnsupportedReason(discovery.authorizationServer)
  if (unsupported) return new DeviceConnectError('unsupported', unsupported)
  return await deviceGrantSession({ discovery, dataDir, fetchImpl, now })
}

/**
 * Everything the authorization code grant needs after discovery: bind the
 * loopback receiver, register the authorization-code client for its redirect
 * and build the sign-in URL. `complete()` waits for the code (listener or
 * pasted redirect) and exchanges it once; the token is returned unstored.
 */
async function authorizationCodeGrantSession({
  discovery,
  dataDir,
  fetchImpl,
  now,
  listenerLifetimeMs,
}: {
  discovery: McpAuthDiscovery
  dataDir: string
  fetchImpl: ConnectFetch
  now: () => number
  listenerLifetimeMs: number
}): Promise<AuthorizationCodeGrantSession | DeviceConnectError> {
  const server = discovery.authorizationServer
  const state = createState()
  const listener = await startLoopbackRedirectListener({ expectedState: state, lifetimeMs: listenerLifetimeMs })
  if (listener instanceof Error) {
    return new DeviceConnectError('failed', 'Could not listen for the sign-in redirect on this machine.', { cause: listener })
  }
  const client = await getOrRegisterAuthorizationCodeClient({ dataDir, server, redirectUri: listener.redirectUri, fetchImpl })
  if (client instanceof Error) {
    await listener.close()
    return client
  }
  // Captured under their narrowed types for the closures below (narrowing of
  // `client`/`listener` does not carry into nested functions).
  const registered = client
  const receiver = listener
  // The challenge goes in the URL; the verifier stays here until the exchange.
  const { verifier, challenge } = createPkcePair()
  const signInUrl = buildAuthorizationUrl({
    endpoint: server.authorizationEndpoint!,
    clientId: client.clientId,
    redirectUri: listener.redirectUri,
    state,
    codeChallenge: challenge,
    ...(discovery.scopes?.length ? { scope: discovery.scopes.join(' ') } : {}),
    resource: discovery.resource,
  })
  const startedAt = now()
  const expiresAt = startedAt + listenerLifetimeMs

  // Whichever code arrives first wins: the loopback receiver or a pasted
  // redirect. One exchange per attempt, guarded by `settled`.
  let settled = false
  let pasteResolve: ((delivery: { code: string } | DeviceConnectError) => void) | undefined
  const pasted = new Promise<{ code: string } | DeviceConnectError>((resolve) => {
    pasteResolve = resolve
  })

  async function exchangeOnce(code: string): Promise<DeviceGrantToken | DeviceConnectError> {
    if (settled) return new DeviceConnectError('failed', 'This sign-in already finished.')
    settled = true
    const token = await exchangeAuthorizationCode({
      tokenEndpoint: server.tokenEndpoint,
      client: registered,
      code,
      codeVerifier: verifier,
      redirectUri: receiver.redirectUri,
      resource: discovery.resource,
      fetchImpl,
      now,
    })
    if (token instanceof Error && token.code === 'registration') {
      // The server forgot our cached registration: drop it so the next
      // attempt registers afresh. This attempt cannot be saved: the code is
      // bound to the client it was issued to.
      forgetRegisteredClient({ dataDir, server, variant: `authorization_code\n${receiver.redirectUri}` })
    }
    if (token instanceof Error) return token
    return {
      access: token.access,
      ...(token.expires ? { expires: token.expires } : {}),
      ...(token.refresh ? { refresh: token.refresh } : {}),
      tokenEndpoint: server.tokenEndpoint,
      clientId: registered.clientId,
      ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}),
      ...(server.revocationEndpoint ? { revocationEndpoint: server.revocationEndpoint } : {}),
    }
  }

  return {
    prompt: { signInUrl, expiresAt },
    redirectUri: receiver.redirectUri,
    async complete({ signal, maxWaitMs } = {}) {
      const deadline = Math.min(expiresAt, startedAt + (maxWaitMs ?? Number.POSITIVE_INFINITY))
      return await new Promise<DeviceGrantToken | DeviceConnectError>((resolve) => {
        if (settled) {
          resolve(new DeviceConnectError('failed', 'This sign-in already finished.'))
          return
        }
        let done = false
        let timer: NodeJS.Timeout | undefined
        const onAbort = () => finish(new DeviceConnectError('aborted', 'Sign-in was cancelled.'))
        const finish = (outcome: DeviceGrantToken | DeviceConnectError) => {
          if (done) return
          done = true
          settled = true
          if (timer) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          void receiver.close()
          resolve(outcome)
        }
        timer = setTimeout(() => finish(new DeviceConnectError('expired', 'The sign-in expired before it was approved.')), Math.max(1, deadline - now()))
        if (signal) {
          if (signal.aborted) {
            finish(new DeviceConnectError('aborted', 'Sign-in was cancelled.'))
            return
          }
          signal.addEventListener('abort', onAbort)
        }
        void Promise.race([receiver.wait(), pasted]).then(async (delivery) => {
          if (delivery instanceof Error) {
            finish(delivery)
            return
          }
          finish(await exchangeOnce(delivery.code))
        })
      })
    },
    async submitRedirectUrl(url) {
      if (settled) return { status: 'late' }
      const parsed = parseAuthorizationCodeRedirect(url)
      if (parsed instanceof Error) return { status: 'invalid' }
      if (parsed.state !== state) return { status: 'mismatch' }
      pasteResolve!({ code: parsed.code })
      return { status: 'accepted' }
    },
  }
}

/**
 * Pick the grant this server supports and start it, returning the session
 * with an unstored token: device when offered, else authorization code +
 * S256 PKCE. The platform layer (person-connect) renders whichever prompt
 * the session carries and decides where the token goes.
 */
export async function beginOAuthGrant({
  dataDir,
  resourceUrl,
  fetchImpl = defaultFetch(),
  now = () => Date.now(),
  listenerLifetimeMs = LOOPBACK_LIFETIME_MS,
}: {
  dataDir: string
  resourceUrl: string
  fetchImpl?: ConnectFetch
  now?: () => number
  listenerLifetimeMs?: number
}): Promise<OAuthGrantSelection | DeviceConnectError> {
  const discovery = await discoverMcpAuthorization({ mcpUrl: resourceUrl, fetchImpl })
  if (discovery instanceof Error) return discovery
  const selected = selectConnectGrant(discovery.authorizationServer)
  if (selected instanceof Error) return selected
  if (selected.grant === 'device') {
    const session = await deviceGrantSession({ discovery, dataDir, fetchImpl, now })
    return session instanceof Error ? session : { grant: 'device', session }
  }
  const session = await authorizationCodeGrantSession({ discovery, dataDir, fetchImpl, now, listenerLifetimeMs })
  return session instanceof Error ? session : { grant: 'authorization_code', session }
}

/** Store a person's token under their own person key and the server's credential name. */
async function storePersonToken({
  dataDir,
  personKey,
  target,
  token,
}: {
  dataDir: string
  personKey: string
  target: ConnectTarget
  token: DeviceGrantToken
}): Promise<void | DeviceConnectError> {
  const stored = await setPersonMcpToken({ dataDir, personKey, credential: target.credential, token })
  if (stored instanceof Error) {
    return new DeviceConnectError('failed', 'Could not store the credential.', { cause: stored })
  }
  return undefined
}

/**
 * Start connecting `personKey` to one MCP server: discovery, client
 * registration and device authorization. The returned prompt is shown to the
 * person privately; `complete()` polls and stores their token under their own
 * person key and the server's credential name.
 */
export async function beginDeviceConnect({
  dataDir,
  personKey,
  target,
  fetchImpl = defaultFetch(),
  now = () => Date.now(),
}: {
  dataDir: string
  personKey: string
  target: ConnectTarget
  fetchImpl?: ConnectFetch
  now?: () => number
}): Promise<DeviceConnectSession | DeviceConnectError> {
  if (!personKey.trim()) return new DeviceConnectError('failed', 'Could not resolve your account.')
  const grant = await beginDeviceGrant({ dataDir, resourceUrl: target.url, fetchImpl, now })
  if (grant instanceof Error) return grant
  return {
    prompt: grant.prompt,
    async complete(options = {}) {
      const token = await grant.complete(options)
      if (token instanceof Error) return token
      return await storePersonToken({ dataDir, personKey, target, token })
    },
  }
}

export type OAuthGrantSelection =
  | { grant: 'device'; session: DeviceGrantSession }
  | { grant: 'authorization_code'; session: AuthorizationCodeGrantSession }

export type AuthorizationCodeRedirectOutcome =
  /** The redirect parsed, its state matched; the exchange is running. */
  | { status: 'accepted' }
  /** Not a redirect URL (or missing code/state); the person can try again. */
  | { status: 'invalid' }
  /** The redirect was for a different attempt; the pending sign-in stays open. */
  | { status: 'mismatch' }
  /** This attempt already finished or expired. */
  | { status: 'late' }

export type AuthorizationCodeGrantSession = {
  prompt: AuthorizationCodePrompt
  /** The loopback redirect URI this attempt listens on. */
  redirectUri: string
  /** Wait for the code (listener or pasted redirect), exchange it, return it unstored. */
  complete(options?: { signal?: AbortSignal; maxWaitMs?: number }): Promise<DeviceGrantToken | DeviceConnectError>
  /** A redirect URL the person pasted: parse, validate state, exchange once. */
  submitRedirectUrl(url: string): Promise<AuthorizationCodeRedirectOutcome>
}

export type AuthorizationCodePrompt = {
  /** The authorization URL. Show it to the person privately, never in a channel. */
  signInUrl: string
  /** Epoch ms after which the attempt (and its loopback receiver) is dead. */
  expiresAt: number
}

/**
 * Start connecting `personKey` to one MCP server with whichever grant the
 * server supports (device first, else authorization code + S256 PKCE). The
 * prompt is shown to the person privately; `complete()` waits for their
 * approval and stores the token under their own person key. For the
 * authorization-code grant, `submitRedirectUrl` feeds in a redirect URL the
 * person pasted (their browser may not be able to reach this host).
 */
export async function beginOAuthConnect({
  dataDir,
  personKey,
  target,
  fetchImpl = defaultFetch(),
  now = () => Date.now(),
  listenerLifetimeMs = LOOPBACK_LIFETIME_MS,
}: {
  dataDir: string
  personKey: string
  target: ConnectTarget
  fetchImpl?: ConnectFetch
  now?: () => number
  listenerLifetimeMs?: number
}): Promise<OAuthConnectSession | DeviceConnectError> {
  if (!personKey.trim()) return new DeviceConnectError('failed', 'Could not resolve your account.')
  const selection = await beginOAuthGrant({ dataDir, resourceUrl: target.url, fetchImpl, now, listenerLifetimeMs })
  if (selection instanceof Error) return selection
  if (selection.grant === 'device') {
    const grant = selection.session
    return {
      grant: 'device',
      prompt: grant.prompt,
      async complete(options = {}) {
        const token = await grant.complete(options)
        if (token instanceof Error) return token
        return await storePersonToken({ dataDir, personKey, target, token })
      },
    }
  }
  const grant = selection.session
  return {
    grant: 'authorization_code',
    prompt: grant.prompt,
    redirectUri: grant.redirectUri,
    async complete(options = {}) {
      const token = await grant.complete(options)
      if (token instanceof Error) return token
      return await storePersonToken({ dataDir, personKey, target, token })
    },
    submitRedirectUrl: (url) => grant.submitRedirectUrl(url),
  }
}

export type OAuthConnectSession =
  | {
      grant: 'device'
      prompt: DeviceConnectPrompt
      complete(options?: DeviceGrantCompleteOptions): Promise<void | DeviceConnectError>
    }
  | {
      grant: 'authorization_code'
      prompt: AuthorizationCodePrompt
      redirectUri: string
      complete(options?: { signal?: AbortSignal; maxWaitMs?: number }): Promise<void | DeviceConnectError>
      submitRedirectUrl(url: string): Promise<AuthorizationCodeRedirectOutcome>
    }

/**
 * Revoke a token at its authorization server (RFC 7009), best effort: the
 * refresh token when there is one (revoking it ends the grant), else the
 * access token. Returns whether the server accepted the revocation. Never
 * throws and never logs the token.
 */
export async function revokeOAuthToken({
  token,
  fetchImpl = defaultFetch(),
}: {
  token: {
    access: string
    refresh?: string
    clientId?: string
    clientSecret?: string
    revocationEndpoint?: string
  }
  fetchImpl?: ConnectFetch
}): Promise<boolean> {
  if (!token.revocationEndpoint || !isAllowedMcpUrl(token.revocationEndpoint)) return false
  const response = await request(fetchImpl, token.revocationEndpoint, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: form({
      token: token.refresh ?? token.access,
      token_type_hint: token.refresh ? 'refresh_token' : 'access_token',
      client_id: token.clientId,
      client_secret: token.clientSecret,
    }),
  })
  return !(response instanceof Error) && response.ok
}

/**
 * Remove a person's stored token for one credential, revoking it first (best
 * effort) when the record names a revocation endpoint.
 */
export async function disconnectPersonMcp({
  dataDir,
  personKey,
  credential,
  fetchImpl = defaultFetch(),
}: {
  dataDir: string
  personKey: string
  credential: string
  fetchImpl?: ConnectFetch
}): Promise<{ removed: boolean; revoked: boolean } | Error> {
  const record = readPersonMcpToken({ dataDir, personKey, credential })
  const removed = await removePersonMcpToken({ dataDir, personKey, credential })
  if (removed instanceof Error) return removed
  const revoked = record ? await revokeOAuthToken({ token: record, fetchImpl }) : false
  return { removed, revoked }
}
