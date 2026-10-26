import { describe, test, expect } from 'vitest'
import { findPi } from './agent-backend/pi/find-pi.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'

const channelId = '200000000000001190'

// A turn that reports a nearly full context (fake model window: 100k) makes Pi
// auto-compact before the run settles. The thread must say so: a long silent
// compaction looks like a dead session.
describe.skipIf(!findPi())('auto-compaction notice', () => {
  const ctx = setupQueueAdvancedSuite({ channelId, channelName: 'compaction-notice', dirName: 'compaction-notice', username: 'compaction-agent',
    extraMatchers: [{
      // Older history Pi can summarize: about 30k estimated tokens, above keepRecentTokens.
      id: 'big-turn', priority: 180,
      when: { latestUserTextIncludes: 'BIG_TURN_MARKER', lastMessageRole: 'user' },
      then: { parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'big' },
        { type: 'text-delta', id: 'big', delta: `${'lorem ipsum '.repeat(10000)}big-done` },
        { type: 'text-end', id: 'big' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
      ] },
    }, {
      id: 'fill-context', priority: 180,
      when: { latestUserTextIncludes: 'FILL_CONTEXT_MARKER', lastMessageRole: 'user' },
      then: { parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'fill' },
        { type: 'text-delta', id: 'fill', delta: 'context-filled' },
        { type: 'text-end', id: 'fill' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 95000, outputTokens: 1, totalTokens: 95001 } },
      ] },
    }],
  })

  test('the thread shows that Pi is compacting context', async () => {
    const existing = new Set((await ctx.discord.channel(channelId).getThreads()).map(t => t.id))
    await ctx.discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'BIG_TURN_MARKER' })
    const thread = await ctx.discord.channel(channelId).waitForThread({ timeout: 4000, predicate: t => !existing.has(t.id) })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 15000 })
    await ctx.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'FILL_CONTEXT_MARKER' })
    await waitForBotMessageContaining({ discord: ctx.discord, threadId: thread.id, text: 'compacting context (threshold)', timeout: 15000 })
    expect(await ctx.discord.thread(thread.id).text()).toContain('context-filled')
  }, 40000)
})
