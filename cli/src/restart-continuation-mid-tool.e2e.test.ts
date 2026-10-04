// E2e: a restart that lands while a tool call is still running. The agent
// server is stopped mid-tool, a fresh one is started, and the continuation
// turn must still produce a reply in the same thread and session.

import { describe, test, expect } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import {
  disposeRuntime,
  resumeInterruptedSessions,
  snapshotBusyRuntimes,
} from './session-handler/thread-session-runtime.js'
import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory, stopOpencodeServer } from './opencode.js'
import { waitForBotMessageContaining } from './test-utils.js'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'

const TEXT_CHANNEL_ID = '200000000000001062'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

function reply(id: string, text: string): DeterministicMatcher['then']['parts'] {
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

describe('restart continuation mid-tool', () => {
  const ctx = setupQueueAdvancedSuite({
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
    const projectDirectory = ctx.directories.projectDirectory
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

    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) throw getClient
    await waitFor(
      async () => {
        const { data } = await getClient().session.messages({ sessionID: sessionId, directory: projectDirectory })
        const running = (data ?? []).some((message) =>
          message.parts.some((part) => part.type === 'tool' && part.state.status === 'running'),
        )
        return running || undefined
      },
      { timeout: 10_000, label: 'the bash tool to start running' },
    )

    // Shutdown: snapshot busy runs, drop the runtimes, stop the agent server.
    const interrupted = snapshotBusyRuntimes()
    expect(interrupted.map((entry) => entry.threadId)).toContain(thread.id)
    disposeRuntime(thread.id)
    await stopOpencodeServer()

    // Startup: a fresh agent server, then the continuation pass.
    const restarted = await initializeOpencodeForDirectory(projectDirectory)
    if (restarted instanceof Error) throw restarted

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
  }, 45_000)
})
