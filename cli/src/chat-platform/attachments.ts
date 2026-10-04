import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as errore from 'errore'
import { getDataDir } from '../config.js'
import { processImage } from '../image-utils.js'
import type { DiscordFileAttachment } from '../message-formatting.js'

class ChatAttachmentError extends errore.createTaggedError({
  name: 'ChatAttachmentError',
  message: 'Cannot prepare attachment $filename',
}) {}

/** Shared native attachment preparation for chat intake and CLI sends. */
export async function prepareChatAttachments(
  files: Array<{ name: string; mimetype: string; bytes: Buffer }>,
): Promise<{ images: DiscordFileAttachment[]; context: string } | Error> {
  const images: DiscordFileAttachment[] = []
  const context: string[] = []
  for (const file of files) {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      const processed = await processImage(file.bytes, file.mimetype).catch(
        (cause) => new ChatAttachmentError({ filename: file.name, cause }),
      )
      if (processed instanceof Error) return processed
      images.push({
        type: 'file',
        mime: processed.mime,
        filename: file.name,
        url: `data:${processed.mime};base64,${processed.buffer.toString('base64')}`,
      })
      continue
    }
    const directory = path.join(getDataDir(), 'attachments')
    const created = await fs
      .mkdir(directory, { recursive: true })
      .catch((cause) => new ChatAttachmentError({ filename: file.name, cause }))
    if (created instanceof Error) return created
    const filePath = path.join(directory, `${crypto.randomUUID()}-${path.basename(file.name)}`)
    const saved = await fs
      .writeFile(filePath, file.bytes)
      .catch((cause) => new ChatAttachmentError({ filename: file.name, cause }))
    if (saved instanceof Error) return saved
    const text = file.mimetype.startsWith('text/') || /json|javascript|xml|yaml/.test(file.mimetype)
    const body =
      text && file.bytes.length <= 16_384
        ? `\n${file.bytes.toString('utf8')}\n`
        : '\nRead the attached file at its local path.\n'
    context.push(
      `<attachment path="${filePath.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">${body}</attachment>`,
    )
  }
  return { images, context: context.join('\n\n') }
}
