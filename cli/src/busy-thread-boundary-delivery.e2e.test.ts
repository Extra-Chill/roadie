// E2e test for busy-thread delivery (#83): a message sent while the agent is
// running a slow tool never aborts that tool. Pi steers it in at the next
// step boundary (streamingBehavior "steer"): the run finishes its tool calls,
// then answers it.

import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, vi } from 'vitest'
import { Routes } from 'discord.js'
import YAML from 'yaml'
import { issueAgentSendNonce, resolveAgentSendPerson } from './session-handler/agent-send-person.js'
import { getThreadSession, listThreadQueueItems, setSessionTurnAttribution } from './database.js'
import { getRuntime } from './session-handler/runtime-registry.js'
import { sessionListIsBusy } from './session-handler/session-list-busy.js'
import type { FakeMatcher } from './agent-backend/pi/fake-model-server.js'
import { findPi } from './agent-backend/pi/find-pi.js'
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
const slowToolMatcher: FakeMatcher = {
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
const steerReplyMatcher: FakeMatcher = {
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

describe.skipIf(!findPi())('busy thread: boundary delivery', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'boundary-delivery-e2e',
    dirName: 'boundary-delivery-e2e',
    username: 'boundary-tester',
    extraMatchers: [slowToolMatcher, steerReplyMatcher],
  })

  test.each([
    { name: 'same person', person: TEST_USER_ID, nonce: 'fresh', queued: false },
    { name: 'different person', person: 'other-person', nonce: 'fresh', queued: true },
    { name: 'no nonce', person: TEST_USER_ID, nonce: 'none', queued: true },
    { name: 'replayed nonce', person: TEST_USER_ID, nonce: 'replayed', queued: true },
    { name: 'unknown nonce', person: TEST_USER_ID, nonce: 'unknown', queued: true },
  ] as const)('agent send from $name respects busy-turn isolation', async (row) => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: `BOUNDARY_SLOW_TOOL_MARKER ${row.name}`,
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000, predicate: (t) => t.name === `BOUNDARY_SLOW_TOOL_MARKER ${row.name}`,
    })
    await waitForBotMessageContaining({
      discord: ctx.discord, threadId: thread.id, userId: TEST_USER_ID,
      text: 'running slow tool', timeout: 4_000,
    })
    const sessionId = (await getThreadSession(thread.id))!
    expect(await sessionListIsBusy(sessionId, false)).toBe(true)
    const sourceSession = `source-${row.name}`
    await setSessionTurnAttribution({
      sessionId: sourceSession, personId: row.person,
      actor: { platform: 'discord', id: TEST_USER_ID, name: 'source', via: 'chat' },
    })
    const issued = issueAgentSendNonce(sourceSession)
    if (row.nonce === 'replayed') await resolveAgentSendPerson(issued)
    const nonce = { fresh: issued, replayed: issued, unknown: 'f'.repeat(64), none: undefined }[row.nonce]
    const runtime = getRuntime(thread.id)!
    const enqueue = vi.spyOn(runtime, 'enqueueIncoming')
    await ctx.botClient.rest.post(Routes.channelMessages(thread.id), {
      body: {
        content: 'BOUNDARY_STEER_MARKER please also note this',
        embeds: [{ footer: { text: YAML.stringify({
          start: true, userId: 'cli-asserted-user',
          agentSendNonce: nonce,
        }) } }],
      },
    })
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 1_000 })
    const result = await enqueue.mock.results[0]!.value
    expect(result.queued).toBe(row.queued)
    expect((await listThreadQueueItems(thread.id)).length).toBe(row.queued ? 1 : 0)
    enqueue.mockRestore()
    await waitForBotMessageContaining({
      discord: ctx.discord, threadId: thread.id, userId: TEST_USER_ID,
      text: 'steer-received', timeout: 10_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord, threadId: thread.id, timeout: 6_000,
      afterMessageIncludes: 'steer-received', afterAuthorId: ctx.discord.botUserId,
    })
  }, 20_000)

  test(
    'a message during a slow tool does not abort it and is answered after it',
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

      // The run was never aborted (an abort is a MessageAbortedError and a
      // replay of the message, even though the shell command still finished).
      const eventsDir = path.join(ctx.directories.root, 'session-events')
      const threadEvents = fs
        .readdirSync(eventsDir)
        .map((file) => fs.readFileSync(path.join(eventsDir, file), 'utf8'))
        .filter((content) => content.includes(`"threadId":"${thread.id}"`))
        .join('\n')
      expect(threadEvents).toContain('boundary-slow-bash')
      expect(threadEvents).not.toContain('MessageAbortedError')
      expect(ctx.modelServer!.log.some((request) => request.aborted)).toBe(false)

      const timeline = await th.text()
      expect(timeline).not.toMatch(/abort/i)
      // Steered delivery (#334): the steered message is answered at the next
      // step boundary, so the turn that answers it is the same run's turn
      // after the slow tool — the old post-tool "tool done" turn is gone.
      // The tool's rendering precedes the reply, and the model request that
      // answered it already carried the tool call: mid-run, not after settle.
      expect(timeline.indexOf('boundary-tool-done.txt')).toBeGreaterThan(-1)
      expect(timeline.indexOf('boundary-tool-done.txt')).toBeLessThan(timeline.indexOf('steer-received'))
      expect(timeline.match(/steer-received/g)?.length).toBe(1)
      const steerRequest = ctx.modelServer!.log.find((entry) =>
        entry.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('BOUNDARY_STEER_MARKER')))
      expect(steerRequest).toBeDefined()
      expect(JSON.stringify(steerRequest!.messages)).toContain('boundary-tool-done.txt')
    },
    20_000,
  )
})
