// E2e test for busy-thread delivery (#83): a message sent while the agent is
// running a slow tool never aborts that tool. OpenCode takes the message at the
// next step boundary, so the step right after the tool already answers it.

import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect } from 'vitest'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001083'
const TOOL_DONE_FILE = 'boundary-tool-done.txt'

// Runs a bash tool that takes ~2s and then writes a file. An aborted tool
// never writes it.
const slowToolMatcher: DeterministicMatcher = {
  id: 'boundary-slow-tool',
  priority: 120,
  when: {
    lastMessageRole: 'user',
    latestUserTextIncludes: 'BOUNDARY_SLOW_TOOL_MARKER',
  },
  then: {
    parts: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'boundary-start' },
      { type: 'text-delta', id: 'boundary-start', delta: 'running slow tool' },
      { type: 'text-end', id: 'boundary-start' },
      {
        type: 'tool-call',
        toolCallId: 'boundary-slow-bash',
        toolName: 'bash',
        input: JSON.stringify({
          command: `sleep 2 && echo done > ${TOOL_DONE_FILE}`,
          description: 'Slow tool for boundary delivery test',
          hasSideEffect: true,
        }),
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ],
  },
}

// Answers the steered message once it is the latest user message.
const steerReplyMatcher: DeterministicMatcher = {
  id: 'boundary-steer-reply',
  priority: 119,
  when: {
    lastMessageRole: 'user',
    latestUserTextIncludes: 'BOUNDARY_STEER_MARKER',
  },
  then: {
    parts: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'boundary-steer' },
      { type: 'text-delta', id: 'boundary-steer', delta: 'steer-received' },
      { type: 'text-end', id: 'boundary-steer' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ],
  },
}

describe('busy thread: boundary delivery', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'boundary-delivery-e2e',
    dirName: 'boundary-delivery-e2e',
    username: 'boundary-tester',
    extraMatchers: [slowToolMatcher, steerReplyMatcher],
  })

  test(
    'a message during a slow tool does not abort it and is answered at the next step boundary',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'BOUNDARY_SLOW_TOOL_MARKER start',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'BOUNDARY_SLOW_TOOL_MARKER start'
        },
      })
      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'running slow tool',
        timeout: 4_000,
      })

      // The bash tool is now sleeping. The old interrupt aborted it here.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'BOUNDARY_STEER_MARKER please also note this',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'steer-received',
        afterUserMessageIncludes: 'BOUNDARY_STEER_MARKER',
        timeout: 10_000,
      })
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 6_000,
        afterMessageIncludes: 'steer-received',
        afterAuthorId: ctx.discord.botUserId,
      })

      // The tool ran to completion.
      const toolOutput = path.join(ctx.directories.projectDirectory, TOOL_DONE_FILE)
      expect(fs.readFileSync(toolOutput, 'utf8').trim()).toBe('done')

      // The run was never aborted. The old interrupt aborted it (a
      // MessageAbortedError) and replayed the message, even though the slow
      // shell command itself still finished.
      const eventsDir = path.join(ctx.directories.root, 'opencode-session-events')
      const threadEvents = fs
        .readdirSync(eventsDir)
        .map((file) => fs.readFileSync(path.join(eventsDir, file), 'utf8'))
        .filter((content) => content.includes(`"threadId":"${thread.id}"`))
        .join('\n')
      expect(threadEvents).toContain('boundary-slow-bash')
      expect(threadEvents).not.toContain('MessageAbortedError')

      const timeline = await th.text()
      // Delivered at the boundary: the step after the tool already saw the
      // steered message, so the plain post-tool reply never ran.
      expect(timeline).not.toContain('tool done')
      expect(timeline).not.toMatch(/abort/i)
      // One run, one footer.
      expect(timeline.match(/\*project ⋅/g)?.length).toBe(1)
    },
    20_000,
  )
})
