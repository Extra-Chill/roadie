import { Collection, EmbedBuilder, type Message, type ThreadChannel } from 'discord.js'
import { expect, test, vi } from 'vitest'
import { postForwardedSnapshot } from './forward-thread-snapshot.js'

test('mirrors an embed-only forward with attachment links and no mention pings', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  const forwarded = {
    author: { id: '123' },
    messageSnapshots: new Collection([['snapshot', {
      content: '',
      embeds: [new EmbedBuilder().setTitle('Deployment')],
      attachments: new Collection([['file', { url: 'https://cdn.example/report.pdf' }]]),
    }]]),
  } as unknown as Message

  await postForwardedSnapshot({ send } as unknown as ThreadChannel, forwarded)

  expect(send).toHaveBeenCalledExactlyOnceWith({
    content: 'Forwarded by <@123>\n>>> <https://cdn.example/report.pdf>',
    embeds: [{ title: 'Deployment' }],
    allowedMentions: { parse: [] },
  })
})
