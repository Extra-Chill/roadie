import type { Message, ThreadChannel } from 'discord.js'
import { splitMarkdownForDiscord } from './discord-utils.js'

/** Mirror paired forwards for humans without adding another model turn. */
export async function postForwardedSnapshot(thread: ThreadChannel, forwarded: Message): Promise<void> {
  for (const snapshot of forwarded.messageSnapshots.values()) {
    const text = [
      snapshot.content,
      ...snapshot.attachments.map((attachment) => `<${attachment.url}>`),
    ].filter(Boolean).join('\n')
    const attribution = `Forwarded by <@${forwarded.author.id}>`
    const chunks = splitMarkdownForDiscord({ content: text, maxLength: 1800 })
    const embeds = snapshot.embeds.map((embed) => embed.toJSON())
    // Discord permits at most ten embeds and 2,000 content characters per message.
    for (let i = 0; i < Math.max(chunks.length, Math.ceil(embeds.length / 10), 1); i++) {
      await thread.send({
        content: `${attribution}${chunks[i] ? `\n>>> ${chunks[i]}` : ''}`,
        embeds: embeds.slice(i * 10, (i + 1) * 10),
        allowedMentions: { parse: [] },
      })
    }
  }
}
