// E2e: leftover aborted text must post before a later question dropdown.
// Abort leaves an open text part buffered under the first assistant message.
// The retry is a new user turn, so a single-id / current-turn flush misses it.

import { describe, test, expect } from 'vitest'
import { findPi } from './agent-backend/pi/find-pi.js'
import type { FakeMatcher } from './agent-backend/pi/fake-model-server.js'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { getRuntime } from './session-handler/thread-session-runtime.js'
import { getMessageVisibleText, waitForBotMessageContaining } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001043'

function createAbortRetryQuestionMatchers(): FakeMatcher[] {
  const leftoverOpenTextMatcher: FakeMatcher = {
    id: 'abort-retry-leftover-open-text',
    priority: 130,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'ABORT_RETRY_LEFTOVER_TEXT_MARKER',
    },
    then: {
      parts: [
        // One text block that never ends: the run is aborted mid-block and
        // the partial text is all Roadie has of it.
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'abort-retry-leftover' },
        {
          type: 'text-delta',
          id: 'abort-retry-leftover',
          delta: 'LEFTOVER_ABORTED_TEXT',
        },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 0, 0, 100_000],
    },
  }

  const questionAfterAbortMatcher: FakeMatcher = {
    id: 'question-after-abort-retry',
    priority: 131,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'QUESTION_AFTER_ABORT_RETRY_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'plan-after-abort' },
        {
          type: 'text-delta',
          id: 'plan-after-abort',
          delta: 'PLAN_AFTER_ABORT_RETRY',
        },
        {
          type: 'tool-call',
          toolCallId: 'question-after-abort-call',
          toolName: 'question',
          input: JSON.stringify({
            questions: [{
              question: 'What next after abort?',
              header: 'Next step',
              options: [
                { label: 'Commit', description: 'Commit these files' },
                { label: 'Stop', description: 'Leave uncommitted' },
              ],
            }],
          }),
        },
        { type: 'text-end', id: 'plan-after-abort' },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [200, 0, 0, 0, 400, 0],
    },
  }

  return [leftoverOpenTextMatcher, questionAfterAbortMatcher]
}

describe.skipIf(!findPi())('question text before dropdown after abort retry', () => {
  const ctx = setupQueueAdvancedSuite({
    backend: 'pi',
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-abort-retry-order',
    dirName: 'qa-question-abort-retry-order',
    username: 'question-abort-retry-tester',
    extraMatchers: createAbortRetryQuestionMatchers(),
  })

  test(
    'posts leftover aborted text before the question dropdown',
    async () => {
      const leftoverMarker = 'ABORT_RETRY_LEFTOVER_TEXT_MARKER'
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: leftoverMarker,
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 8_000,
        predicate: (t) => {
          return t.name === leftoverMarker
        },
      })
      const th = ctx.discord.thread(thread.id)

      // Pi shows a text block when it ends, and this one never does: wait
      // until the model has streamed it, then abort mid-block.
      const streamStart = Date.now()
      while (
        !ctx.modelServer!.log.some((request) => request.matcher === 'abort-retry-leftover-open-text')
        && Date.now() - streamStart < 8_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await new Promise((resolve) => setTimeout(resolve, 300))

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime for abort-retry question test')
      }
      void runtime.abortActiveRun('test-question-abort-retry-flush')

      await th.user(TEST_USER_ID).sendMessage({
        content: 'QUESTION_AFTER_ABORT_RETRY_MARKER',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'What next after abort?',
        timeout: 8_000,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (question-abort-retry-tester)
        ABORT_RETRY_LEFTOVER_TEXT_MARKER
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        --- from: user (question-abort-retry-tester)
        QUESTION_AFTER_ABORT_RETRY_MARKER
        --- from: assistant (TestBot)
        > LEFTOVER_ABORTED_TEXT
        PLAN_AFTER_ABORT_RETRY
        **Next step**
        What next after abort?"
      `)

      const messages = await th.getMessages()
      const leftoverIndex = messages.findIndex((message) => {
        return getMessageVisibleText(message).includes('LEFTOVER_ABORTED_TEXT')
      })
      const questionIndex = messages.findIndex((message) => {
        return getMessageVisibleText(message).includes('What next after abort?')
      })
      expect(leftoverIndex).toBeGreaterThanOrEqual(0)
      expect(questionIndex).toBeGreaterThan(leftoverIndex)
    },
    15_000,
  )
})
