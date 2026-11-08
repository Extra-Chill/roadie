// Discord delivers "forward with a comment" as a bare forward followed by the
// comment. Both belong to one conversation: one thread, one turn.

import { describe, expect, test } from 'vitest'
import { MessageReferenceType, MessageType, type APIMessageSnapshot } from 'discord.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { waitForFooterMessage } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001560'

function forwardedSnapshot(content: string): APIMessageSnapshot {
  return {
    message: {
      content, embeds: [], attachments: [], mentions: [], mention_roles: [],
      timestamp: new Date().toISOString(), edited_timestamp: null, type: MessageType.Default,
    },
  } as APIMessageSnapshot
}

describe.skipIf(!findPi())('forward with a comment', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'forward-comment-e2e',
    dirName: 'forward-comment-e2e',
    username: 'forward-comment-tester',
  })

  test('opens one thread whose first turn carries the comment and the forward', async () => {
    const user = ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID)
    await user.sendMessage({
      content: '',
      messageReference: { type: MessageReferenceType.Forward, message_id: '300000000000001560', channel_id: '200000000000001561' },
      messageSnapshots: [forwardedSnapshot('FORWARDED BUG REPORT')],
    })
    await user.sendMessage({ content: 'look at this forwarded report' })

    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({ timeout: 10_000 })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })
    // Past the pairing window, so an unpaired forward would have opened its own thread.
    await new Promise((resolve) => setTimeout(resolve, 2_500))

    const threads = await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()
    expect(threads.map((t) => t.id)).toEqual([thread.id])
    const turn = ctx.modelServer.bodies.find((body) => body.includes('look at this forwarded report'))
    expect(turn).toContain('FORWARDED BUG REPORT')
  }, 60_000)
})
