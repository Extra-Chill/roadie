// Slack surface for per-person MCP connect and the first-contact welcome
// (issue #284; the Discord side is commands/connect.ts and commands/start.ts).
//
//   /roadie connect               ephemeral Block Kit list: each of the
//                                 speaker's servers, connected or not, with a
//                                 Connect or Disconnect button
//   roadie_connect:c:<server>     Connect button (also in the welcome DM)
//   roadie_connect:d:<server>     Disconnect button
//   /roadie start                 the welcome, ephemeral, on demand
//   first contact                 the welcome as a DM (conversations.open +
//                                 chat.postMessage), once per person
//
// Who and what are decided by the platform-neutral person-connect.ts and
// person-welcome.ts. The button only carries the server name: the person key
// always comes from the *clicking* or *calling* Slack user's resolved person,
// and the server must be one of theirs.
//
// The verification link and code only ever reach the speaker: in the
// ephemeral message the button was clicked from (replaced through its
// `response_url`, since Slack cannot `chat.update` ephemeral messages), or
// otherwise in the speaker's own DM with the bot. Never in a shared channel.
// Tokens are never logged or shown.

import { getDataDir } from './config.js'
import { channelAllowsSpeaker, decideRespond } from './channel-policy.js'
import type { SlackApi, SlackApiError } from './chat-platform/slack-api.js'
import { slackText } from './chat-platform/slack-api.js'
import {
  isIdentityConfigured,
  resolvePerson,
  type IdentityActor,
  type Person,
} from './identity.js'
import { createLogger } from './logger.js'
import {
  CONNECT_BUTTON_PREFIX,
  connectButtonCustomId,
  formatConnectionList,
  parseConnectButtonCustomId,
  pendingConnectionStates,
  personMcpConnectionStates,
  resolveConnectSpeaker,
  resolveConnectTarget,
  runPersonDisconnect,
  startPersonConnect,
  type PersonMcpConnectionState,
} from './person-connect.js'
import {
  buildPersonWelcome,
  maybeWelcomePerson,
  welcomePersonKey,
  type PersonWelcome,
  type WelcomeOutcome,
} from './person-welcome.js'

const logger = createLogger('SLACK')

/** The Slack Web API calls this module makes; tests pass a fake. */
export type SlackConnectApi = Pick<SlackApi, 'post' | 'edit' | 'postEphemeral' | 'openDm' | 'respond'>

// Slack response URLs work for 30 minutes; stop polling before that.
const MAX_WAIT_MS = 25 * 60_000
// Slack allows 25 elements per actions block and 50 blocks per message.
const MAX_BUTTONS_PER_BLOCK = 25
const MAX_ACTION_BLOCKS = 4
const RETRY_HINT = 'Run `/roadie connect` to try again.'
const NOT_CONFIGURED = 'Per-person services are not configured on this workspace.'
const NOT_HERE = 'Roadie is not available to you in this channel.'
/** Action id of the sign-in link button; Slack still posts a click for it. */
export const CONNECT_LINK_ACTION_ID = `${CONNECT_BUTTON_PREFIX}open`

export function isSlackConnectAction(actionId: string | undefined): boolean {
  return Boolean(actionId?.startsWith(CONNECT_BUTTON_PREFIX))
}

// ── Block Kit (pure, tested) ────────────────────────────────────

const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 75) })

export function slackSectionBlock(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text: slackText(text).slice(0, 3000) } }
}

/** Connect for missing tokens, Disconnect for stored ones (optional). */
export function buildSlackConnectButtons({
  states,
  includeDisconnect = true,
}: {
  states: readonly PersonMcpConnectionState[]
  includeDisconnect?: boolean
}): Array<{ type: 'actions'; elements: unknown[] }> {
  const buttons = states
    .filter((state) => includeDisconnect || !state.connected)
    .map((state) => ({
      type: 'button',
      text: plain(`${state.connected ? 'Disconnect' : 'Connect'} ${state.server.name}`),
      action_id: connectButtonCustomId(state.connected ? 'disconnect' : 'connect', state.server.name),
      ...(state.connected ? {} : { style: 'primary' }),
    }))
    .slice(0, MAX_BUTTONS_PER_BLOCK * MAX_ACTION_BLOCKS)
  const blocks: Array<{ type: 'actions'; elements: unknown[] }> = []
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_BLOCK) {
    blocks.push({ type: 'actions', elements: buttons.slice(i, i + MAX_BUTTONS_PER_BLOCK) })
  }
  return blocks
}

export function buildSlackConnectionListBlocks(states: readonly PersonMcpConnectionState[], lead?: string): unknown[] {
  return [
    ...(lead ? [slackSectionBlock(lead)] : []),
    slackSectionBlock(formatConnectionList(states)),
    ...buildSlackConnectButtons({ states }),
  ]
}

/** The welcome: its text plus Connect buttons for servers lacking a token. */
export function buildSlackWelcomeBlocks(welcome: PersonWelcome): unknown[] {
  return [
    slackSectionBlock(welcome.text),
    ...buildSlackConnectButtons({ states: pendingConnectionStates(welcome.pendingMcpServers), includeDisconnect: false }),
  ]
}

export function buildSlackSignInBlocks({ text, link }: { text: string; link: string }): unknown[] {
  return [
    slackSectionBlock(text),
    {
      type: 'actions',
      elements: [{ type: 'button', text: plain('Open sign-in page'), url: link, action_id: CONNECT_LINK_ACTION_ID }],
    },
  ]
}

// ── Gates ───────────────────────────────────────────────────────

/**
 * Whether the speaker may use personal commands here. DMs with the bot are
 * always fine (the authority is the speaker's own person). In channels, the
 * same response policy and audience as any other Roadie interaction apply.
 */
export function slackPersonCommandAllowed({
  channelId,
  userId,
  person,
}: {
  channelId: string | undefined
  userId: string
  person: Person | null | undefined
}): boolean {
  if (!channelId || channelId.startsWith('D')) return true
  if (decideRespond(channelId) === 'ignore') return false
  return channelAllowsSpeaker(channelId, {
    userId,
    isGuildOwner: false,
    roleIds: [],
    roleNames: [],
    ...(person?.personId ? { personId: person.personId } : {}),
  })
}

async function slackPerson({
  workspaceId,
  channelId,
  actor,
}: {
  workspaceId: string
  channelId: string | undefined
  actor: IdentityActor
}): Promise<Person | null> {
  return await resolvePerson({
    actor,
    context: { guildId: workspaceId, ...(channelId ? { channelId } : {}) },
  })
}

// ── Private replies ─────────────────────────────────────────────

/**
 * A reply only the speaker can see, that can be updated later: the
 * ephemeral message a button sits on (through its response URL), or a
 * message in the speaker's DM with the bot.
 */
type PrivateReply = { show(text: string, blocks?: unknown[]): Promise<void | Error> }

function responseUrlReply(api: SlackConnectApi, responseUrl: string): PrivateReply {
  return {
    show: async (text, blocks) => await api.respond({ responseUrl, text, ...(blocks ? { blocks } : {}), replaceOriginal: true }),
  }
}

async function dmReply(api: SlackConnectApi, userId: string): Promise<PrivateReply | Error> {
  const channel = await api.openDm(userId)
  if (channel instanceof Error) return channel
  let ts: string | undefined
  return {
    show: async (text, blocks) => {
      if (ts) return await api.edit({ channel, ts, text, ...(blocks ? { blocks } : {}) })
      const posted = await api.post({ channel, text, ...(blocks ? { blocks } : {}) })
      if (posted instanceof Error) return posted
      ts = posted.id
      return undefined
    },
  }
}

/** Ephemeral answer to a slash command: its response URL, else chat.postEphemeral. */
async function replyToCommand(
  api: SlackConnectApi,
  context: SlackPersonCommandContext,
  text: string,
  blocks?: unknown[],
): Promise<void | Error> {
  if (context.responseUrl) {
    const sent = await api.respond({ responseUrl: context.responseUrl, text, ...(blocks ? { blocks } : {}) })
    if (!(sent instanceof Error)) return undefined
    logger.warn(`[CONNECT] response URL failed, posting ephemeral instead: ${sent.message}`)
  }
  return await api.postEphemeral({ channel: context.channelId, user: context.userId, text, ...(blocks ? { blocks } : {}) })
}

// ── Commands ────────────────────────────────────────────────────

export type SlackPersonCommandContext = {
  api: SlackConnectApi
  workspaceId: string
  channelId: string
  userId: string
  userName?: string
  responseUrl?: string
  dataDir?: string
}

function commandActor(context: SlackPersonCommandContext): IdentityActor {
  return { platform: 'slack', id: context.userId, ...(context.userName ? { name: context.userName } : {}) }
}

/** `/roadie connect`: the speaker's own servers, ephemeral, with buttons. */
export async function handleSlackConnectCommand(context: SlackPersonCommandContext): Promise<void | Error> {
  const { api } = context
  if (!isIdentityConfigured()) return await replyToCommand(api, context, NOT_CONFIGURED)
  const actor = commandActor(context)
  const person = await slackPerson({ workspaceId: context.workspaceId, channelId: context.channelId, actor })
  if (!slackPersonCommandAllowed({ channelId: context.channelId, userId: context.userId, person }))
    return await replyToCommand(api, context, NOT_HERE)
  // First contact through /roadie connect still gets the one-time welcome DM.
  void welcomeSlackUser({ api, userId: context.userId, ...(context.userName ? { displayName: context.userName } : {}), person, channelId: context.channelId })
  const speaker = resolveConnectSpeaker({ person, actor })
  if (speaker instanceof Error) return await replyToCommand(api, context, speaker.message)
  const states = personMcpConnectionStates({
    dataDir: context.dataDir ?? getDataDir(),
    personKey: speaker.personKey,
    servers: speaker.servers,
  })
  return await replyToCommand(api, context, formatConnectionList(states), buildSlackConnectionListBlocks(states))
}

/** `/roadie start`: the welcome, ephemeral, on demand. */
export async function handleSlackStartCommand(context: SlackPersonCommandContext): Promise<void | Error> {
  const { api } = context
  const actor = commandActor(context)
  const person = await slackPerson({ workspaceId: context.workspaceId, channelId: context.channelId, actor })
  if (!slackPersonCommandAllowed({ channelId: context.channelId, userId: context.userId, person }))
    return await replyToCommand(api, context, NOT_HERE)
  const personKey = welcomePersonKey({ actor, person })
  if (!personKey || !person)
    return await replyToCommand(
      api,
      context,
      "I'm Roadie, an AI agent for this workspace. Mention me in a project channel to ask a question or start a task.",
    )
  const welcome = await buildPersonWelcome({
    actor,
    person,
    personKey,
    channelId: context.channelId,
    trigger: 'command',
    dataDir: context.dataDir ?? getDataDir(),
  })
  if (!welcome) return await replyToCommand(api, context, 'There is no welcome message on this workspace.')
  return await replyToCommand(api, context, welcome.text, buildSlackWelcomeBlocks(welcome))
}

// ── Buttons ─────────────────────────────────────────────────────

export type SlackConnectActionInput = {
  api: SlackConnectApi
  workspaceId: string
  /** The clicking user: the only source of authority. */
  user: { id: string; username?: string; name?: string }
  actionId: string
  channelId?: string
  responseUrl?: string
  /** Whether the clicked message is ephemeral (its response URL can replace it). */
  isEphemeral?: boolean
  dataDir?: string
}

/**
 * A Connect or Disconnect click. Resolves the clicking user's own person;
 * nothing about the person comes from the button. Polling continues in the
 * background and updates the same private reply.
 */
export async function handleSlackConnectAction(input: SlackConnectActionInput): Promise<void | Error> {
  const parsed = parseConnectButtonCustomId(input.actionId)
  if (!parsed) return undefined // The sign-in link button, or a stale id.
  const { api } = input
  const reply = input.isEphemeral && input.responseUrl
    ? responseUrlReply(api, input.responseUrl)
    : await dmReply(api, input.user.id)
  if (reply instanceof Error) return reply
  if (!isIdentityConfigured()) return await reply.show(NOT_CONFIGURED)

  const name = input.user.username ?? input.user.name
  const actor: IdentityActor = { platform: 'slack', id: input.user.id, ...(name ? { name } : {}) }
  const person = await slackPerson({ workspaceId: input.workspaceId, channelId: input.channelId, actor })
  if (!slackPersonCommandAllowed({ channelId: input.channelId, userId: input.user.id, person }))
    return await reply.show(NOT_HERE)
  const target = resolveConnectTarget({ person, actor, serverName: parsed.serverName })
  if (target instanceof Error) return await reply.show(target.message)
  const { personKey, server } = target
  const dataDir = input.dataDir ?? getDataDir()
  const speakerServers = person?.mcpServers ?? []
  const listAfter = async (lead: string) => {
    const states = personMcpConnectionStates({ dataDir, personKey, servers: speakerServers })
    const shown = await reply.show(`${lead}\n${formatConnectionList(states)}`, buildSlackConnectionListBlocks(states, lead))
    if (shown instanceof Error) logger.warn(`[CONNECT] could not update Slack reply: ${shown.message}`)
  }

  if (parsed.action === 'disconnect') {
    await listAfter(await runPersonDisconnect({ dataDir, personKey, server }))
    return undefined
  }

  const started = await startPersonConnect({
    dataDir,
    personKey,
    server,
    maxWaitMs: MAX_WAIT_MS,
    retryHint: RETRY_HINT,
    onDone: listAfter,
  })
  if (started instanceof Error) return await reply.show(started.message)
  return await reply.show(started.text, buildSlackSignInBlocks(started))
}

// ── Welcome ─────────────────────────────────────────────────────

/**
 * Send the one-time welcome as a DM to a Slack user, if they are due one.
 * Never throws; a failed DM is logged by maybeWelcomePerson and not retried.
 */
export async function welcomeSlackUser({
  api,
  userId,
  displayName,
  isBot = false,
  person,
  channelId,
  via = 'chat',
  dataDir,
}: {
  api: Pick<SlackConnectApi, 'openDm' | 'post'>
  userId: string
  displayName?: string
  isBot?: boolean
  person: Person | null | undefined
  channelId?: string
  via?: 'chat' | 'cli'
  dataDir?: string
}): Promise<WelcomeOutcome> {
  const actor: IdentityActor = { platform: 'slack', id: userId, ...(displayName ? { name: displayName } : {}) }
  return await maybeWelcomePerson({
    actor,
    person,
    via,
    // Slack bot ids (B...) are never people, whatever the identity layer says.
    isBot: isBot || userId.startsWith('B'),
    ...(channelId ? { channelId } : {}),
    ...(dataDir ? { dataDir } : {}),
    deliver: async (welcome) => {
      const channel = await api.openDm(userId)
      if (channel instanceof Error) return channel
      const sent: { id: string } | SlackApiError = await api.post({
        channel,
        text: welcome.text,
        blocks: buildSlackWelcomeBlocks(welcome),
      })
      return sent instanceof Error ? sent : undefined
    },
  })
}
