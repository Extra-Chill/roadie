// Exercises durable scheduled delivery through Discord multipart uploads and
// attachment ingestion into the actual deterministic agent runtime.
import { afterEach, describe, expect, test } from 'vitest'
import { Routes } from 'discord.js'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { createScheduledTask, getScheduledTask } from './database.js'
import { runScheduledTaskNow } from './task-runner.js'
import { store } from './store.js'
import { appendTaskCommandOutput } from './task-schedule.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'

const CHANNEL_ID = '200000000000001079'
const prompt = 'SCHEDULED_FULL_PROMPT\n' + 'complete 漢字 instructions\n'.repeat(150)
const stdout = 'pre-run café '.repeat(500) + 'STDOUT_END'
const fullPrompt = appendTaskCommandOutput({ prompt, stdout })
const completeMatcher: DeterministicMatcher = {
  id: 'scheduled-complete-prompt',
  priority: 150,
  when: { lastMessageRole: 'user', latestUserTextIncludes: fullPrompt },
  then: {
    parts: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'scheduled-complete' },
      { type: 'text-delta', id: 'scheduled-complete', delta: 'scheduled-full-prompt-received' },
      { type: 'text-end', id: 'scheduled-complete' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ],
  },
}

describe('oversized scheduled prompts', () => {
  const originalBaseUrl = store.getState().discordBaseUrl
  afterEach(() => store.setState({ discordBaseUrl: originalBaseUrl }))
  const ctx = setupQueueAdvancedSuite({
    channelId: CHANNEL_ID,
    channelName: 'scheduled-prompt-e2e',
    dirName: 'scheduled-prompt-e2e',
    username: 'schedule-tester',
    extraMatchers: [completeMatcher],
  })

  test.each(['thread', 'channel'] as const)(
    'preserves the full %s prompt and pre-run stdout',
    async (kind) => {
      await ctx.discord
        .channel(CHANNEL_ID)
        .user(TEST_USER_ID)
        .sendMessage({ content: `Reply with exactly: ready-${kind}` })
      const initialThread = await ctx.discord.channel(CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (thread) => thread.name === `Reply with exactly: ready-${kind}`,
      })
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: initialThread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: ctx.discord.botUserId,
      })
      const name = `scheduled-${kind}-attachment`
      const id = await createScheduledTask({
        scheduleKind: 'at',
        runAt: new Date(),
        timezone: 'UTC',
        nextRunAt: new Date(),
        projectDirectory: ctx.directories.projectDirectory,
        promptPreview: name,
        payloadJson: JSON.stringify({
          kind,
          threadId: initialThread.id,
          channelId: CHANNEL_ID,
          name,
          prompt,
          preRunCommand:
            "node -e \"process.stdout.write('pre-run café '.repeat(500) + 'STDOUT_END')\"",
        }),
      })
      const task = await getScheduledTask(id)
      if (!task) throw new Error('Expected scheduled task')
      store.setState({ discordBaseUrl: new URL(ctx.discord.restUrl).origin })
      expect(await runScheduledTaskNow({ token: ctx.discord.botToken, taskId: task.id })).toEqual({
        kind: 'success',
      })
      const thread =
        kind === 'thread'
          ? initialThread
          : await ctx.discord.channel(CHANNEL_ID).waitForThread({
              timeout: 4_000,
              predicate: (candidate) => candidate.name === name,
            })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
        text: 'scheduled-full-prompt-received',
      })
      const messages = await ctx.discord
        .channel(kind === 'thread' ? thread.id : CHANNEL_ID)
        .getMessages()
      const uploaded = messages.find((message) =>
        message.attachments.some((attachment) => attachment.filename === 'prompt.md'),
      )
      if (!uploaded) throw new Error('Expected scheduled prompt attachment')
      expect(uploaded.content.length).toBeLessThanOrEqual(2000)
      expect(uploaded.embeds[0]?.footer?.text).toContain('scheduledKind: at')
      const attachment = uploaded.attachments[0]
      if (!attachment) throw new Error('Expected prompt.md')
      const file = await fetch(attachment.url)
      expect(file.ok).toBe(true)
      expect(await file.text()).toBe(
        kind === 'thread' ? `» **roadie-cli:**\n${fullPrompt}` : fullPrompt,
      )
    },
    25_000,
  )

  test('the Discord twin rejects content that would fail on Discord', async () => {
    await expect(
      ctx.botClient.rest.post(Routes.channelMessages(CHANNEL_ID), {
        body: { content: 'x'.repeat(2001) },
      }),
    ).rejects.toMatchObject({ code: 50035 })
  })
})
