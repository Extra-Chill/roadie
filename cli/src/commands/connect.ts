// /connect command and Connect buttons: a person connects their own account to
// the person-scoped MCP servers the identity layer names for them
// (`mcp_servers`), from chat, with the OAuth device grant.
//
//   /connect                      ephemeral list: each server, connected or not,
//                                 with a Connect or Disconnect button
//   roadie_connect:c:<server>     Connect button (also shown by the welcome)
//   roadie_connect:d:<server>     Disconnect button
//
// The button only carries intent (which server). Authority always comes from
// the clicking user: the person key is derived from the person the identity
// layer resolves for *that* user, exactly like turns derive it
// (applyPersonToIngress), and the server must be one of *their* servers. So a
// button forwarded to, or clicked by, someone else acts on their own account,
// never on the original person's.
//
// All replies are ephemeral. Tokens are never logged or shown; the person only
// sees the verification link and user code. The OAuth work lives in
// credentials/mcp-device-connect.ts.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { getDataDir } from '../config.js'
import { personKeyFrom } from '../credentials/person-pool.js'
import { listPersonMcpCredentials } from '../credentials/person-mcp-store.js'
import {
  beginDeviceConnect,
  disconnectPersonMcp,
  type ConnectFetch,
} from '../credentials/mcp-device-connect.js'
import {
  isIdentityHookConfigured,
  resolvePerson,
  type IdentityActor,
  type Person,
  type PersonMcpServer,
} from '../identity.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.MCP)

export const CONNECT_BUTTON_PREFIX = 'roadie_connect:'
const CONNECT_ACTION = 'c'
const DISCONNECT_ACTION = 'd'
const MAX_BUTTONS_PER_ROW = 5
const MAX_ROWS = 5
// Discord interaction tokens last 15 minutes; stop polling before the reply
// can no longer be edited.
const MAX_WAIT_MS = 14 * 60_000

// ── Pure helpers (tested) ───────────────────────────────────────

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

/** Button rows for connection states: Connect for missing, Disconnect for stored (optional). */
export function buildConnectButtonRows({
  states,
  includeDisconnect = true,
}: {
  states: readonly PersonMcpConnectionState[]
  includeDisconnect?: boolean
}): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = states
    .filter((state) => includeDisconnect || !state.connected)
    .map((state) =>
      new ButtonBuilder()
        .setCustomId(connectButtonCustomId(state.connected ? 'disconnect' : 'connect', state.server.name))
        .setLabel(`${state.connected ? 'Disconnect' : 'Connect'} ${state.server.name}`.slice(0, 80))
        .setStyle(state.connected ? ButtonStyle.Secondary : ButtonStyle.Primary),
    )
    .slice(0, MAX_BUTTONS_PER_ROW * MAX_ROWS)
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + MAX_BUTTONS_PER_ROW)))
  }
  return rows
}

/**
 * Connect buttons for a person's servers that lack a stored token: what other
 * code (the welcome message) shows. Empty when everything is connected or the
 * person has no servers.
 */
export function buildPersonConnectButtons({
  dataDir = getDataDir(),
  person,
  actor,
}: {
  dataDir?: string
  person: Person | null | undefined
  actor: IdentityActor
}): ActionRowBuilder<ButtonBuilder>[] {
  const speaker = resolveConnectSpeaker({ person, actor })
  if (speaker instanceof Error) return []
  const states = personMcpConnectionStates({ dataDir, personKey: speaker.personKey, servers: speaker.servers })
  return buildConnectButtonRows({ states, includeDisconnect: false })
}

export function formatConnectionList(states: readonly PersonMcpConnectionState[]): string {
  const lines = states.map((state) => `• **${state.server.name}**: ${state.connected ? 'connected' : 'not connected'}`)
  return ['Your connected services:', ...lines].join('\n')
}

// ── Discord handlers ────────────────────────────────────────────

/** In-progress flows per person and server; a new attempt cancels the old. */
const activeFlows = new Map<string, AbortController>()

/** Overridable for tests. */
let connectFetch: ConnectFetch | undefined
export function setConnectFetchForTests(fetchImpl: ConnectFetch | undefined): void {
  connectFetch = fetchImpl
}

function actorOf(interaction: ChatInputCommandInteraction | ButtonInteraction): IdentityActor {
  return { platform: 'discord', id: interaction.user.id, name: interaction.user.displayName }
}

async function personFor(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<Person | null> {
  return await resolvePerson({
    actor: actorOf(interaction),
    context: {
      ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
      ...(interaction.channelId ? { channelId: interaction.channelId } : {}),
    },
  })
}

export async function handleConnectCommand({ command }: { command: ChatInputCommandInteraction }): Promise<void> {
  if (!isIdentityHookConfigured()) {
    await command.reply({ content: 'Per-person services are not configured on this server.', flags: MessageFlags.Ephemeral })
    return
  }
  const actor = actorOf(command)
  const speaker = resolveConnectSpeaker({ person: await personFor(command), actor })
  if (speaker instanceof Error) {
    await command.reply({ content: speaker.message, flags: MessageFlags.Ephemeral })
    return
  }
  const states = personMcpConnectionStates({ dataDir: getDataDir(), personKey: speaker.personKey, servers: speaker.servers })
  await command.reply({
    content: formatConnectionList(states),
    components: buildConnectButtonRows({ states }),
    flags: MessageFlags.Ephemeral,
  })
}

export async function handleConnectButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseConnectButtonCustomId(interaction.customId)
  if (!parsed) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  if (!isIdentityHookConfigured()) {
    await interaction.editReply({ content: 'Per-person services are not configured on this server.' })
    return
  }
  const actor = actorOf(interaction)
  const target = resolveConnectTarget({ person: await personFor(interaction), actor, serverName: parsed.serverName })
  if (target instanceof Error) {
    await interaction.editReply({ content: target.message })
    return
  }
  const { personKey, server } = target
  const dataDir = getDataDir()
  const fetchImpl = connectFetch

  if (parsed.action === 'disconnect') {
    const result = await disconnectPersonMcp({
      dataDir,
      personKey,
      credential: server.credential,
      ...(fetchImpl ? { fetchImpl } : {}),
    })
    if (result instanceof Error) {
      logger.warn(`[CONNECT] disconnect failed for ${server.name}: ${result.message}`)
      await interaction.editReply({ content: `Could not disconnect **${server.name}**.` })
      return
    }
    await interaction.editReply({
      content: result.removed ? `Disconnected **${server.name}**.` : `**${server.name}** was not connected.`,
    })
    return
  }

  const flowKey = `${personKey}\0${server.name}`
  activeFlows.get(flowKey)?.abort()
  const controller = new AbortController()
  activeFlows.set(flowKey, controller)

  const session = await beginDeviceConnect({
    dataDir,
    personKey,
    target: server,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  if (session instanceof Error) {
    if (activeFlows.get(flowKey) === controller) activeFlows.delete(flowKey)
    logger.warn(`[CONNECT] could not start sign-in for ${server.name}: ${session.message}`)
    await interaction.editReply({ content: `Could not connect **${server.name}**: ${session.message}` })
    return
  }

  const { prompt } = session
  const minutes = Math.max(1, Math.round((Math.min(prompt.expiresAt, Date.now() + MAX_WAIT_MS) - Date.now()) / 60_000))
  const link = prompt.verificationUriComplete ?? prompt.verificationUri
  await interaction.editReply({
    content: [
      `Sign in to connect **${server.name}**.`,
      prompt.verificationUriComplete
        ? `Open the link below and approve the request. If asked, enter the code \`${prompt.userCode}\`.`
        : `Open the link below and enter the code \`${prompt.userCode}\`.`,
      `This link expires in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel('Open sign-in page'),
      ),
    ],
  })

  void session
    .complete({ signal: controller.signal, maxWaitMs: MAX_WAIT_MS })
    .then(async (result) => {
      if (activeFlows.get(flowKey) === controller) activeFlows.delete(flowKey)
      if (result instanceof Error && result.code === 'aborted') return
      const content = result instanceof Error
        ? `Could not connect **${server.name}**: ${result.message} Run \`/connect\` to try again.`
        : `Connected **${server.name}**. Your next message to the agent can use it.`
      if (result instanceof Error) logger.warn(`[CONNECT] sign-in for ${server.name} ended: ${result.code}`)
      else logger.log(`[CONNECT] person connected ${server.name}`)
      await interaction.editReply({ content, components: [] }).catch((error: unknown) => {
        logger.warn(`[CONNECT] could not update sign-in reply: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    .catch((error: unknown) => {
      if (activeFlows.get(flowKey) === controller) activeFlows.delete(flowKey)
      logger.warn(`[CONNECT] sign-in for ${server.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
}
