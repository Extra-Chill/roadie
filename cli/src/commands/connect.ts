// /connect command and Connect buttons: a person connects their own account to
// the person-scoped MCP servers the identity layer names for them
// (`mcp_servers`), from chat, with the OAuth device grant.
//
//   /connect                      link identity if needed, then an ephemeral
//                                 tool list with Connect/Disconnect buttons
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
import { startDiscordIdentityLink } from './link.js'
import {
  isIdentityConfigured,
  IDENTITY_LOOKUP_FAILED_MESSAGE,
  resolvePerson,
  type IdentityActor,
  type Person,
} from '../identity.js'
import {
  connectButtonCustomId,
  formatConnectionList,
  parseConnectButtonCustomId,
  personMcpConnectionStates,
  resolveConnectSpeaker,
  resolveConnectTarget,
  runPersonDisconnect,
  startPersonConnect,
  type PersonMcpConnectionState,
} from '../person-connect.js'

// The platform-neutral core lives in person-connect.ts; re-exported here for
// existing importers.
export {
  CONNECT_BUTTON_PREFIX,
  connectButtonCustomId,
  formatConnectionList,
  parseConnectButtonCustomId,
  personMcpConnectionStates,
  resolveConnectSpeaker,
  resolveConnectTarget,
  setConnectFetchForTests,
  type ConnectSpeaker,
  type PersonMcpConnectionState,
} from '../person-connect.js'

const MAX_BUTTONS_PER_ROW = 5
const MAX_ROWS = 5
// Discord interaction tokens last 15 minutes; stop polling before the reply
// can no longer be edited.
const MAX_WAIT_MS = 14 * 60_000

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

// ── Discord handlers ────────────────────────────────────────────

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

export async function handleConnectCommand({ command, channelBound = true }: { command: ChatInputCommandInteraction; channelBound?: boolean }): Promise<void> {
  if (!isIdentityConfigured()) {
    await command.reply({ content: 'Per-person services are not configured on this server.', flags: MessageFlags.Ephemeral })
    return
  }
  const person = await personFor(command)
  if (person?.lookupFailed) {
    await command.reply({ content: IDENTITY_LOOKUP_FAILED_MESSAGE, flags: MessageFlags.Ephemeral })
    return
  }
  if (!person?.allowed) {
    await startDiscordIdentityLink({
      command,
      channelBound,
      onLinked: async () => {
        await showConnectionList(command, await personFor(command))
      },
    })
    return
  }
  await showConnectionList(command, person)
}

async function showConnectionList(command: ChatInputCommandInteraction, person: Person | null): Promise<void> {
  const speaker = resolveConnectSpeaker({ person, actor: actorOf(command) })
  if (speaker instanceof Error) {
    if (command.deferred || command.replied) await command.editReply({ content: speaker.message, components: [] })
    else await command.reply({ content: speaker.message, flags: MessageFlags.Ephemeral })
    return
  }
  const states = personMcpConnectionStates({ dataDir: getDataDir(), personKey: speaker.personKey, servers: speaker.servers })
  const payload = { content: formatConnectionList(states), components: buildConnectButtonRows({ states }) }
  if (command.deferred || command.replied) await command.editReply(payload)
  else await command.reply({ ...payload, flags: MessageFlags.Ephemeral })
}

export async function handleConnectButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseConnectButtonCustomId(interaction.customId)
  if (!parsed) return
  // In a guild the interaction listener has already deferred this privately.
  if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  if (!isIdentityConfigured()) {
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

  if (parsed.action === 'disconnect') {
    await interaction.editReply({ content: await runPersonDisconnect({ dataDir, personKey, server }) })
    return
  }

  const started = await startPersonConnect({
    dataDir,
    personKey,
    server,
    maxWaitMs: MAX_WAIT_MS,
    retryHint: 'Run `/connect` to try again.',
    onDone: async (content) => {
      await interaction.editReply({ content, components: [] })
    },
  })
  if (started instanceof Error) {
    await interaction.editReply({ content: started.message })
    return
  }
  await interaction.editReply({
    content: started.text,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(started.link).setLabel('Open sign-in page'),
      ),
    ],
  })
}
