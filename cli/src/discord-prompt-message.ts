// Shared Discord prompt delivery shape for CLI sends and durable automation.
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js'

export function buildLongPromptMessage(prompt: string): {
  content: string
  fileText: string
} {
  const preview = prompt.slice(0, 100).replace(/\n/g, ' ')
  return {
    content: `Prompt attached as file (${prompt.length} chars)\n\n> ${preview}…`,
    fileText: prompt,
  }
}

export function prepareDiscordPromptMessage({
  prompt,
  metadata = {},
  attachmentContent,
}: {
  prompt: string
  metadata?: Omit<RESTPostAPIChannelMessageJSONBody, 'content' | 'attachments'>
  /** Optional compact header for automation whose visible marker is meaningful. */
  attachmentContent?: string
}) {
  if (prompt.length <= 2000) {
    return { body: { ...metadata, content: prompt } }
  }
  const longPrompt = buildLongPromptMessage(prompt)
  return {
    body: {
      ...metadata,
      content: attachmentContent ?? longPrompt.content,
      attachments: [{ id: 0, filename: 'prompt.md' }],
    },
    files: [
      {
        name: 'prompt.md',
        data: Buffer.from(longPrompt.fileText, 'utf8'),
        contentType: 'text/markdown',
      },
    ],
  }
}
