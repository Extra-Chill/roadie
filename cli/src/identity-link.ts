// Self-serve identity linking (issue #292).
//
// A chat actor the identity layer denies (nobody vouches for them yet) proves
// who they are with the host's own sign-in, and the host links their chat
// identity. That replaces "send an admin your ID". Two host filters, both
// vendor-neutral:
//
//   identity_link_provider  (null, { actor, context })
//       -> { url, name?, credential? } | null
//     `url` is an OAuth-protected resource, typically a person MCP server
//     URL. Roadie discovers its authorization server exactly as /connect does
//     (credentials/mcp-device-connect.ts). null (or no filter): nothing
//     changes, linking is not offered.
//
//   link_identity  (null, { actor, context, token })
//       -> { linked: true } | { linked: false, reason }
//     `token` is { access, refresh?, expires?, tokenEndpoint?, clientId?,
//     revocationEndpoint? }. The host verifies the token and records the
//     link. A null or malformed result counts as not linked.
//
// Flow: device grant (verification link shown to the actor only), poll, then
// link_identity. On `linked: true` the actor's identity cache entry is
// dropped and the person resolved again. If they are now allowed and one of
// their mcp_servers has the provider's url, the token is stored as that
// person's MCP credential, so one sign-in covers link and connect; then the
// first-contact welcome goes out. Otherwise (`linked: false`, or linked but
// the token has no server to live on) the token is revoked best effort and
// never stored.
//
// Rules shared with /connect (person-connect.ts): the actor is always the
// clicking or calling user, never something carried in a button; prompts are
// private; tokens are never logged, shown or put in an error message.
//
// This module is platform-neutral. Discord renders it in commands/link.ts.

import { getDataDir } from './config.js'
import { personKeyFrom } from './credentials/person-pool.js'
import { isAllowedMcpUrl, setPersonMcpToken } from './credentials/person-mcp-store.js'
import {
  beginDeviceGrant,
  revokeOAuthToken,
  type ConnectFetch,
  type DeviceGrantToken,
} from './credentials/mcp-device-connect.js'
import { applyFiltersAsync } from './hooks.js'
import {
  clearIdentityCache,
  IDENTITY_LOOKUP_FAILED_MESSAGE,
  isIdentityHookConfigured,
  resolvePerson,
  type IdentityActor,
  type IdentityContext,
  type Person,
  type PersonMcpServer,
} from './identity.js'
import { formatConnectPrompt } from './person-connect.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.DISCORD)

// ── Contract ────────────────────────────────────────────────────

/** Value of the `identity_link_provider` filter. */
export type IdentityLinkProvider = {
  /** OAuth-protected resource (typically a person MCP server URL). */
  url: string
  /** Display name of the sign-in, e.g. the host's name. */
  name?: string
  /** Credential name of the matching person MCP server, when several share the url. */
  credential?: string
}

/** Token handed to `link_identity`. A secret: never log or persist it. */
export type IdentityLinkToken = {
  access: string
  refresh?: string
  /** Epoch ms. */
  expires?: number
  tokenEndpoint?: string
  clientId?: string
  revocationEndpoint?: string
}

/** Context of the `link_identity` filter. */
export type IdentityLinkContext = {
  actor: IdentityActor
  context: IdentityContext
  token: IdentityLinkToken
}

/** Value of the `link_identity` filter. */
export type IdentityLinkResult = { linked: true } | { linked: false; reason: string }

// ── Messages ────────────────────────────────────────────────────

export const LINK_NOT_AVAILABLE_MESSAGE = 'Account linking is not available on this server.'
export const LINK_ALREADY_LINKED_MESSAGE = 'Your account is already linked.'
export const LINK_STILL_DENIED_MESSAGE = "Linked. You don't have access yet; ask an admin."
const LINK_DEFAULT_REJECTION = 'The sign-in could not be linked to an account.'

/** How long one actor waits between unprompted link prompts. */
export const LINK_PROMPT_INTERVAL_MS = 10 * 60_000

// ── Who and what ────────────────────────────────────────────────

/**
 * Whether an actor may be offered linking: a platform-authenticated human the
 * identity layer denied. Not lookup failures (nobody could check), not
 * CLI-asserted actors, not bots, not people already allowed, and nothing
 * without an identity layer.
 */
export function isLinkCandidate({
  person,
  via = 'chat',
  isBot = false,
}: {
  person: Person | null | undefined
  via?: 'chat' | 'cli'
  isBot?: boolean
}): boolean {
  if (via !== 'chat' || isBot) return false
  if (!isIdentityHookConfigured()) return false
  if (!person) return false
  return !person.allowed && !person.lookupFailed
}

/** The host's link provider for this actor, or null. An invalid url is ignored. */
export async function resolveIdentityLinkProvider({
  actor,
  context,
}: {
  actor: IdentityActor
  context: IdentityContext
}): Promise<IdentityLinkProvider | null> {
  const value = await applyFiltersAsync('identity_link_provider', null, { actor, context })
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return null
  if (!isAllowedMcpUrl(value.url)) {
    logger.warn('[LINK] identity_link_provider returned a url that is not https; linking not offered')
    return null
  }
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : undefined
  const credential = typeof value.credential === 'string' && value.credential.trim() ? value.credential.trim() : undefined
  return { url: value.url, ...(name ? { name } : {}), ...(credential ? { credential } : {}) }
}

// ── Rate limit for unprompted link prompts ──────────────────────

const lastPromptAt = new Map<string, number>()

function actorKey(actor: IdentityActor): string {
  return `${actor.platform}:${actor.id}`
}

/** True when this actor has not been prompted within the interval. Does not record. */
export function canPromptLink(actor: IdentityActor, now = Date.now()): boolean {
  const last = lastPromptAt.get(actorKey(actor))
  return last === undefined || now - last >= LINK_PROMPT_INTERVAL_MS
}

/** Record that this actor was just prompted. */
export function recordLinkPrompt(actor: IdentityActor, now = Date.now()): void {
  lastPromptAt.set(actorKey(actor), now)
  // Keep the map small: drop entries past the interval.
  if (lastPromptAt.size > 1000) {
    for (const [key, at] of lastPromptAt) {
      if (now - at >= LINK_PROMPT_INTERVAL_MS) lastPromptAt.delete(key)
    }
  }
}

/**
 * Decide whether to show an unprompted link prompt to this actor now: a link
 * candidate, not prompted recently, with a provider configured. Records the
 * prompt when it returns a provider.
 */
export async function claimLinkPrompt({
  actor,
  context,
  person,
  via,
  isBot,
  now = Date.now(),
}: {
  actor: IdentityActor
  context: IdentityContext
  person: Person | null | undefined
  via?: 'chat' | 'cli'
  isBot?: boolean
  now?: number
}): Promise<IdentityLinkProvider | null> {
  if (!isLinkCandidate({ person, ...(via ? { via } : {}), ...(isBot !== undefined ? { isBot } : {}) })) return null
  if (!canPromptLink(actor, now)) return null
  const provider = await resolveIdentityLinkProvider({ actor, context })
  if (!provider) return null
  recordLinkPrompt(actor, now)
  return provider
}

/** Tests only. */
export function resetLinkPromptRateLimit(): void {
  lastPromptAt.clear()
}

// ── Text ────────────────────────────────────────────────────────

export function linkPromptText(provider: IdentityLinkProvider): string {
  const via = provider.name ? ` with your **${provider.name}** account` : ''
  return [
    "You don't have access to Roadie yet.",
    `If you already have an account, sign in${via} to link it to this chat account.`,
  ].join('\n')
}

export const LINK_BUTTON_LABEL = 'Link your account'

// ── Completing a link ───────────────────────────────────────────

export type IdentityLinkOutcome = {
  status: 'allowed' | 'still_denied' | 'lookup_failed' | 'rejected'
  /** User-facing line. */
  text: string
  /** The token was stored as the person's MCP credential (allowed only). */
  storedServer?: string
  /** The token was revoked at the authorization server (best effort). */
  revoked?: boolean
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href.replace(/\/+$/, '')
  } catch {
    return value
  }
}

/** The person's MCP server that the provider's url names, if any. */
export function matchLinkServer({
  servers,
  provider,
}: {
  servers: readonly PersonMcpServer[] | undefined
  provider: IdentityLinkProvider
}): PersonMcpServer | undefined {
  const target = normalizeUrl(provider.url)
  const matches = (servers ?? []).filter((server) => normalizeUrl(server.url) === target)
  if (provider.credential) {
    const preferred = matches.find((server) => server.credential === provider.credential)
    if (preferred) return preferred
  }
  return matches[0]
}

function normalizeLinkResult(value: unknown): IdentityLinkResult {
  if (value && typeof value === 'object' && (value as { linked?: unknown }).linked === true) return { linked: true }
  const reason = value && typeof value === 'object' ? (value as { reason?: unknown }).reason : undefined
  return {
    linked: false,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : LINK_DEFAULT_REJECTION,
  }
}

/** The token as `link_identity` receives it (no client secret). */
export function linkTokenFrom(token: DeviceGrantToken): IdentityLinkToken {
  return {
    access: token.access,
    ...(token.refresh ? { refresh: token.refresh } : {}),
    ...(token.expires ? { expires: token.expires } : {}),
    tokenEndpoint: token.tokenEndpoint,
    clientId: token.clientId,
    ...(token.revocationEndpoint ? { revocationEndpoint: token.revocationEndpoint } : {}),
  }
}

/**
 * Hand an obtained token to the host (`link_identity`) and act on the answer.
 * `welcome` sends the first-contact welcome on the actor's platform; it gets
 * the freshly resolved, allowed person. Never throws.
 */
export async function completeIdentityLink({
  actor,
  context,
  provider,
  token,
  welcome,
  dataDir = getDataDir(),
  fetchImpl,
}: {
  actor: IdentityActor
  context: IdentityContext
  provider: IdentityLinkProvider
  token: DeviceGrantToken
  welcome: (person: Person) => Promise<unknown>
  dataDir?: string
  fetchImpl?: ConnectFetch
}): Promise<IdentityLinkOutcome> {
  const revoke = async () =>
    await revokeOAuthToken({ token, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => false)

  let threw = false
  const raw = await applyFiltersAsync(
    'link_identity',
    null,
    { actor, context, token: linkTokenFrom(token) },
    { onError: () => { threw = true } },
  )
  const result = threw && !raw ? { linked: false as const, reason: LINK_DEFAULT_REJECTION } : normalizeLinkResult(raw)
  if (!result.linked) {
    const revoked = await revoke()
    logger.log(`[LINK] ${actor.platform}:${actor.id} sign-in was not linked`)
    return { status: 'rejected', text: `Could not link your account: ${result.reason}`, revoked }
  }

  logger.log(`[LINK] ${actor.platform}:${actor.id} linked`)
  clearIdentityCache(actor)
  const person = await resolvePerson({ actor, context })

  if (!person?.allowed) {
    const revoked = await revoke()
    if (person?.lookupFailed) {
      return {
        status: 'lookup_failed',
        text: `Linked. ${IDENTITY_LOOKUP_FAILED_MESSAGE}`,
        revoked,
      }
    }
    return { status: 'still_denied', text: LINK_STILL_DENIED_MESSAGE, revoked }
  }

  // One sign-in covers link and connect: keep the token as the person's MCP
  // credential when one of their servers is the provider's resource.
  let storedServer: string | undefined
  const server = matchLinkServer({ servers: person.mcpServers, provider })
  const personKey = personKeyFrom({ personId: person.personId, platform: actor.platform, actorId: actor.id })
  if (server && personKey) {
    const stored = await setPersonMcpToken({ dataDir, personKey, credential: server.credential, token })
    if (stored instanceof Error) logger.warn(`[LINK] could not store the ${server.name} credential after linking`)
    else storedServer = server.name
  }
  const revoked = storedServer ? undefined : await revoke()

  await welcome(person).catch((error: unknown) => {
    logger.warn(`[LINK] welcome after linking failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  return {
    status: 'allowed',
    text: storedServer
      ? `Linked. You have access now, and **${storedServer}** is connected.`
      : 'Linked. You have access now.',
    ...(storedServer ? { storedServer } : {}),
    ...(revoked !== undefined ? { revoked } : {}),
  }
}

// ── The flow ────────────────────────────────────────────────────

/** Overridable for tests. */
let linkFetch: ConnectFetch | undefined
let linkSleep: ((ms: number) => Promise<void>) | undefined
export function setLinkFetchForTests(fetchImpl: ConnectFetch | undefined, sleep?: (ms: number) => Promise<void>): void {
  linkFetch = fetchImpl
  linkSleep = sleep
}

/** In-progress link flows per actor; a new attempt cancels the old. */
const activeLinks = new Map<string, AbortController>()

export type IdentityLinkStarted = {
  /** User-facing sign-in instructions (with the user code). Show privately. */
  text: string
  /** The sign-in page. Show privately. */
  link: string
}

/**
 * Start linking the actor (always the clicking or calling user): resolve them,
 * check they are a link candidate with a provider, and start the device grant.
 * Returns the private sign-in prompt, or an Error whose message is
 * user-facing. Polling continues in the background; `onDone` gets the outcome
 * (not called when a newer attempt for the same actor replaced this one).
 */
export async function startIdentityLink({
  actor,
  context,
  maxWaitMs,
  retryHint,
  welcome,
  onDone,
  isBot = false,
  dataDir = getDataDir(),
}: {
  actor: IdentityActor
  context: IdentityContext
  /** Stop polling earlier than the code expiry (chat reply lifetime). */
  maxWaitMs: number
  /** How to try again on this platform, e.g. "Run `/link` to try again." */
  retryHint: string
  welcome: (person: Person) => Promise<unknown>
  onDone: (outcome: IdentityLinkOutcome) => Promise<void>
  isBot?: boolean
  dataDir?: string
}): Promise<IdentityLinkStarted | Error> {
  if (isBot) return new Error(LINK_NOT_AVAILABLE_MESSAGE)
  if (!isIdentityHookConfigured()) return new Error(LINK_NOT_AVAILABLE_MESSAGE)
  const person = await resolvePerson({ actor, context })
  if (person?.lookupFailed) return new Error(IDENTITY_LOOKUP_FAILED_MESSAGE)
  if (person?.allowed) return new Error(LINK_ALREADY_LINKED_MESSAGE)
  if (!isLinkCandidate({ person })) return new Error(LINK_NOT_AVAILABLE_MESSAGE)
  const provider = await resolveIdentityLinkProvider({ actor, context })
  if (!provider) return new Error(LINK_NOT_AVAILABLE_MESSAGE)

  const key = actorKey(actor)
  activeLinks.get(key)?.abort()
  const controller = new AbortController()
  activeLinks.set(key, controller)
  const release = () => {
    if (activeLinks.get(key) === controller) activeLinks.delete(key)
  }

  const grant = await beginDeviceGrant({
    dataDir,
    resourceUrl: provider.url,
    ...(linkFetch ? { fetchImpl: linkFetch } : {}),
  })
  if (grant instanceof Error) {
    release()
    logger.warn(`[LINK] could not start sign-in: ${grant.message}`)
    return new Error(`Could not start sign-in: ${grant.message}`)
  }

  const label = provider.name ?? 'your account'
  const waitUntil = Math.min(grant.prompt.expiresAt, Date.now() + maxWaitMs)
  const started: IdentityLinkStarted = {
    text: formatConnectPrompt({ serverName: label, prompt: grant.prompt, waitUntil }).replace(
      /^Sign in to connect /,
      'Sign in to link ',
    ),
    link: grant.prompt.verificationUriComplete ?? grant.prompt.verificationUri,
  }

  void grant
    .complete({ signal: controller.signal, maxWaitMs, ...(linkSleep ? { sleep: linkSleep } : {}) })
    .then(async (token) => {
      if (token instanceof Error) {
        release()
        if (token.code === 'aborted') return
        logger.warn(`[LINK] sign-in ended: ${token.code}`)
        await onDone({ status: 'rejected', text: `Could not link your account: ${token.message} ${retryHint}` })
        return
      }
      const outcome = await completeIdentityLink({
        actor,
        context,
        provider,
        token,
        welcome,
        dataDir,
        ...(linkFetch ? { fetchImpl: linkFetch } : {}),
      })
      release()
      await onDone(outcome)
    })
    .catch((error: unknown) => {
      release()
      logger.warn(`[LINK] link flow failed: ${error instanceof Error ? error.message : String(error)}`)
    })

  return started
}
