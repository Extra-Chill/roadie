// E2e tests for ThreadSessionRuntime lifecycle behaviors, on Pi with the
// scripted fake model server. Tests scenarios not covered by the queue tests:
// 1. Sequential completions: listener stays alive across multiple full run cycles
// 2. Concurrent first messages: runtime serialization without threadMessageQueue
// 3. A backend restart under a live runtime
//
// Poll timeouts: 4s max, 100ms interval.

import { describe, test, expect } from 'vitest'
import { ChannelType } from 'discord.js'
import { getRuntime } from './session-handler/thread-session-runtime.js'
import {
  createScheduledTask,
  getChannelDirectory,
  getScheduledTask,
  getSessionSleep,
  getThreadSession,
  insertThreadQueueItem,
  listThreadQueueItems,
  setChannelDirectory,
  upsertSessionSleep,
} from './database.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import type { FakeMatcher } from './agent-backend/pi/fake-model-server.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import {
  isFooterMessage,
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000000889'

// 15k of the fake model's 100k context window: past the 10% notice threshold.
const highUsageReplyMatcher: FakeMatcher = {
  id: 'high-usage-reply',
  priority: 20,
  when: {
    lastMessageRole: 'user',
    rawPromptIncludes: 'Reply with exactly: footer-high-usage',
  },
  then: {
    parts: [
      { type: 'text-delta', id: 'high-usage-reply', delta: 'ok' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 15_000, outputTokens: 1, totalTokens: 15_001 },
      },
    ],
    partDelaysMs: [100, 0],
  },
}

// A two-step run: the first step (a tool call) already reports 15% usage,
// so the context notice is due before the run ends.
const highUsageToolMatchers: FakeMatcher[] = [
  {
    id: 'high-usage-tool-step',
    priority: 30,
    when: { lastMessageRole: 'user', latestUserTextIncludes: 'CONTEXT_NOTICE_PROBE' },
    then: {
      parts: [
        { type: 'text-delta', id: 'notice-step', delta: 'checking' },
        { type: 'tool-call', toolCallId: 'notice-step-bash', toolName: 'bash', input: JSON.stringify({ command: 'true' }) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 15_000, outputTokens: 1, totalTokens: 15_001 } },
      ],
    },
  },
  {
    id: 'high-usage-final-step',
    // Above the shared 'tool done' follow-up.
    priority: 60,
    when: { lastMessageRole: 'tool', latestUserTextIncludes: 'CONTEXT_NOTICE_PROBE' },
    then: {
      parts: [
        { type: 'text-delta', id: 'notice-final', delta: 'notice-probe-done' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 15_100, outputTokens: 1, totalTokens: 15_101 } },
      ],
      partDelaysMs: [300, 0],
    },
  },
]

describe.skipIf(!findPi())('runtime lifecycle', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'lifecycle-e2e',
    dirName: 'runtime-lifecycle-e2e',
    username: 'lifecycle-tester',
    extraMatchers: [highUsageReplyMatcher, ...highUsageToolMatchers],
  })

  test(
    'two sequential completions reuse same runtime and listener',
    async () => {
      // Sends A, waits for full completion (footer), then sends B and waits
      // for its footer. Proves the listener stays alive across full run cycles
      // without any interrupt/queue involvement.
      // This is the "calm" path — no abort, no queue, just sequential use.

      // 1. Send first message → thread created, session established
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: seq-alpha',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: seq-alpha'
        },
      })

      const th = ctx.discord.thread(thread.id)

      // Wait for footer (italic project info line) — proves run A completed
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      // Capture runtime identity — should not change across runs
      const runtimeAfterA = getRuntime(thread.id)
      expect(runtimeAfterA).toBeDefined()

      // 2. Send B after A fully completed
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: seq-beta',
      })

      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'seq-beta',
        timeout: 4_000,
      })

      // Wait for B's footer
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        afterUserMessageIncludes: 'seq-beta',
        timeout: 4_000,
      })

      // Same runtime instance — listener was not recreated
      const runtimeAfterB = getRuntime(thread.id)
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (lifecycle-tester)
        Reply with exactly: seq-alpha
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        --- from: user (lifecycle-tester)
        Reply with exactly: seq-beta
        --- from: assistant (TestBot)
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
      expect(runtimeAfterB).toBe(runtimeAfterA)
    },
    15_000,
  )

  test(
    'footer includes context percentage and model id',
    async () => {
      const prompt = 'Reply with exactly: footer-check'
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === prompt
        },
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '%',
        timeout: 4_000,
      })

      const messages = await ctx.discord.thread(thread.id).getMessages()

      const footerMessage = messages.find((message) => {
        if (!isFooterMessage({ message, botUserId: ctx.discord.botUserId })) {
          return false
        }
        return message.content.includes('fake-1') && message.content.includes('%')
      })

      expect(await ctx.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (lifecycle-tester)
        Reply with exactly: footer-check
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
      expect(footerMessage).toBeDefined()
      if (!footerMessage) {
        throw new Error('Expected footer message to be present')
      }
      expect(footerMessage.content).toContain('fake-1')
      expect(footerMessage.content).toMatch(/\d+%/)
    },
    10_000,
  )

  test(
    'existing runtime keeps working after the Pi backend restarts',
    async () => {
      const prompt = 'Reply with exactly: reconnect-alpha'
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === prompt
        },
      })

      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      const runtimeBeforeRestart = getRuntime(thread.id)
      expect(runtimeBeforeRestart).toBeDefined()
      const sessionBeforeRestart = await getThreadSession(thread.id)
      const piBeforeRestart = ctx.pi

      // Every Pi process is killed and a fresh backend takes over; the
      // session resumes from its file on the next prompt.
      await ctx.restartPi!()

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: reconnect-beta',
      })

      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'reconnect-beta',
        timeout: 4_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        afterUserMessageIncludes: 'reconnect-beta',
        timeout: 4_000,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (lifecycle-tester)
        Reply with exactly: reconnect-alpha
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        --- from: user (lifecycle-tester)
        Reply with exactly: reconnect-beta
        --- from: assistant (TestBot)
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)

      const runtimeAfterRestart = getRuntime(thread.id)
      expect(runtimeAfterRestart).toBe(runtimeBeforeRestart)
      // The fresh backend served the same session, with its history.
      expect(ctx.pi).not.toBe(piBeforeRestart)
      expect(ctx.pi!.owns(sessionBeforeRestart!)).toBe(true)
      expect(await getThreadSession(thread.id)).toBe(sessionBeforeRestart)
      const beta = ctx.modelServer!.log.findLast((request) => JSON.stringify(request.messages).includes('reconnect-beta'))
      expect(JSON.stringify(beta?.messages)).toContain('reconnect-alpha')
    },
    15_000,
  )

  test(
    'does not print a context-usage notice for the final text part right before the footer',
    async () => {
      const prompt = 'Reply with exactly: footer-high-usage'
      const existingThreadIds = new Set(
        (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => {
          return thread.id
        }),
      )
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 6_000,
        predicate: (t) => {
          return !existingThreadIds.has(t.id)
        },
      })

      // The footer ends the run, so every notice it could have had is posted.
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 6_000,
      })

      expect(await ctx.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (lifecycle-tester)
        Reply with exactly: footer-high-usage
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)

      const threadText = await ctx.discord.thread(thread.id).text()
      expect(threadText).not.toContain('-# context usage')
    },
    10_000,
  )

  test(
    'two near-simultaneous messages to same thread serialize correctly',
    async () => {
      // Sends A to create a thread, then fires B and C simultaneously into
      // the thread (no await between them). Without the old threadMessageQueue,
      // the runtime's dispatchAction must serialize these. Both should get
      // responses and the thread should not deadlock or create duplicate sessions.

      // 1. Establish thread + session
      const existingThreadIds = new Set(
        (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => {
          return thread.id
        }),
      )
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: concurrent-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 6_000,
        predicate: (t) => {
          return !existingThreadIds.has(t.id)
        },
      })

      const th = ctx.discord.thread(thread.id)
      const setupReply = await th.waitForBotReply({ timeout: 6_000 })
      expect(setupReply.content.trim().length).toBeGreaterThan(0)

      // Wait for setup footer so the run is fully idle
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 6_000,
      })

      // Snapshot bot message count before sending concurrent messages
      const beforeMessages = await th.getMessages()
      const beforeBotCount = beforeMessages.filter((m) => {
        return m.author.id === ctx.discord.botUserId
      }).length

      // 2. Fire B and C simultaneously — no await between sends
      const sendB = th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: concurrent-bravo',
      })
      const sendC = th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: concurrent-charlie',
      })
      await Promise.all([sendB, sendC])

      // 3. Both should eventually get bot replies — the runtime serializes them
      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'concurrent-bravo',
        timeout: 4_000,
      })

      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'concurrent-charlie',
        timeout: 4_000,
      })

      // 4. Verify both user messages arrived and the thread didn't deadlock.
      //    With explicit abort flows, bravo can be aborted by charlie before
      //    producing a reply, so we can't assert +2 bot messages. What we
      //    CAN verify: both user messages exist, charlie (the last one) has
      //    a bot reply after it, and the replies are distinct messages.
      //    No inline snapshot here — the concurrent abort race makes message
      //    ordering nondeterministic (bravo may or may not get a reply).
      const messages = await th.getMessages()

      const bravoIndex = messages.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('concurrent-bravo')
        )
      })
      const charlieIndex = messages.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('concurrent-charlie')
        )
      })
      expect(bravoIndex).toBeGreaterThan(-1)
      expect(charlieIndex).toBeGreaterThan(-1)
      expect(bravoIndex).toBeLessThan(charlieIndex)

      // Charlie (the last queued message) must have a bot reply after it.
      const charlieReplyIndex = messages.findIndex((m, i) => {
        return i > charlieIndex && m.author.id === ctx.discord.botUserId
      })
      expect(charlieReplyIndex).toBeGreaterThan(-1)

      // At least 1 new bot message appeared (charlie's reply). If bravo
      // wasn't aborted, there will be 2. Either way, no deadlock.
      const afterBotCount = messages.filter((m) => {
        return m.author.id === ctx.discord.botUserId
      }).length
      expect(afterBotCount).toBeGreaterThanOrEqual(beforeBotCount + 1)
    },
    15_000,
  )

  test('deleting a project channel clears its active Discord work', async () => {
    const guild = ctx.botClient.guilds.cache.first()
    if (!guild) throw new Error('Expected test guild')
    const projectChannel = await guild.channels.create({
      name: 'deleted-project',
      type: ChannelType.GuildText,
    })
    await setChannelDirectory({
      channelId: projectChannel.id,
      directory: ctx.directories.projectDirectory,
      channelType: 'text',
      guildId: guild.id,
    })
    await ctx.discord.channel(projectChannel.id).user(TEST_USER_ID).sendMessage({
      content: 'Reply with exactly: deleted-project',
    })
    const thread = await ctx.discord.channel(projectChannel.id).waitForThread({
      timeout: 4_000,
      predicate: (candidate) => candidate.name === 'Reply with exactly: deleted-project',
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: '*project',
      timeout: 4_000,
    })
    const sessionId = await getThreadSession(thread.id)
    if (!sessionId) throw new Error('Expected thread session')
    await insertThreadQueueItem({
      queueId: 'deleted-project-queue',
      threadId: thread.id,
      payloadJson: JSON.stringify({ prompt: 'queued' }),
    })
    await upsertSessionSleep({
      sessionId,
      wakeAt: new Date('2099-01-01T00:00:00.000Z'),
      reason: 'later',
    })
    const channelTaskId = await createScheduledTask({
      scheduleKind: 'at',
      nextRunAt: new Date('2099-01-01T00:00:00.000Z'),
      payloadJson: JSON.stringify({
        kind: 'channel',
        channelId: projectChannel.id,
        prompt: 'later',
      }),
      promptPreview: 'later',
      channelId: projectChannel.id,
    })

    expect(await ctx.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
      "--- from: user (lifecycle-tester)
      Reply with exactly: deleted-project
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      ok
      -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
    `)
    await projectChannel.delete()

    for (let attempt = 0; attempt < 40; attempt++) {
      if (!getRuntime(thread.id) && !await getChannelDirectory(projectChannel.id)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    expect({
      mapping: await getChannelDirectory(projectChannel.id),
      queue: await listThreadQueueItems(thread.id),
      runtime: getRuntime(thread.id),
      sleep: await getSessionSleep({ sessionId }),
      task: await getScheduledTask(channelTaskId),
    }).toMatchObject({
      mapping: undefined,
      queue: [],
      runtime: undefined,
      sleep: { status: 'cancelled' },
      task: {
        status: 'cancelled',
        last_error: 'Discord channel was deleted',
      },
    })
  }, 15_000)

  test('prints a context-usage notice when usage crosses 10% mid-run', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'CONTEXT_NOTICE_PROBE use some context',
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => t.name?.includes('CONTEXT_NOTICE_PROBE') ?? false,
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: '*project',
      afterUserMessageIncludes: 'CONTEXT_NOTICE_PROBE',
      timeout: 6_000,
    })
    expect(await ctx.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
      "--- from: user (lifecycle-tester)
      CONTEXT_NOTICE_PROBE use some context
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      > checking
      -# context usage 15%

      -# ┣ bash _true_

      notice-probe-done
      -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
    `)
  }, 10_000)
})
