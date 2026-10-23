// Retired sessions (#177): a thread bound to a session the agent backend does
// not own (e.g. one from a retired backend) moves to a new Pi
// session on its next message, seeded from the thread's chat history.

import { describe, expect, test } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { getThreadSession, setThreadSession } from './database.js'
import * as threadState from './session-handler/thread-runtime-state.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001530'
const RETIRED_SESSION_ID = 'ses_retiredbackend0000000001'

describe.skipIf(!findPi())('retired sessions move to a new Pi session', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'retired-session-e2e',
    dirName: 'retired-session-e2e',
    username: 'retired-tester',
  })

  test('the next message starts a seeded Pi session and says so in the thread', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: 'remember the word marmalade' })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => t.name === 'remember the word marmalade',
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })

    // The starter is in the parent channel, not the thread history. Put the
    // context to be recovered in the thread itself.
    await ctx.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'remember the word marmalade' })
    await waitForFooterMessage({
      discord: ctx.discord, threadId: thread.id, timeout: 20_000,
      afterMessageIncludes: 'remember the word marmalade', afterAuthorId: TEST_USER_ID,
    })

    // Bind the thread to a session Pi does not own.
    await setThreadSession(thread.id, RETIRED_SESSION_ID)
    threadState.setSessionId(thread.id, RETIRED_SESSION_ID)
    const requestsBefore = ctx.modelServer.bodies.length

    await ctx.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'what was the word' })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: ctx.discord.botUserId,
      text: "earlier session can't be resumed, so it moved to a new Pi session",
      timeout: 20_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 20_000,
      afterMessageIncludes: 'what was the word',
      afterAuthorId: TEST_USER_ID,
    })

    const sessionId = await getThreadSession(thread.id)
    expect(sessionId).not.toBe(RETIRED_SESSION_ID)
    expect(sessionId && ctx.pi.owns(sessionId)).toBe(true)

    // The model saw the seed (with the earlier exchange) before the new message.
    const turn = ctx.modelServer.bodies.slice(requestsBefore).find((body) => body.includes('what was the word'))
    expect(turn).toBeDefined()
    expect(turn).toContain('[Session moved]')
    expect(turn).toContain(RETIRED_SESSION_ID)
    expect(turn).toContain('remember the word marmalade')
    expect(turn!.indexOf('[Session moved]')).toBeLessThan(turn!.lastIndexOf('what was the word'))
  }, 60_000)
})
