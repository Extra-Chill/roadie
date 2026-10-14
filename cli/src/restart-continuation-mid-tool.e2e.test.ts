// E2e: a restart that lands while a tool call is still running. Every Pi
// process is killed mid-tool, a fresh backend is started over the same session
// files, and the continuation turn must still produce a reply in the same
// thread and session.

import { describe, test, expect } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import {
  disposeRuntime,
  resumeInterruptedSessions,
  snapshotBusyRuntimes,
} from './session-handler/thread-session-runtime.js'
import { getThreadSession } from './database.js'
import { waitForBotMessageContaining } from './test-utils.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import type { FakePart } from './agent-backend/pi/fake-model-server.js'

const TEXT_CHANNEL_ID = '200000000000001062'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

function reply(id: string, text: string): FakePart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
    { type: 'finish', finishReason: 'stop', usage },
  ]
}

async function waitFor<T>(
  check: () => Promise<T | undefined>,
  { timeout, label }: { timeout: number; label: string },
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe.skipIf(!findPi())('restart continuation mid-tool', () => {
  const ctx = setupQueueAdvancedSuite({
    backend: 'pi',
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-restart-mid-tool-e2e',
    dirName: 'qa-restart-mid-tool-e2e',
    username: 'restart-mid-tool-tester',
    extraMatchers: [
      {
        id: 'restart-mid-tool-sleep',
        priority: 140,
        when: { lastMessageRole: 'user', latestUserTextIncludes: 'MIDTOOL_PROBE' },
        then: {
          parts: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'midtool' },
            { type: 'text-delta', id: 'midtool', delta: 'starting the long tool' },
            { type: 'text-end', id: 'midtool' },
            {
              type: 'tool-call',
              toolCallId: 'midtool-sleep',
              toolName: 'bash',
              input: JSON.stringify({ command: 'sleep 60', description: 'Long running probe tool' }),
            },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ],
        },
      },
      {
        id: 'restart-mid-tool-continuation',
        priority: 150,
        when: { lastMessageRole: 'user', latestUserTextIncludes: 'Roadie restarted while you were working' },
        then: { parts: reply('midtool-cont', 'midtool-continuation-seen') },
      },
    ],
  })

  test('a run stopped mid-tool resumes after the agent server restarts', async () => {
    // Pi reports the bash call as running once it has started it.
    const listening = new AbortController()
    const events = await ctx.pi!.subscribeEvents({ signal: listening.signal })
    const toolRunning = (async () => {
      for await (const { events: batch } of events) {
        const running = batch.some((event) =>
          event.type === 'part' && event.part.kind === 'tool' && event.part.callId === 'midtool-sleep' && event.part.status === 'running',
        )
        if (running) return listening.abort()
      }
    })()
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'MIDTOOL_PROBE start a long tool',
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => t.name?.includes('MIDTOOL_PROBE') ?? false,
    })
    const sessionId = await waitFor(async () => (await getThreadSession(thread.id)) || undefined, {
      timeout: 8_000,
      label: 'thread session',
    })

    await Promise.race([
      toolRunning,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for the bash tool to start running')), 10_000)),
    ]).finally(() => listening.abort())

    // Shutdown: snapshot busy runs, drop the runtimes, kill every Pi process.
    const interrupted = snapshotBusyRuntimes()
    expect(interrupted.map((entry) => entry.threadId)).toContain(thread.id)
    disposeRuntime(thread.id)
    ctx.restartPi!()

    // Startup: the continuation pass on the fresh backend.
    const result = await resumeInterruptedSessions({
      discordClient: ctx.botClient,
      appId: ctx.discord.botUserId,
      consume: () => ({ resume: interrupted, stale: [] }),
    })
    expect(result.resumed).toEqual([thread.id])

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'midtool-continuation-seen',
      timeout: 15_000,
    })
    expect(await getThreadSession(thread.id)).toBe(sessionId)
    // The continuation ran on the interrupted history: the probe and the
    // half-finished tool call reached the model again.
    const continuation = ctx.modelServer!.log.find((request) => request.matcher === 'restart-mid-tool-continuation')
    const history = JSON.stringify(continuation?.messages)
    expect(history).toContain('MIDTOOL_PROBE')
    expect(history).toContain('midtool-sleep')
  }, 45_000)
})
