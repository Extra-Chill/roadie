// E2e: the agent backend aborts a restart continuation turn before it produces
// anything (the live failure in roadie#100). The abort comes straight from the
// OpenCode API, not through Roadie, so Roadie must notice the silent turn on
// idle, re-send the continuation once, and post a notice if that fails too.

import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { resumeInterruptedSessions } from './session-handler/thread-session-runtime.js'
import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory, OPENCODE_SERVER_LOG_FILE } from './opencode.js'
import { RESTART_CONTINUATION_PROMPT } from './service-lifecycle.js'
import { waitForBotMessageContaining } from './test-utils.js'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'

const TEXT_CHANNEL_ID = '200000000000001064'

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
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('restart continuation aborted by the backend', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-restart-abort-e2e',
    dirName: 'qa-restart-abort-e2e',
    username: 'restart-abort-tester',
    extraMatchers: [
      {
        id: 'restart-abort-first-turn',
        priority: 140,
        when: { lastMessageRole: 'user', latestUserTextRegex: 'BACKEND_ABORT_(ONCE|ALWAYS)' },
        then: { parts: reply('abort-first', 'abort-probe-first-turn') },
      },
      {
        // Slow to start, so the test can abort the turn before any output.
        id: 'restart-abort-continuation',
        priority: 160,
        when: {
          lastMessageRole: 'user',
          latestUserTextIncludes: 'Roadie restarted while you were working',
          promptTextRegex: 'BACKEND_ABORT_(ONCE|ALWAYS)',
        },
        then: {
          parts: reply('abort-cont', 'abort-probe-resumed'),
          partDelaysMs: [2_500, 0, 0, 0, 0],
        },
      },
    ],
  })

  async function startThread(tag: string) {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: `${tag} start some work`,
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => t.name?.includes(tag) ?? false,
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'abort-probe-first-turn',
      timeout: 8_000,
    })
    const sessionId = await getThreadSession(thread.id)
    expect(sessionId).toBeTruthy()
    return { thread, sessionId: sessionId! }
  }

  /** Abort the given continuation attempt from the backend side once it has started. */
  async function abortContinuationAttempt({ sessionId, attempt }: { sessionId: string; attempt: number }) {
    const directory = ctx.directories.projectDirectory
    const getClient = await initializeOpencodeForDirectory(directory)
    if (getClient instanceof Error) throw getClient
    await waitFor(
      async () => {
        const { data } = await getClient().session.messages({ sessionID: sessionId, directory })
        const messages = data ?? []
        const continuations = messages.filter((message) =>
          message.info.role === 'user'
          && message.parts.some((part) => part.type === 'text' && part.text.includes(RESTART_CONTINUATION_PROMPT)),
        )
        const target = continuations[attempt - 1]
        if (!target) return undefined
        const started = messages.some((message) =>
          message.info.role === 'assistant'
          && message.info.parentID === target.info.id
          && !message.info.time.completed,
        )
        return started || undefined
      },
      { timeout: 10_000, label: `continuation attempt ${attempt} to start` },
    )
    await getClient().session.abort({ sessionID: sessionId, directory })
  }

  test('an aborted continuation with no output is re-sent once and then replies', async () => {
    const { thread, sessionId } = await startThread('BACKEND_ABORT_ONCE')
    const result = await resumeInterruptedSessions({
      discordClient: ctx.botClient,
      appId: ctx.discord.botUserId,
      consume: () => ({
        resume: [{ threadId: thread.id, sessionId, userId: TEST_USER_ID, username: 'restart-abort-tester' }],
        stale: [],
      }),
    })
    expect(result.resumed).toEqual([thread.id])

    await abortContinuationAttempt({ sessionId, attempt: 1 })

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'abort-probe-resumed',
      timeout: 15_000,
    })
    const text = await ctx.discord.thread(thread.id).text()
    expect(text).not.toContain("couldn't resume this run")
    expect(await getThreadSession(thread.id)).toBe(sessionId)

    // The backend's own record of the abort is kept for the next diagnosis.
    const serverLog = fs.readFileSync(path.join(ctx.directories.dataDir, OPENCODE_SERVER_LOG_FILE), 'utf8')
    expect(serverLog).toMatch(new RegExp(`level=INFO .*message=cancel session\\.id=${sessionId}`))
  }, 40_000)

  test('a continuation aborted on every attempt ends with a notice, not silence', async () => {
    const { thread, sessionId } = await startThread('BACKEND_ABORT_ALWAYS')
    await resumeInterruptedSessions({
      discordClient: ctx.botClient,
      appId: ctx.discord.botUserId,
      consume: () => ({
        resume: [{ threadId: thread.id, sessionId, userId: TEST_USER_ID, username: 'restart-abort-tester' }],
        stale: [],
      }),
    })

    await abortContinuationAttempt({ sessionId, attempt: 1 })
    await abortContinuationAttempt({ sessionId, attempt: 2 })

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: "couldn't resume this run",
      timeout: 15_000,
    })
    // Bounded: no third attempt follows the notice.
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    const text = await ctx.discord.thread(thread.id).text()
    expect(text).not.toContain('abort-probe-resumed')
    expect(text.split("couldn't resume this run").length - 1).toBe(1)
  }, 50_000)
})
