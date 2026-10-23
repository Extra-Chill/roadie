// E2e test for question tool: user text message during pending question should
// dismiss the question (abort), then enqueue as a normal user prompt.
// The user's message must appear as a real user message in the thread, not
// get consumed as a tool result answer (which lost voice/image content).

import { describe, test, expect } from 'vitest'
import { findPi } from './agent-backend/pi/find-pi.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
  waitForFooterMessage,
} from './test-utils.js'
import { getThreadSession } from './database.js'

const TEXT_CHANNEL_ID = '200000000000001007'

describe.skipIf(!findPi())('queue advanced: question tool answer', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-e2e',
    dirName: 'qa-question-e2e',
    username: 'queue-question-tester',
  })

  test('user text message dismisses pending question and enqueues as normal prompt', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'QUESTION_TEXT_ANSWER_MARKER',
    })

    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 8_000,
      predicate: (t) => {
        return t.name === 'QUESTION_TEXT_ANSWER_MARKER'
      },
    })

    const th = ctx.discord.thread(thread.id)

    // Wait for the question dropdown message to appear in Discord.
    // This is the user-visible signal that the question tool fired and
    // roadie processed the event. Avoids polling internal Maps which
    // have timing sensitivity on slower CI hardware.
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      text: 'Which option do you prefer?',
      timeout: 12_000,
    })

    // User sends a text message while question is pending.
    // This should:
    // 1. Dismiss the pending question (cleanup context)
    // 2. Abort the blocked session so Pi unblocks
    // 3. Enqueue the message as a normal user prompt (not consumed as answer)
    const answer = 'Reply with exactly: question-text-answer-done'
    await th.user(TEST_USER_ID).sendMessage({
      content: answer,
    })

    await waitForBotReplyAfterUserMessage({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      userMessageIncludes: answer,
      timeout: 8_000,
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'ok',
      afterUserMessageIncludes: answer,
      timeout: 8_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 8_000,
      afterMessageIncludes: 'ok',
      afterAuthorId: ctx.discord.botUserId,
    })

    const timeline = await th.text({ showInteractions: true })

    // The user's text answer must appear in Discord
    expect(timeline).toContain(answer)
    expect(timeline).toContain('ok')
    // The original question must have appeared
    expect(timeline).toContain('Which option do you prefer?')
    // The user's marker message triggered the question
    expect(timeline).toContain('QUESTION_TEXT_ANSWER_MARKER')
  }, 20_000)
})
