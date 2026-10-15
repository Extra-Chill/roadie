// Connect a person's own account to a person-scoped MCP server (OAuth device grant).
//
// Everything is discovered from the MCP server itself; nothing here knows a
// vendor:
//
//   1. Discovery. Request the MCP endpoint unauthenticated (JSON-RPC
//      `initialize`) and read `WWW-Authenticate: Bearer resource_metadata="…"`
//      (RFC 9728). Without that header, fall back to the well-known protected
//      resource metadata URLs. Take `authorization_servers[0]` and fetch its
//      metadata (RFC 8414, falling back to OpenID Connect discovery).
//   2. The server must advertise a `device_authorization_endpoint` and the
//      device_code grant (RFC 8628); otherwise the flow is unsupported.
//   3. Dynamic client registration (RFC 7591) as a public client
//      (`token_endpoint_auth_method: none`), cached per authorization server in
//      `<dataDir>/mcp-clients/` (0600, atomic writes).
//   4. Device authorization request. The caller shows `verification_uri_complete`
//      (or `verification_uri` + `user_code`) privately to the person.
//   5. Poll the token endpoint at `interval`, honouring `authorization_pending`
//      and `slow_down`, until success, `expired_token`, `access_denied` or the
//      `expires_in` deadline. The token is stored for the person through
//      person-mcp-store (setPersonMcpToken).
//
// Disconnect removes the stored token and, when the authorization server has a
// `revocation_endpoint` (RFC 7009), revokes it best effort.
//
// Every URL must pass isAllowedMcpUrl (https, http only for loopback), every
// request has a timeout, and no token, device code or client secret is ever
// logged or put into an error message. fetch is injectable for tests.

import crypto from 'node:crypto'
import fs from 'node:fs'
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
export const CLIENT_NAME = 'Roadie'
const HTTP_TIMEOUT_MS = 15_000
const DEFAULT_INTERVAL_SECONDS = 5
const SLOW_DOWN_SECONDS = 5
const DEFAULT_DEVICE_EXPIRES_SECONDS = 600
const MAX_TRANSIENT_POLL_FAILURES = 3
const MCP_PROTOCOL_VERSION = '2025-06-18'

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
  registrationEndpoint?: string
  revocationEndpoint?: string
  grantTypesSupported?: string[]
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
      ...optional('registrationEndpoint', allowedOrUndefined(str(serverMetadata, 'registration_endpoint'))),
      ...optional('revocationEndpoint', allowedOrUndefined(str(serverMetadata, 'revocation_endpoint'))),
      ...optional('grantTypesSupported', strArray(serverMetadata, 'grant_types_supported')),
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

// ── 3. Dynamic client registration (cached) ─────────────────────

function clientCachePath({ dataDir, issuer, registrationEndpoint }: { dataDir: string; issuer: string; registrationEndpoint: string }): string {
  const hash = crypto.createHash('sha256').update(`${issuer}\n${registrationEndpoint}`).digest('hex').slice(0, 32)
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

/** Drop the cached client for a server (e.g. after `invalid_client`). */
export function forgetRegisteredClient({ dataDir, server }: { dataDir: string; server: AuthorizationServerMetadata }): void {
  if (!server.registrationEndpoint) return
  const filePath = clientCachePath({ dataDir, issuer: server.issuer, registrationEndpoint: server.registrationEndpoint })
  errore.try({ try: () => fs.rmSync(filePath, { force: true }), catch: () => undefined })
}

/** The cached public client for this authorization server, registering one if needed. */
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
  const registrationEndpoint = server.registrationEndpoint
  if (!registrationEndpoint) {
    return new DeviceConnectError('unsupported', 'This server does not allow client registration.')
  }
  const filePath = clientCachePath({ dataDir, issuer: server.issuer, registrationEndpoint })
  return await withPoolLock(`mcp-client:${filePath}`, async () => {
    const cached = readCachedClient(filePath)
    if (cached) return cached
    const response = await request(fetchImpl, registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        token_endpoint_auth_method: 'none',
        grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
      }),
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
 * Start a device grant against the authorization server of an OAuth-protected
 * resource (an MCP server URL): discovery, client registration and device
 * authorization. `complete()` polls and returns the token without storing it;
 * the caller decides where it goes (beginDeviceConnect stores it for a person,
 * identity linking hands it to the host first).
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
  const server = discovery.authorizationServer
  const unsupported = deviceFlowUnsupportedReason(server)
  if (unsupported) return new DeviceConnectError('unsupported', unsupported)

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
      const stored = await setPersonMcpToken({ dataDir, personKey, credential: target.credential, token })
      if (stored instanceof Error) {
        return new DeviceConnectError('failed', 'Could not store the credential.', { cause: stored })
      }
      return undefined
    },
  }
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
