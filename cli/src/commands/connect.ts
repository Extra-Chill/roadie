// /connect command and Connect buttons: a person connects their own account to
// the person-scoped MCP servers the identity layer names for them
// (`mcp_servers`), from chat, with the OAuth device grant — or, when the
// server has no device grant, authorization code + S256 PKCE (issue #356).
//
//   /connect                      link identity if needed, then an ephemeral
//                                 tool list with Connect/Disconnect buttons
//   roadie_connect:c:<server>     Connect button (also shown by the welcome)
//   roadie_connect:d:<server>     Disconnect button
//   roadie_connect_paste:<key>    Paste redirect URL button (authorization-
//                                 code connect); opens the paste modal
//   roadie_connect_modal:<key>    its modal submit
//
// The button only carries intent (which server). Authority always comes from
// the clicking user: the person key is derived from the person the identity
// layer resolves for *that* user, exactly like turns derive it
// (applyPersonToIngress), and the server must be one of *their* servers. So a
// button forwarded to, or clicked by, someone else acts on their own account,
// never on the original person's.
//
// All replies are ephemeral. Tokens, codes and verifiers are never logged or
// shown; the person only sees the sign-in link (and the device user code).
// Only the person who started a connect can paste its redirect URL. The OAuth
// work lives in credentials/mcp-device-connect.ts.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
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
import { personKeyFrom } from '../credentials/person-pool.js'
import {
  CONNECT_PASTE_MODAL_PREFIX,
  CONNECT_PASTE_PREFIX,
  connectButtonCustomId,
  findConnectPaste,
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
  CONNECT_PASTE_MODAL_PREFIX,
  CONNECT_PASTE_PREFIX,
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

function actorOf(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction): IdentityActor {
  return { platform: 'discord', id: interaction.user.id, name: interaction.user.displayName }
}

async function personFor(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction): Promise<Person | null> {
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
    pasteButton: true,
    onDone: async (content) => {
      await interaction.editReply({ content, components: [] })
    },
  })
  if (started instanceof Error) {
    await interaction.editReply({ content: started.message })
    return
  }
  const buttons = [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(started.link).setLabel('Open sign-in page')]
  if (started.paste) {
    buttons.push(new ButtonBuilder().setCustomId(started.paste.customId).setLabel('Paste redirect URL').setStyle(ButtonStyle.Secondary))
  }
  await interaction.editReply({
    content: started.text,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
  })
}

// ── Paste redirect URL (authorization-code connect) ─────────────

const PASTE_URL_FIELD = 'redirect_url'

const PASTE_GONE_MESSAGE = 'This sign-in is no longer available. Run `/connect` to try again.'
const PASTE_FOREIGN_MESSAGE = 'Only the person who started this connect can paste the redirect URL.'

const PASTE_OUTCOME_MESSAGES: Record<string, string> = {
  invalid: 'That does not look like a sign-in redirect. Paste the whole address your browser was redirected to.',
  mismatch: 'That sign-in link was not started by this connect attempt. Open the sign-in link from this conversation and try again.',
  late: 'This sign-in already finished or expired. Run `/connect` to try again.',
  accepted: 'Got it — finishing sign-in. Your connect reply will update once it completes.',
}

/**
 * The person key of the interacting user, resolved the same way turns resolve
 * theirs (the identity layer). A pasted redirect is accepted only from the
 * person who started the connect; anyone else gets an ephemeral refusal.
 */
async function clickerPersonKey(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<string | Error> {
  if (!isIdentityConfigured()) return new Error('Per-person services are not configured on this server.')
  const person = await personFor(interaction)
  if (person?.lookupFailed) return new Error(IDENTITY_LOOKUP_FAILED_MESSAGE)
  const personKey = personKeyFrom({ personId: person?.personId, platform: 'discord', actorId: interaction.user.id })
  if (!personKey) return new Error('Could not resolve your account.')
  return personKey
}

/** Open the modal that takes the redirected URL the person's browser landed on. */
export async function handleConnectPasteButton(interaction: ButtonInteraction): Promise<void> {
  const paste = findConnectPaste(interaction.customId)
  if (!paste) {
    await interaction.reply({ content: PASTE_GONE_MESSAGE, flags: MessageFlags.Ephemeral })
    return
  }
  const clicker = await clickerPersonKey(interaction)
  if (clicker instanceof Error) {
    await interaction.reply({ content: clicker.message, flags: MessageFlags.Ephemeral })
    return
  }
  if (clicker !== paste.personKey) {
    await interaction.reply({ content: PASTE_FOREIGN_MESSAGE, flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`${CONNECT_PASTE_MODAL_PREFIX}${interaction.customId.slice(CONNECT_PASTE_PREFIX.length)}`)
      .setTitle('Finish sign-in')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(PASTE_URL_FIELD)
            .setLabel('Redirected URL')
            .setPlaceholder('http://127.0.0.1:…/callback?code=…&state=…')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true),
        ),
      ),
  )
}

/** Take the pasted redirect URL, hand it to the flow, answer ephemerally. */
export async function handleConnectPasteModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const paste = findConnectPaste(interaction.customId)
  if (!paste) {
    await interaction.reply({ content: PASTE_GONE_MESSAGE, flags: MessageFlags.Ephemeral })
    return
  }
  const clicker = await clickerPersonKey(interaction)
  if (clicker instanceof Error) {
    await interaction.reply({ content: clicker.message, flags: MessageFlags.Ephemeral })
    return
  }
  if (clicker !== paste.personKey) {
    await interaction.reply({ content: PASTE_FOREIGN_MESSAGE, flags: MessageFlags.Ephemeral })
    return
  }
  // No secrets here (the URL carries an authorization code, never a token),
  // and the outcome line names no values; the flow itself never logs it.
  const url = interaction.fields.getTextInputValue(PASTE_URL_FIELD).trim()
  const outcome = await paste.submit(url)
  await interaction.reply({ content: PASTE_OUTCOME_MESSAGES[outcome.status] ?? PASTE_GONE_MESSAGE, flags: MessageFlags.Ephemeral })
}
