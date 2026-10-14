// E2e tests for basic per-thread message queue ordering.
// Advanced interrupt/abort/retry tests are in thread-queue-advanced.e2e.test.ts.
//
// Runs real Pi against the scripted fake model server, which answers
// instantly (no real LLM calls), so poll timeouts can be aggressive (4s). The
// only real latency is Pi process startup and intentional partDelaysMs in
// matchers (100ms for user-reply).
//
// If total duration of a file exceeds ~10s, split into a new test file
// so vitest can parallelize across files.

import fs from 'node:fs'
import path from 'node:path'
import { describe, beforeAll, test, expect } from 'vitest'
import type { FakeMatcher } from './agent-backend/pi/fake-model-server.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { setupQueueAdvancedSuite, TEST_USER_ID, type QueueAdvancedContext } from './queue-advanced-e2e-setup.js'
import { store } from './store.js'
import {
  waitForFooterMessage,
  waitForBotMessageContaining,
  waitForMessageById,
  waitForBotMessageCount,
  waitForBotReplyAfterUserMessage,
  waitForBotReplyTo,
  waitForThreadState,
  getMessageVisibleText } from './test-utils.js'


function createMatchers(): FakeMatcher[] {
  const bashCreateFileMatcher: FakeMatcher = {
    id: 'bash-create-file',
    priority: 130,
    when: {
      lastMessageRole: 'user',
      rawPromptIncludes: 'BASH_TOOL_FILE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'bash-create-file' },
        {
          type: 'text-delta',
          id: 'bash-create-file',
          delta: 'running create file',
        },
        { type: 'text-end', id: 'bash-create-file' },
        { type: 'text-start', id: 'bash-create-file-status' },
        {
          type: 'text-delta',
          id: 'bash-create-file-status',
          delta: 'creating marker',
        },
        { type: 'text-end', id: 'bash-create-file-status' },
        {
          type: 'tool-call',
          toolCallId: 'bash-create-file-call',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'mkdir -p tmp && printf "created" > tmp/bash-tool-executed.txt',
            description: 'Create marker file for e2e test',
            hasSideEffect: true,
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
    },
  }

  const bashCreateFileFollowupMatcher: FakeMatcher = {
    id: 'bash-create-file-followup',
    priority: 120,
    when: {
      lastMessageRole: 'tool',
      rawPromptIncludes: 'BASH_TOOL_FILE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'bash-create-file-followup' },
        {
          type: 'text-delta',
          id: 'bash-create-file-followup',
          delta: 'file created',
        },
        { type: 'text-end', id: 'bash-create-file-followup' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
    },
  }

  const raceFinalReplyMatcher: FakeMatcher = {
    id: 'race-final-reply',
    priority: 110,
    when: {
      latestUserTextIncludes: 'Reply with exactly: race-final',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'race-final' },
        { type: 'text-delta', id: 'race-final', delta: 'race-final' },
        { type: 'text-end', id: 'race-final' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
      // Delay first output to widen the stale-idle window. The race happens
      // in <1ms; 500ms is plenty to keep the window reliably open.
      partDelaysMs: [0, 500, 0, 0, 0],
    },
  }

  // Slow matcher for "hotel": its reply lands ~400ms after the request, so a
  // message sent once the request is in flight arrives mid-stream.
  const hotelSlowMatcher: FakeMatcher = {
    id: 'hotel-slow-reply',
    priority: 20,
    when: {
      latestUserTextIncludes: 'Reply with exactly: hotel',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'hotel-reply' },
        { type: 'text-delta', id: 'hotel-reply', delta: 'ok' },
        { type: 'text-end', id: 'hotel-reply' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 100, 300, 0, 0],
    },
  }

  const userReplyMatcher: FakeMatcher = {
    id: 'user-reply',
    priority: 10,
    when: {
      lastMessageRole: 'user',
      rawPromptIncludes: 'Reply with exactly:',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'default-reply' },
        { type: 'text-delta', id: 'default-reply', delta: 'ok' },
        { type: 'text-end', id: 'default-reply' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
      partDelaysMs: [0, 100, 0, 0, 0],
    },
  }

  // Matcher that keeps the session busy for 2s after the first text part.
  // Used by queue-edit tests to ensure the follow-up message lands in the
  // local queue before the session finishes.
  const slowBusyMatcher: FakeMatcher = {
    id: 'slow-busy-reply',
    priority: 115,
    when: {
      latestUserTextIncludes: 'SLOW_BUSY_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'slow-busy' },
        { type: 'text-delta', id: 'slow-busy', delta: 'slow-busy-reply' },
        { type: 'text-end', id: 'slow-busy' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 100, 0, 0, 2_000],
    },
  }

  return [
    bashCreateFileMatcher,
    bashCreateFileFollowupMatcher,
    raceFinalReplyMatcher,
    slowBusyMatcher,
    hotelSlowMatcher,
    userReplyMatcher,
  ]
}

const TEXT_CHANNEL_ID = '200000000000000778'

/**
 * The thread transcript once the run is over: it ends with a footer and has
 * not changed for half a second. A follow-up answered in the same run gets
 * its own footer after the first one, so the first footer is not the end.
 */
async function settledText(th: { text: () => Promise<string> }, timeout = 4_000): Promise<string> {
  const start = Date.now()
  let last = ''
  let stableSince = Date.now()
  while (Date.now() - start < timeout) {
    const text = await th.text()
    if (text !== last) {
      last = text
      stableSince = Date.now()
    } else if (/\n-# \*project ⋅[^\n]*$/.test(text) && Date.now() - stableSince >= 500) {
      return text
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return last
}

describe.skipIf(!findPi())('thread message queue ordering', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'queue-e2e',
    dirName: 'thread-queue-e2e',
    username: 'queue-tester',
    extraMatchers: createMatchers(),
  })
  let directories: QueueAdvancedContext['directories']
  let discord: QueueAdvancedContext['discord']

  beforeAll(() => {
    directories = ctx.directories
    discord = ctx.discord
  })

  test(
    'first prompt on a cold backend still streams text parts',
    async () => {
      // First test in the file: no Pi process is running yet, so the runtime's
      // event listener starts before the session exists. The first prompt
      // must still show text parts.
      const prompt = 'Reply with exactly: cold-start-stream'

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === prompt
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        // A cold server bootstraps the directory instance on the first
        // session.create (config, plugins, skills, watcher): several seconds.
        timeout: 20_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: cold-start-stream
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
    },
    30_000,
  )

  test(
    'text message during active session gets processed',
    async () => {
      // 1. Send initial message to text channel → thread created + session established
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: alpha',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: alpha'
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the first bot reply so session is fully established in DB
      const firstReply = await th.waitForBotReply({
        timeout: 4_000,
      })
      expect(getMessageVisibleText(firstReply).trim().length).toBeGreaterThan(0)

      // Snapshot bot message count before sending follow-up
      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Send follow-up message B into the thread — serialized by runtime's enqueueIncoming
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: beta',
      })

      // 3. Wait for exactly 1 new bot message (the response to B)
      const after = await waitForBotMessageCount({
        discord,
        threadId: thread.id,
        count: beforeBotCount + 1,
        timeout: 4_000,
      })

      // 4. Verify at least 1 new bot message appeared for the follow-up.
      //    The bot may send additional messages per session (error reactions,
      //    session notifications) so we check >= not exact equality.
      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: 'beta',
        afterAuthorId: TEST_USER_ID,
      })

      const timeline = await th.text()
      expect(timeline).toContain('Reply with exactly: alpha')
      expect(timeline).toContain('Reply with exactly: beta')
      expect(timeline).toContain('ok')
      expect(timeline).toContain('*project ⋅ main ⋅')
      // User B's message must appear before the new bot response
      const userBIndex = after.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('beta')
        )
      })
      const lastBotIndex = after.findLastIndex((m) => {
        return m.author.id === discord.botUserId
      })

      expect(userBIndex).toBeGreaterThan(-1)
      expect(lastBotIndex).toBeGreaterThan(-1)
      expect(userBIndex).toBeLessThan(lastBotIndex)

      // New bot response has non-empty content
      const newBotReply = afterBotMessages[afterBotMessages.length - 1]!
      expect(getMessageVisibleText(newBotReply).trim().length).toBeGreaterThan(0)
    },
    12_000,
  )

  test(
    'two rapid text messages in thread — both processed in order',
    async () => {
      // 1. Send initial message to text channel → thread + session established
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: one',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: one'
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the first bot reply AND its footer so the first response
      // cycle is fully complete before sending follow-ups. Without this,
      // the footer for "one" can still be in-flight when the snapshot runs.
      const firstReply = await th.waitForBotReply({
        timeout: 4_000,
      })
      expect(getMessageVisibleText(firstReply).trim().length).toBeGreaterThan(0)

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'one',
        afterAuthorId: TEST_USER_ID,
      })

      // Snapshot bot message count before sending follow-ups
      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Rapidly send messages B and C. Neither interrupts: C reaches the
      // busy session as a follow-up, answered (with its own footer) after B.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: two',
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: three',
      })

      // 3. Wait for a bot reply after message C.
      const after = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'three',
        timeout: 4_000,
      })

      // The first footer after C; settledText waits for the last one.
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'three',
        afterAuthorId: TEST_USER_ID,
      })

      // 4. Verify the latest user message got a bot reply.
      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      expect(await settledText(th)).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: one
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        --- from: user (queue-tester)
        Reply with exactly: two
        Reply with exactly: three
        --- from: assistant (TestBot)
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
      const userThreeIndex = after.findIndex((message) => {
        return (
          message.author.id === TEST_USER_ID &&
          message.content.includes('three')
        )
      })
      expect(userThreeIndex).toBeGreaterThan(-1)

      const botAfterThreeIndex = after.findIndex((message, index) => {
        return index > userThreeIndex && message.author.id === discord.botUserId
      })
      expect(botAfterThreeIndex).toBeGreaterThan(userThreeIndex)

      const newBotReplies = afterBotMessages.slice(beforeBotCount)
      expect(newBotReplies.some((reply) => {
        return getMessageVisibleText(reply).trim().length > 0
      })).toBe(true)

      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return state.queueItems.length === 0
        },
        timeout: 4_000,
        description: 'queue empty after rapid interrupts',
      })
      expect(finalState.queueItems.length).toBe(0)
    },
    8_000,
  )

  test(
    'bash tool-call actually executes and creates file in project directory',
    async () => {
      const markerRelativePath = path.join('tmp', 'bash-tool-executed.txt')
      const markerPath = path.join(directories.projectDirectory, markerRelativePath)
      fs.rmSync(markerPath, { force: true })
      const existingThreadIds = new Set(
        (await discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => {
          return thread.id
        }),
      )

      const prompt = 'Reply with exactly: BASH_TOOL_FILE_MARKER'
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 6_000,
        predicate: (t) => {
          return !existingThreadIds.has(t.id)
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'running create file',
        timeout: 6_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 6_000,
      })

      const deadline = Date.now() + 4_000
      while (!fs.existsSync(markerPath) && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
      }

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: BASH_TOOL_FILE_MARKER
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        > running create filecreating marker

        -# ┣ bash _Create marker file for e2e test_

        file created
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
      expect(fs.existsSync(markerPath)).toBe(true)
      const markerContents = fs.readFileSync(markerPath, 'utf8')
      expect(markerContents).toBe('created')
    },
    8_000,
  )

  test(
    'slow stream still processes queued next message after completion',
    async () => {
      // A message sent mid-stream queues and runs after the in-flight request
      // completes (no auto-interrupt).

      // 1. Fast setup: establish session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: golf',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: golf'
        },
      })

      const th = discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(getMessageVisibleText(firstReply).trim().length).toBeGreaterThan(0)

      // Wait for golf's footer so the golf→hotel transition is deterministic
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: discord.botUserId,
      })

      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Start request B (hotel, slow matcher ~400ms), then send C while B
      //    is still in progress.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: hotel',
      })

      // 3. Once B's model request is in flight, send C so it arrives
      //    mid-stream and queues behind it.
      await expect.poll(() => ctx.modelServer!.log.some((request) => request.matcher === 'hotel-slow-reply'), { timeout: 4_000 }).toBe(true)
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: india',
      })

      // 4. B completes, then C gets processed.
      //    Poll until india's user message has a bot reply after it.
      const after = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'india',
        timeout: 4_000,
      })

      // The final text is edited from quoted to full width right before the
      // footer, so snapshot only after the turn's footer to avoid that race.
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'india',
      })

      // hotel's reply posts after india's message (it was mid-stream), and
      // each gets its own reply and footer: india is answered as a follow-up
      // after hotel's turn, never folded into it.
      expect(await settledText(th)).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: golf
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        --- from: user (queue-tester)
        Reply with exactly: hotel
        Reply with exactly: india
        --- from: assistant (TestBot)
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
      const userIndiaIndex = after.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('india')
      })
      expect(userIndiaIndex).toBeGreaterThan(-1)
      const botAfterIndia = after.findIndex((m, i) => {
        return i > userIndiaIndex && m.author.id === discord.botUserId
      })
      expect(botAfterIndia).toBeGreaterThan(userIndiaIndex)
    },
    8_000,
  )

  test(
    'queue drains correctly after bursty queued messages',
    async () => {
      // Verifies the queue doesn't get stuck after multiple rapid messages.

      // 1. Fast setup: establish session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: juliet',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: juliet'
        },
      })

      const th = discord.thread(thread.id)
      // Each message is answered in its own turn, so the transcript is done
      // when it has one footer per message sent.
      const waitForFooters = (count: number) => expect.poll(
        async () => (await th.text()).split('\n').filter((line) => line.startsWith('-# *project ⋅')).length,
        { timeout: 4_000 },
      ).toBe(count)
      await waitForFooters(1)

      // 2. Rapidly send B, C, D back-to-back: B runs, C and D queue behind it.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: kilo',
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: lima',
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: mike',
      })
      await waitForFooters(4)

      // 3. The queue drained: E is answered too.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: november',
      })
      await waitForFooters(5)

      expect(await settledText(th)).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: juliet
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        --- from: user (queue-tester)
        Reply with exactly: kilo
        Reply with exactly: lima
        Reply with exactly: mike
        --- from: assistant (TestBot)
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        --- from: user (queue-tester)
        Reply with exactly: november
        --- from: assistant (TestBot)
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
    },
    8_000,
  )

})
