// Platform-neutral core of "connect your own account" (issues #271, #284).
//
// A person connects their own account to the person-scoped MCP servers the
// identity layer names for them (`mcp_servers`) with the OAuth device grant.
// Discord (commands/connect.ts) and Slack (slack-connect.ts) render the list,
// buttons and sign-in prompt in their own way; everything that decides *who*
// and *what* lives here so both platforms behave the same:
//
// - Button ids (`roadie_connect:c|d:<server>`) carry only intent: which
//   server. They never carry a person.
// - Authority always comes from the clicking or calling user: the person key
//   is derived from the person the identity layer resolves for *that* user,
//   exactly like turns derive it (applyPersonToIngress), and the server must
//   be one of *their* servers. A forwarded or foreign button acts on the
//   clicker's own account, never on the original person's.
// - Tokens are never logged or shown; the person only sees the verification
//   link and user code. The OAuth work lives in credentials/mcp-device-connect.ts.

import { personKeyFrom } from './credentials/person-pool.js'
import { listPersonMcpCredentials } from './credentials/person-mcp-store.js'
import {
  beginDeviceConnect,
  disconnectPersonMcp,
  type ConnectFetch,
  type DeviceConnectPrompt,
} from './credentials/mcp-device-connect.js'
import type { IdentityActor, Person, PersonMcpServer } from './identity.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.MCP)

export const CONNECT_BUTTON_PREFIX = 'roadie_connect:'
const CONNECT_ACTION = 'c'
const DISCONNECT_ACTION = 'd'

// ── Who and what ────────────────────────────────────────────────

export type ConnectSpeaker = {
  personKey: string
  servers: readonly PersonMcpServer[]
}

/**
 * The speaker's own person key and MCP servers. Only allowed,
 * platform-authenticated people with servers qualify. The key derivation is
 * the one turns use, so the stored token is the one their turns read.
 */
export function resolveConnectSpeaker({
  person,
  actor,
}: {
  person: Person | null | undefined
  actor: IdentityActor
}): ConnectSpeaker | Error {
  if (!person?.allowed) return new Error('Your account is not linked to Roadie.')
  const servers = person.mcpServers ?? []
  if (servers.length === 0) return new Error('There are no services for you to connect.')
  const personKey = personKeyFrom({ personId: person.personId, platform: actor.platform, actorId: actor.id })
  if (!personKey) return new Error('Could not resolve your account.')
  return { personKey, servers }
}

/** The speaker's own server by name; a name outside their list is refused. */
export function resolveConnectTarget({
  person,
  actor,
  serverName,
}: {
  person: Person | null | undefined
  actor: IdentityActor
  serverName: string
}): { personKey: string; server: PersonMcpServer } | Error {
  const speaker = resolveConnectSpeaker({ person, actor })
  if (speaker instanceof Error) return speaker
  const server = speaker.servers.find((entry) => entry.name === serverName)
  if (!server) return new Error('That service is not available for your account.')
  return { personKey: speaker.personKey, server }
}

export type PersonMcpConnectionState = { server: PersonMcpServer; connected: boolean }

export function personMcpConnectionStates({
  dataDir,
  personKey,
  servers,
}: {
  dataDir: string
  personKey: string
  servers: readonly PersonMcpServer[]
}): PersonMcpConnectionState[] {
  const stored = new Set(listPersonMcpCredentials({ dataDir, personKey }))
  return servers.map((server) => ({ server, connected: stored.has(server.credential) }))
}

/** States for the person's servers that lack a token (what the welcome offers). */
export function pendingConnectionStates(servers: readonly PersonMcpServer[]): PersonMcpConnectionState[] {
  return servers.map((server) => ({ server, connected: false }))
}

// ── Button ids ──────────────────────────────────────────────────

export function connectButtonCustomId(action: 'connect' | 'disconnect', serverName: string): string {
  return `${CONNECT_BUTTON_PREFIX}${action === 'connect' ? CONNECT_ACTION : DISCONNECT_ACTION}:${serverName}`
}

export function parseConnectButtonCustomId(customId: string): { action: 'connect' | 'disconnect'; serverName: string } | null {
  if (!customId.startsWith(CONNECT_BUTTON_PREFIX)) return null
  const [action, ...rest] = customId.slice(CONNECT_BUTTON_PREFIX.length).split(':')
  const serverName = rest.join(':')
  if (!serverName) return null
  if (action === CONNECT_ACTION) return { action: 'connect', serverName }
  if (action === DISCONNECT_ACTION) return { action: 'disconnect', serverName }
  return null
}

// ── Text ────────────────────────────────────────────────────────

export function formatConnectionList(states: readonly PersonMcpConnectionState[]): string {
  const lines = states.map((state) => `• **${state.server.name}**: ${state.connected ? 'connected' : 'not connected'}`)
  return ['Your connected services:', ...lines].join('\n')
}

export function formatConnectPrompt({
  serverName,
  prompt,
  waitUntil,
  now = Date.now(),
}: {
  serverName: string
  prompt: DeviceConnectPrompt
  /** When polling stops (epoch ms). */
  waitUntil: number
  now?: number
}): string {
  const minutes = Math.max(1, Math.round((waitUntil - now) / 60_000))
  return [
    `Sign in to connect **${serverName}**.`,
    prompt.verificationUriComplete
      ? `Open the link below and approve the request. If asked, enter the code \`${prompt.userCode}\`.`
      : `Open the link below and enter the code \`${prompt.userCode}\`.`,
    `This link expires in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  ].join('\n')
}

// ── Flows ───────────────────────────────────────────────────────

/** Overridable for tests. */
let connectFetch: ConnectFetch | undefined
let connectSleep: ((ms: number) => Promise<void>) | undefined
export function setConnectFetchForTests(fetchImpl: ConnectFetch | undefined, sleep?: (ms: number) => Promise<void>): void {
  connectFetch = fetchImpl
  connectSleep = sleep
}

/** Disconnect one of the person's servers; the result is a user-facing line. */
export async function runPersonDisconnect({
  dataDir,
  personKey,
  server,
}: {
  dataDir: string
  personKey: string
  server: PersonMcpServer
}): Promise<string> {
  const result = await disconnectPersonMcp({
    dataDir,
    personKey,
    credential: server.credential,
    ...(connectFetch ? { fetchImpl: connectFetch } : {}),
  })
  if (result instanceof Error) {
    logger.warn(`[CONNECT] disconnect failed for ${server.name}: ${result.message}`)
    return `Could not disconnect **${server.name}**.`
  }
  return result.removed ? `Disconnected **${server.name}**.` : `**${server.name}** was not connected.`
}

/** In-progress flows per person and server; a new attempt cancels the old. */
const activeFlows = new Map<string, AbortController>()

export type PersonConnectStarted = {
  /** User-facing sign-in instructions (with the user code). Show privately. */
  text: string
  /** The sign-in page. Show privately. */
  link: string
}

/**
 * Start connecting one of the person's servers. Returns the private sign-in
 * prompt, or an Error whose message is user-facing. Polling continues in the
 * background; `onDone` gets the final user-facing line (not called when a
 * newer attempt for the same person and server replaced this one).
 */
export async function startPersonConnect({
  dataDir,
  personKey,
  server,
  maxWaitMs,
  retryHint,
  onDone,
}: {
  dataDir: string
  personKey: string
  server: PersonMcpServer
  /** Stop polling earlier than the code expiry (chat reply lifetime). */
  maxWaitMs: number
  /** How to try again on this platform, e.g. "Run `/connect` to try again." */
  retryHint: string
  onDone: (text: string) => Promise<void>
}): Promise<PersonConnectStarted | Error> {
  const flowKey = `${personKey}\0${server.name}`
  activeFlows.get(flowKey)?.abort()
  const controller = new AbortController()
  activeFlows.set(flowKey, controller)
  const release = () => {
    if (activeFlows.get(flowKey) === controller) activeFlows.delete(flowKey)
  }

  const session = await beginDeviceConnect({
    dataDir,
    personKey,
    target: server,
    ...(connectFetch ? { fetchImpl: connectFetch } : {}),
  })
  if (session instanceof Error) {
    release()
    logger.warn(`[CONNECT] could not start sign-in for ${server.name}: ${session.message}`)
    return new Error(`Could not connect **${server.name}**: ${session.message}`)
  }

  const { prompt } = session
  const waitUntil = Math.min(prompt.expiresAt, Date.now() + maxWaitMs)
  const started: PersonConnectStarted = {
    text: formatConnectPrompt({ serverName: server.name, prompt, waitUntil }),
    link: prompt.verificationUriComplete ?? prompt.verificationUri,
  }

  void session
    .complete({ signal: controller.signal, maxWaitMs, ...(connectSleep ? { sleep: connectSleep } : {}) })
    .then(async (result) => {
      release()
      if (result instanceof Error && result.code === 'aborted') return
      const text = result instanceof Error
        ? `Could not connect **${server.name}**: ${result.message} ${retryHint}`
        : `Connected **${server.name}**. Your next message to the agent can use it.`
      if (result instanceof Error) logger.warn(`[CONNECT] sign-in for ${server.name} ended: ${result.code}`)
      else logger.log(`[CONNECT] person connected ${server.name}`)
      await onDone(text).catch((error: unknown) => {
        logger.warn(`[CONNECT] could not update sign-in reply: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    .catch((error: unknown) => {
      release()
      logger.warn(`[CONNECT] sign-in for ${server.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    })

  return started
}
