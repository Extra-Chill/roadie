// Thin voice bridge to one orchestrator thread. Speech goes in through the
// normal Discord intake as the authenticated speaker; the orchestrator (a
// normal Roadie agent session) drives other threads with `roadie send` and
// `roadie session *`; its replies, questions and other threads' finished
// turns come back out as speech. Nothing here decides or routes work.
import {
  ChannelType,
  Events,
  ThreadAutoArchiveDuration,
  type Client,
  type GuildMember,
  type Message,
  type ThreadChannel,
} from 'discord.js'
import { channelAllowsSpeaker, resolveChannelPolicy } from './channel-policy.js'
import { hasRoadieBotPermission } from './discord-utils.js'
import { isIdentityConfigured, personHas, resolvePerson } from './identity.js'
import { addAction, addFilter, removeAction } from './hooks.js'
import { getThreadSession } from './database.js'
import { getRuntime } from './session-handler/runtime-registry.js'
import { getAgentBackendProvider } from './agent-backend/registry.js'
import { pendingQuestionContexts } from './commands/ask-question.js'
import type { DiscordIntake } from './discord-bot.js'
import { spokenText, type VoiceProvider, type VoiceProviderSession } from './voice-provider.js'

export type VoiceIntake = (incoming: DiscordIntake) => Promise<void>

/** Pinned into the orchestrator session's prompt through the host context mechanism. */
export const VOICE_ORCHESTRATOR_CONTEXT = `Voice orchestrator mode. The user is speaking to you hands-free (for example while driving); your replies are read aloud.
- Reply in one to three short, speakable sentences. No code, diffs, tables or links.
- You orchestrate; you do not code. Dispatch work to project threads with \`roadie send --channel <channel_id> --prompt '...'\` (new thread) or \`roadie send --thread <thread_id> --prompt '...'\` (existing thread). Find channels with \`roadie project list\` / \`roadie channel list\` and threads with \`roadie session list --active\`.
- Check on work with \`roadie session list\`, \`roadie session read <session_id>\`, \`roadie session wait <session_id>\` and stop it with \`roadie session abort <session_id>\`.
- Destructive actions (merge, deploy, force-push, delete, release) wait until the user confirms in Discord. Say what is waiting and stop.
- Other threads' finished turns are announced to the user separately; do not poll for them.`

/** Same activation checks as typed messages: identity, role and channel audience. */
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

/**
 * Post the speaker's words in the thread, then hand them to the normal intake
 * as that speaker. The transcript is the durable record; the intake decides,
 * exactly as for a typed message, whether the words start a turn.
 */
export async function speakIntoThread({
  thread,
  member,
  text,
  intake,
}: {
  thread: ThreadChannel
  member: GuildMember
  text: string
  intake: VoiceIntake
}): Promise<void> {
  const words = text.trim()
  if (!words) throw new Error('Nothing to send')
  if (words.length > 1800) throw new Error('Please send a shorter voice message')
  const source = await thread.send({
    content: `🎙️ **${member.displayName}:** ${words}`,
    allowedMentions: { parse: [] },
  })
  await intake({ channel: source.channel, author: member.user, member, text: words, source, spoken: true })
}

/** Final assistant text of a thread's main session, or '' when there is none. */
async function finalReply(threadId: string, sessionId: string): Promise<string> {
  const runtime = getRuntime(threadId)
  if (!runtime) return ''
  const backend = await getAgentBackendProvider().initializeForDirectory(runtime.sdkDirectory)
  if (backend instanceof Error) return ''
  const messages = await backend().sessions.messages({ sessionId, directory: runtime.sdkDirectory })
  if (messages instanceof Error) return ''
  const last = messages.findLast((entry) => entry.message.role === 'assistant' && !entry.message.summary)
  return last?.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n\n') ?? ''
}

function firstSentence(text: string): string {
  return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text.slice(0, 200)
}

export type VoiceBridge = {
  thread: ThreadChannel
  live: VoiceProviderSession
  close(): void
}

/**
 * Open the orchestrator thread for a voice session and connect the speech
 * provider. Returns undefined when the voice channel has no `voice.channel`
 * policy or the speaker may not use it.
 */
export async function startVoiceBridge({
  client,
  member,
  voiceChannelId,
  intake,
  provider,
  key,
  audio,
}: {
  client: Client
  member: GuildMember
  voiceChannelId: string
  intake: VoiceIntake
  provider: VoiceProvider
  key: string
  audio: {
    output: (pcm24: Buffer) => void
    interrupted: () => void
    completed: () => void
    failed: () => void
  }
}): Promise<VoiceBridge | undefined> {
  const textChannelId = resolveChannelPolicy(voiceChannelId)?.voice?.channel
  if (!textChannelId || !(await voiceSpeakerAllowed(member, voiceChannelId))) return undefined
  const parent = await client.channels.fetch(textChannelId)
  if (parent?.type !== ChannelType.GuildText || parent.guildId !== member.guild.id)
    throw new Error(`Voice orchestrator channel ${textChannelId} is not a text channel in this guild`)
  const thread = await parent.threads.create({
    name: `🎙️ Voice — ${new Date().toLocaleString()}`.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `Voice session for ${member.id}`,
  })
  await thread.members.add(member.id).catch(() => {})

  let closed = false
  let live: VoiceProviderSession | undefined
  const say = (text: string) => {
    if (!closed && text) live?.announce(text)
  }
  const removeContext = addFilter('context_sections', (sections, request) =>
    request.event === 'session_start' && request.threadId === thread.id
      ? [...sections, { id: 'voice-orchestrator', content: VOICE_ORCHESTRATOR_CONTEXT }]
      : sections,
  )
  const idle = async ({ sessionId, threadId }: { sessionId: string; threadId: string }) => {
    // Only a thread's own turn, not a delegated child session inside it.
    if (closed || (await getThreadSession(threadId)) !== sessionId) return
    if (threadId === thread.id) {
      say(`Orchestrator: ${spokenText(await finalReply(threadId, sessionId))}`)
      return
    }
    const other = await client.channels.fetch(threadId).catch(() => null)
    if (
      !other?.isThread() ||
      other.guildId !== member.guild.id ||
      !other.permissionsFor(member)?.has('ViewChannel') ||
      !(await voiceSpeakerAllowed(member, threadId))
    )
      return
    const reply = firstSentence(spokenText(await finalReply(threadId, sessionId)))
    // Spoken only: posting it to the orchestrator thread would start a turn.
    say(`${other.parent?.name ?? 'thread'}, ${other.name}: ${reply || 'finished'}`)
  }
  const question = (message: Message) => {
    if (message.channelId !== thread.id || message.author.id !== client.user?.id) return
    for (const row of message.components) {
      if (!('components' in row)) continue
      for (const component of row.components) {
        const [kind, hash, index] = ('customId' in component ? component.customId ?? '' : '').split(':')
        const asked = kind === 'ask_question' ? pendingQuestionContexts.get(hash ?? '')?.questions[Number(index)] : undefined
        if (asked)
          say(`Orchestrator asks: ${spokenText(asked.question)} Options: ${asked.options.map((option) => option.label).join(', ')}.`)
      }
    }
  }
  addAction('session_idle', idle)
  client.on(Events.MessageCreate, question)
  const close = () => {
    if (closed) return
    closed = true
    removeContext()
    removeAction('session_idle', idle)
    client.removeListener(Events.MessageCreate, question)
    live?.close()
  }
  try {
    live = await provider.connect({
      key,
      async tellOrchestrator(text) {
        if (closed) throw new Error('Voice session ended')
        await speakIntoThread({ thread, member, text, intake })
        return 'Delivered to the orchestrator'
      },
      ...audio,
      failed() {
        close()
        audio.failed()
      },
    })
  } catch (error) {
    close()
    throw error
  }
  if (closed) live.close()
  return { thread, live, close }
}
