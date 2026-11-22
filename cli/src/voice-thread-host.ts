import {
  ChannelType,
  type Client,
  type GuildMember,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import { channelAllowsSpeaker, channelStartsThreads } from './channel-policy.js'
import { hasRoadieBotPermission } from './discord-utils.js'
import { isIdentityConfigured, personHas, resolvePerson } from './identity.js'
import { getRuntime } from './session-handler/runtime-registry.js'
import { pendingPermissions } from './session-handler/pending-ui.js'
import { answerQuestionByVoice, pendingQuestionContexts } from './commands/ask-question.js'
import type { VoiceThreadHost } from './voice-dispatcher.js'

export async function voiceSpeakerAllowed(
  member: GuildMember,
  channelId: string,
): Promise<boolean> {
  if (member.user.bot) return false
  const person = await resolvePerson({
    actor: { platform: 'discord', id: member.id, name: member.displayName },
    context: { channelId },
  })
  if (
    person?.lookupFailed ||
    (isIdentityConfigured() && (!person || !personHas(person, 'sessions')))
  )
    return false
  return (
    hasRoadieBotPermission(member, member.guild) &&
    channelAllowsSpeaker(channelId, {
      userId: member.id,
      personId: person?.personId,
      isGuildOwner: member.guild.ownerId === member.id,
      roleIds: [...member.roles.cache.keys()],
      roleNames: member.roles.cache.map((role) => role.name),
    })
  )
}

export function createVoiceThreadHost(
  client: Client,
  member: GuildMember,
  intake: (message: Message) => Promise<void>,
): VoiceThreadHost {
  const channel = async (id: string) => {
    const result = await client.channels.fetch(id)
    if (
      !result ||
      !('guildId' in result) ||
      result.guildId !== member.guild.id ||
      (!result.isThread() && result.type !== ChannelType.GuildText) ||
      !result.permissionsFor(member)?.has(['ViewChannel', 'SendMessages']) ||
      !(await voiceSpeakerAllowed(member, id))
    )
      throw new Error('Thread is not accessible')
    return result as ThreadChannel | TextChannel
  }
  const send = async (id: string, text: string) => {
    const target = await channel(id)
    if (text.length > 1800) throw new Error('Please send a shorter voice message')
    const posted = await target.send({
      content: `🎙️ ${member.displayName}: ${text}\n<@${client.user!.id}>`,
      allowedMentions: { parse: [] },
    })
    // Keep the durable bot-authored transcript, but present the authenticated
    // speaker to the normal intake. Never use the CLI marker's policy bypass.
    const message = Object.create(posted) as Message
    Object.defineProperties(message, {
      author: { value: member.user },
      member: { value: member },
      content: { value: text },
      mentions: {
        value: new Proxy(posted.mentions, {
          get(target, property, receiver) {
            if (property === 'has') return (id: string) => id === client.user?.id || target.has(id)
            return Reflect.get(target, property, receiver)
          },
        }),
      },
      embeds: { value: [] },
      system: { value: false },
    })
    await intake(message)
  }
  return {
    async list() {
      const active = await member.guild.channels.fetchActiveThreads()
      const result = []
      for (const thread of active.threads.values()) {
        if (!getRuntime(thread.id)) continue
        try {
          await channel(thread.id)
        } catch {
          continue
        }
        const waiting = [...pendingQuestionContexts.values()].some(
          (entry) => entry.thread.id === thread.id,
        )
        result.push({
          id: thread.id,
          label: `${thread.parent?.name ?? 'project'}: ${thread.name}`,
          status: waiting
            ? 'waiting on question'
            : pendingPermissions.get(thread.id)?.size
              ? 'waiting on permission'
              : getRuntime(thread.id)?.isBusy()
                ? 'running'
                : 'idle',
        })
      }
      return result
    },
    send,
    async start(project, text) {
      await member.guild.channels.fetch()
      const matches = member.guild.channels.cache.filter(
        (entry) =>
          entry.type === ChannelType.GuildText &&
          entry.name.toLowerCase() === project.toLowerCase(),
      )
      if (matches.size !== 1) throw new Error('Choose an unambiguous project channel name')
      const parent = await channel(matches.first()!.id)
      if (parent.type !== ChannelType.GuildText) throw new Error('Project must be a text channel')
      if (!channelStartsThreads(parent.id)) throw new Error('Project does not allow new threads')
      const thread = await parent.threads.create({
        name: text.slice(0, 90),
        reason: `Voice request from ${member.id}`,
      })
      await send(thread.id, text)
      return thread.id
    },
    async read(id) {
      const target = await channel(id)
      const question = [...pendingQuestionContexts.values()].find((entry) => entry.thread.id === id)
      if (question)
        return question.questions
          .map(
            (entry) =>
              `${entry.question}: ${entry.options.map((option) => option.label).join(', ')}`,
          )
          .join('. ')
      if (pendingPermissions.get(id)?.size)
        return 'Permission required. Review in Discord when parked.'
      const messages = await target.messages.fetch({ limit: 40 })
      const reply = messages.find(
        (message) =>
          message.author.id === client.user?.id &&
          !message.content.startsWith('🎙️') &&
          !message.content.startsWith('-#') &&
          Boolean(message.content || message.embeds.some((embed) => embed.description)),
      )
      return reply
        ? [reply.content, ...reply.embeds.map((embed) => embed.description ?? '')]
            .filter(Boolean)
            .join(' ')
        : 'No assistant reply yet'
    },
    async abort(id) {
      await channel(id)
      await getRuntime(id)?.abortActiveRun('voice dispatcher')
    },
    async answer(id, option) {
      await channel(id)
      // Permission grants and arbitrary natural-language confirmations are never
      // safe to infer from audio. Only a denial can be sent by voice for now.
      if (await answerQuestionByVoice(id, option, member.displayName))
        return 'Read-only answer delivered'
      if (!['no', 'cancel', 'reject'].includes(option.toLowerCase()))
        return "Queued for when you're parked. Review and answer in Discord."
      await getRuntime(id)?.abortActiveRun('voice rejected pending request')
      return 'Pending request cancelled'
    },
  }
}
