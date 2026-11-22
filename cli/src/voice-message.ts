import { MessageFlags, type Message, type ThreadChannel } from 'discord.js'
import { getChannelDirectory } from './database.js'
import { isVoiceAttachment, transcribeAudio } from './voice.js'

/** Runs inside serialized, authorized message preprocessing, not in the gateway router. */
export async function resolveVoiceMessage(message: Message, thread?: ThreadChannel): Promise<{ text: string; failed: boolean }> {
  const attachments = [...message.attachments.values()].filter((attachment) =>
    isVoiceAttachment(attachment, message.flags?.has(MessageFlags.IsVoiceMessage)),
  )
  if (!attachments.length) return { text: '', failed: false }
  const destination = thread || message.channel
  const channelId = thread?.parentId || (message.channel.isThread() ? message.channel.parentId : message.channelId)
  const project = channelId ? await getChannelDirectory(channelId) : undefined
  let recent = ''
  try {
    const history = await destination.messages.fetch({ limit: 20, before: message.id })
    recent = [...history.values()].reverse().map((entry) => entry.content).join('\n').slice(-8_000)
  } catch { /* Vocabulary context is best effort. */ }
  const transcripts: string[] = []
  for (const attachment of attachments) {
    const result = await transcribeAudio({
      context: `Project: ${project?.directory || channelId}\n${recent}`,
      audio: async () => {
        if (attachment.size > 25 * 1024 * 1024) throw new Error('Voice note too large')
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error('Voice download failed')
        return new Uint8Array(await response.arrayBuffer())
      },
    })
    if (result.notice) {
      if (destination.isSendable()) await destination.send({ content: result.notice, allowedMentions: { parse: [] } })
      continue
    }
    const transcript = result.text!
    transcripts.push(transcript)
    if (destination.isSendable()) {
      // Repeat attribution and quote formatting on every Discord-sized chunk.
      for (let start = 0; start < transcript.length; start += 850) {
        const quote = transcript.slice(start, start + 850).split('\n').map((line) => `> ${line}`).join('\n')
        await destination.send({ content: `Voice transcript — <@${message.author.id}>:\n${quote}`, allowedMentions: { parse: [] } })
      }
    }
  }
  return { text: transcripts.join('\n\n'), failed: !transcripts.length }
}
