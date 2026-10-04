import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { verifySlackSignature } from './slack-bot.js'
import { slackText } from './chat-platform/slack-api.js'

test('verify the original request bytes and timestamp, reject tampering and replay', () => {
  const body = Buffer.from('{"type":"event_callback"}')
  const timestamp = '1700000000'
  const secret = 'test-secret'
  const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`
  const input = { body, timestamp, signature, secret, now: Number(timestamp) * 1000 }
  expect(verifySlackSignature(input)).toBe(true)
  expect(verifySlackSignature({ ...input, body: Buffer.from('{}') })).toBe(false)
  expect(verifySlackSignature({ ...input, now: input.now + 301_000 })).toBe(false)
  expect(verifySlackSignature({ ...input, signature: 'v0=short' })).toBe(false)
  expect(verifySlackSignature({ ...input, timestamp: undefined })).toBe(false)
})

test('Slack prose conversion preserves code and makes silent mentions inert', () => {
  expect(slackText('**Bold** `**code**`\n```\n**code block**\n```\n<@U123>')).toBe(
    '*Bold* `**code**`\n```\n**code block**\n```\n&lt;@U123&gt;',
  )
  expect(slackText('<@U123>', true)).toBe('<@U123>')
})
