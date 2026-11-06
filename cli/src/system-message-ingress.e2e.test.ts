// A thread rename posts a Discord system message authored by the renamer, with
// the new name as content. It is an event, not speech, so it never reaches the agent.

import { describe, expect, test } from 'vitest'
import { MessageType } from 'discord.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { waitForFooterMessage } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001540'

describe.skipIf(!findPi())('Discord system messages', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'system-message-e2e',
    dirName: 'system-message-e2e',
    username: 'system-message-tester',
  })

  test('a thread rename is not sent to the agent as a user message', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: 'start the system message thread' })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => t.name === 'start the system message thread',
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })

    await ctx.discord.simulateUserMessage({
      channelId: thread.id,
      userId: TEST_USER_ID,
      content: 'RENAMED THREAD TITLE',
      type: MessageType.ChannelNameChange,
    })
    await ctx.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'message after the rename' })
    await waitForFooterMessage({
      discord: ctx.discord, threadId: thread.id, timeout: 20_000,
      afterMessageIncludes: 'message after the rename', afterAuthorId: TEST_USER_ID,
    })

    const bodies = ctx.modelServer.bodies.join('\n')
    expect(bodies).toContain('message after the rename')
    expect(bodies).not.toContain('RENAMED THREAD TITLE')
  }, 60_000)
})
