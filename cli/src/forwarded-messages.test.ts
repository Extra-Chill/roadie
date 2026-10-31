import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Collection, type Attachment, type Embed, type Message, type MessageSnapshot, type Sticker } from 'discord.js'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { getFileAttachments, getTextAttachments, isMissingReadableMessageContent, serializeMessageExtras, TEXT_ATTACHMENT_INLINE_LIMIT_BYTES } from './message-formatting.js'
import { processImage } from './image-utils.js'

const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('./config.js', () => ({ getDataDir: () => state.dir }))
vi.mock('./image-utils.js', () => ({
  processImage: vi.fn(async (buffer: Buffer, mime: string) => ({ buffer, mime })),
}))
state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-forwards-'))
afterAll(() => fs.rmSync(state.dir, { recursive: true, force: true }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

function attachment(id: string, contentType = 'text/plain', size = 5): Attachment {
  return { id, name: `${id}.file`, contentType, size, url: `https://cdn.example/${id}` } as Attachment
}
type Payload = Pick<Message, 'content' | 'embeds' | 'attachments' | 'stickers'>

function snapshot(overrides: Partial<Payload> = {}): MessageSnapshot {
  return {
    content: '', embeds: [], attachments: new Collection(), stickers: new Collection(),
    ...overrides,
  } as MessageSnapshot
}
function message(snapshots: MessageSnapshot[] = [], overrides: Partial<Payload & Pick<Message, 'author'>> = {}): Message {
  return {
    author: { bot: false }, content: '', embeds: [], poll: null,
    attachments: new Collection(), stickers: new Collection(),
    messageSnapshots: new Collection(snapshots.map((value, i) => [String(i), value])),
    ...overrides,
  } as Message
}

describe('forwarded message ingress', () => {
  test.each([
    ['embed', snapshot({ embeds: [{ title: 'Forwarded preview', fields: [] } as unknown as Embed] }), 'Title: Forwarded preview'],
    ['content', snapshot({ content: 'Forwarded text' }), 'Forwarded text'],
    ['attachment', snapshot({ attachments: new Collection([['file', attachment('file')]]) }), 'https://cdn.example/file'],
    ['sticker', snapshot({ stickers: new Collection([['sticker', { name: 'Hello', url: 'https://cdn.example/sticker' } as Sticker]]) }), 'Hello'],
  ])('accepts and renders a forward with only %s', (_kind, payload, expected) => {
    const forwarded = message([payload])
    expect(isMissingReadableMessageContent(forwarded)).toBe(false)
    const rendered = serializeMessageExtras(forwarded)
    expect(rendered).toContain('<forwarded-message>')
    expect(rendered).toContain(expected)
    expect(rendered).toContain('</forwarded-message>')
  })

  test('rejects truly empty messages, including empty/whitespace snapshots', () => {
    for (const snapshots of [[], [snapshot()], [snapshot({ content: '  \n' }), snapshot()]]) {
      expect(isMissingReadableMessageContent(message(snapshots))).toBe(true)
    }
  })

  test('checks every snapshot', () => {
    expect(isMissingReadableMessageContent(message([snapshot(), snapshot({ content: 'last' })]))).toBe(false)
  })

  test('preserves direct payload and bot exemptions', () => {
    for (const overrides of [
      { content: 'hello' }, { embeds: [{} as Embed] },
      { attachments: new Collection([['file', attachment('file')]]) },
      { stickers: new Collection([['sticker', {} as Sticker]]) },
      { author: { bot: true } as Message['author'] },
    ]) expect(isMissingReadableMessageContent(message([], overrides))).toBe(false)
  })
})

describe('forwarded attachment processing', () => {
  test('downloads direct and snapshot images/PDFs through the same file pipeline', async () => {
    const fetch = vi.fn(async () => new Response('bytes'))
    vi.stubGlobal('fetch', fetch)
    const direct = attachment('direct', 'image/png')
    const image = attachment('image', 'image/png')
    const pdf = attachment('pdf', 'application/pdf')
    const result = await getFileAttachments(message([
      snapshot({ attachments: new Collection([['image', image]]) }),
      snapshot({ attachments: new Collection([['pdf', pdf], ['text', attachment('text')]]) }),
    ], { attachments: new Collection([['direct', direct]]) }))
    expect(fetch.mock.calls).toHaveLength(3)
    expect(processImage).toHaveBeenCalledWith(Buffer.from('bytes'), 'image/png')
    expect(processImage).toHaveBeenCalledWith(Buffer.from('bytes'), 'application/pdf')
    expect(result).toEqual([direct, image, pdf].map((file) => ({
      type: 'file', mime: file.contentType, filename: file.name,
      url: `data:${file.contentType};base64,${Buffer.from('bytes').toString('base64')}`,
      sourceUrl: file.url,
    })))
  })

  test('inlines small snapshot text and saves large text alongside direct attachments', async () => {
    const fetch = vi.fn(async () => new Response('hello'))
    vi.stubGlobal('fetch', fetch)
    const files = [attachment('direct'), attachment('small'), attachment('large', 'text/plain', TEXT_ATTACHMENT_INLINE_LIMIT_BYTES + 1)]
    const result = await getTextAttachments(message([
      snapshot({ attachments: new Collection([['small', files[1]!]]) }),
      snapshot({ attachments: new Collection([['large', files[2]!], ['image', attachment('image', 'image/png')]]) }),
    ], { attachments: new Collection([['direct', files[0]!]]) }))
    expect(fetch.mock.calls).toHaveLength(3)
    for (const file of files) {
      const saved = path.join(state.dir, 'attachments', `${file.id}-${file.name}`)
      expect(fs.readFileSync(saved, 'utf8')).toBe('hello')
      expect(result).toContain(saved)
      expect(result).toContain(file.url)
    }
    expect(result.match(/\nhello\n/g)).toHaveLength(2)
    expect(result).toContain('large="true"')
  })
})
