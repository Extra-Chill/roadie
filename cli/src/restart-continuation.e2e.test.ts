// E2e: a run interrupted by a restart gets a continuation turn on startup.
// The deterministic provider only answers "continuation-seen" to the
// continuation prompt, so that reply proves the resumed turn reached the model
// in the same thread and session.

import { describe, test, expect } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { resumeInterruptedSessions } from './session-handler/thread-session-runtime.js'
import { getThreadSession } from './database.js'
import { waitForBotMessageContaining } from './test-utils.js'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'

const TEXT_CHANNEL_ID = '200000000000001060'

function reply(id: string, text: string): DeterministicMatcher['then']['parts'] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ]
}

describe('restart continuation', () => {
  let resumedThreadId = ''
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-restart-continuation-e2e',
    dirName: 'qa-restart-continuation-e2e',
    username: 'restart-tester',
    extraMatchers: [
      {
        id: 'restart-first-turn',
        priority: 120,
        when: { latestUserTextIncludes: 'RESTART_PROBE' },
        then: { parts: reply('first', 'first-turn-done') },
      },
      {
        id: 'restart-continuation',
        priority: 130,
        when: { latestUserTextIncludes: 'Roadie restarted while you were working' },
        then: { parts: reply('cont', 'continuation-seen') },
      },
    ],
  })

  test('an interrupted session resumes in its thread', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'RESTART_PROBE start some work',
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => t.name?.includes('RESTART_PROBE') ?? false,
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'first-turn-done',
      timeout: 8_000,
    })
    const sessionId = await getThreadSession(thread.id)
    expect(sessionId).toBeTruthy()

    const result = await resumeInterruptedSessions({
      discordClient: ctx.botClient,
      appId: ctx.discord.botUserId,
      consume: () => ({
        resume: [{ threadId: thread.id, sessionId: sessionId!, userId: TEST_USER_ID, username: 'restart-tester' }],
        stale: [],
      }),
    })
    expect(result.resumed).toEqual([thread.id])

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'continuation-seen',
      timeout: 8_000,
    })
    const text = await ctx.discord.thread(thread.id).text()
    expect(text).toContain('Roadie restarted while this session was running. Resuming.')
    expect(await getThreadSession(thread.id)).toBe(sessionId)
    resumedThreadId = thread.id
  }, 25_000)

  test('a stale record only posts a notice', async () => {
    expect(resumedThreadId).toBeTruthy()
    const thread = { id: resumedThreadId }
    const result = await resumeInterruptedSessions({
      discordClient: ctx.botClient,
      appId: ctx.discord.botUserId,
      consume: () => ({ resume: [], stale: [{ threadId: thread.id, sessionId: 'old' }] }),
    })
    expect(result).toEqual({ resumed: [], notified: [thread.id] })
    expect(await ctx.discord.thread(thread.id).text()).toContain('too long ago to resume automatically')
  }, 15_000)
})
