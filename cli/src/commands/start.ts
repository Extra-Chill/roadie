// /start command and the Discord delivery of the first-contact welcome
// (issue #272). The welcome itself is built in person-welcome.ts.
//
// First contact: Discord has no ephemeral replies to plain messages, so the
// welcome goes to the person's DMs. If DMs are closed the welcome is skipped
// (logged), never posted in a shared channel.
// /start: the same text as an ephemeral reply, on demand.

import { MessageFlags, type ChatInputCommandInteraction, type User } from 'discord.js'
import { getDataDir } from '../config.js'
import { resolvePerson, type IdentityActor, type Person } from '../identity.js'
import {
  buildPersonWelcome,
  maybeWelcomePerson,
  welcomePersonKey,
  type PersonWelcome,
  type WelcomeOutcome,
} from '../person-welcome.js'
import { buildConnectButtonRows } from './connect.js'

function welcomeComponents(welcome: PersonWelcome) {
  return buildConnectButtonRows({
    states: welcome.pendingMcpServers.map((server) => ({ server, connected: false })),
    includeDisconnect: false,
  })
}

/** Send the one-time welcome DM to a Discord user, if they are due one. Never throws. */
export async function welcomeDiscordUser({
  user,
  displayName,
  person,
  channelId,
  via = 'chat',
}: {
  user: Pick<User, 'id' | 'bot' | 'send'>
  displayName?: string
  person: Person | null | undefined
  channelId?: string
  via?: 'chat' | 'cli'
}): Promise<WelcomeOutcome> {
  const actor: IdentityActor = { platform: 'discord', id: user.id, ...(displayName ? { name: displayName } : {}) }
  return await maybeWelcomePerson({
    actor,
    person,
    via,
    isBot: user.bot,
    ...(channelId ? { channelId } : {}),
    deliver: async (welcome) => {
      const sent = await user
        .send({ content: welcome.text, components: welcomeComponents(welcome) })
        .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
      return sent instanceof Error ? sent : undefined
    },
  })
}

export async function handleStartCommand({ command }: { command: ChatInputCommandInteraction }): Promise<void> {
  const actor: IdentityActor = { platform: 'discord', id: command.user.id, name: command.user.displayName }
  const person = await resolvePerson({
    actor,
    context: {
      ...(command.guildId ? { guildId: command.guildId } : {}),
      ...(command.channelId ? { channelId: command.channelId } : {}),
    },
  })
  const personKey = welcomePersonKey({ actor, person, isBot: command.user.bot })
  if (!personKey || !person) {
    await command.reply({
      content: "I'm Roadie, an AI agent for this server. Mention me in a project channel to ask a question or start a task.",
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  const welcome = await buildPersonWelcome({
    actor,
    person,
    personKey,
    ...(command.channelId ? { channelId: command.channelId } : {}),
    trigger: 'command',
    dataDir: getDataDir(),
  })
  if (!welcome) {
    await command.reply({ content: 'There is no welcome message on this server.', flags: MessageFlags.Ephemeral })
    return
  }
  await command.reply({ content: welcome.text, components: welcomeComponents(welcome), flags: MessageFlags.Ephemeral })
}
