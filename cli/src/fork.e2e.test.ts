// E2e: /fork branches the session into a new thread with its own session.
// Without a prompt the fork waits for the user; `from:` forks from before an
// earlier user message, so the fork's history ends where that message began.

import { describe, test, expect } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { waitForFooterMessage } from './test-utils.js'
import { disposeRuntime } from './session-handler/thread-session-runtime.js'
import { TITLE_REQUEST_SYSTEM } from './title-request.js'

const TEXT_CHANNEL_ID = '200000000000001074'

describe('/fork', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-fork-e2e',
    dirName: 'qa-fork-e2e',
    username: 'fork-tester',
    extraMatchers: [
      ['fork-cache-investigation', 'Cache Investigation'],
      ['fork-permission-review', 'Permission Review'],
      ['fork-deferred-task', 'Deferred Fork Task'],
    ].map(([marker, title]) => ({
      id: `generated-title-${marker}`, priority: 200,
      when: { latestUserTextIncludes: marker, rawPromptIncludes: TITLE_REQUEST_SYSTEM, maxOutputTokens: 96, toolsEmpty: true,
        // The model responds only when the request has neither the parent
        // conversation nor Roadie's full coding-system instructions.
        rawPromptRegex: '^(?!.*fork-first)(?!.*The user is reading your messages)(?!.*Forked from)(?!.*current git branch)(?!.*working directory)',
      },
      then: { parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'title' },
        { type: 'text-delta', id: 'title', delta: title! },
        { type: 'text-end', id: 'title' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 } },
      ] },
    })),
  })

  async function startSource(): Promise<{ id: string }> {
    const existing = new Set((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((t) => t.id))
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'Reply with exactly: fork-first',
    })
    const source = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => !existing.has(t.id),
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: source.id, timeout: 8_000 })
    return source
  }

  async function forkFrom(sourceId: string, options: Array<{ name: string; type: number; value: string }> = []) {
    const existing = new Set((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((t) => t.id))
    const { id: interactionId } = await ctx.discord.thread(sourceId).user(TEST_USER_ID).runSlashCommand({
      name: 'fork',
      options,
    })
    await ctx.discord.thread(sourceId).waitForInteractionAck({ interactionId, timeout: 4_000 })
    return ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 6_000,
      predicate: (t) => !existing.has(t.id),
    })
  }

  // The fork thread appears before its session mapping is written.
  async function waitForThreadSession(threadId: string): Promise<string> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const sessionId = await getThreadSession(threadId)
      if (sessionId) return sessionId
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`No session bound to fork thread ${threadId}`)
  }

  async function sessionMessages(sessionId: string) {
    const getClient = await initializeOpencodeForDirectory(ctx.directories.projectDirectory)
    if (getClient instanceof Error) throw getClient
    const response = await getClient().session.messages({
      sessionID: sessionId,
      directory: ctx.directories.projectDirectory,
    })
    return response.data ?? []
  }

  test('without a prompt the fork gets its own session and waits', async () => {
    const source = await startSource()
    const fork = await forkFrom(source.id)

    const [sourceSession, forkSession] = await Promise.all([
      getThreadSession(source.id),
      waitForThreadSession(fork.id),
    ])
    expect(forkSession).toBeTruthy()
    expect(forkSession).not.toBe(sourceSession)
    expect(fork.name).toContain('Fork: ')

    await ctx.discord.thread(fork.id).waitForMessage({ timeout: 4_000, predicate: (m) => m.content.includes('Forked from') })
    const forkText = (await ctx.discord.thread(fork.id).text()).replace(`<#${source.id}>`, '<#SOURCE_THREAD>')
    expect(forkText).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      Forked from <#SOURCE_THREAD>. Continue the conversation here."
    `)
    // The fork carries the source conversation.
    const messages = await sessionMessages(forkSession)
    expect(messages.some((m) => m.info.role === 'assistant')).toBe(true)
  }, 25_000)

  test('from: forks from before an earlier user message', async () => {
    const source = await startSource()
    await ctx.discord.thread(source.id).user(TEST_USER_ID).sendMessage({
      content: 'Reply with exactly: fork-second',
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: source.id,
      timeout: 8_000,
      afterMessageIncludes: 'fork-second',
    })

    const sourceSession = await getThreadSession(source.id)
    const sourceMessages = await sessionMessages(sourceSession!)
    const userMessages = sourceMessages.filter((m) => m.info.role === 'user')
    expect(userMessages.length).toBeGreaterThanOrEqual(2)
    const second = userMessages[userMessages.length - 1]!

    const fork = await forkFrom(source.id, [{ name: 'from', type: 3, value: second.info.id }])
    const forkMessages = await sessionMessages(await waitForThreadSession(fork.id))
    const forkUserCount = forkMessages.filter((m) => m.info.role === 'user').length
    expect(forkUserCount).toBe(userMessages.length - 1)
  }, 30_000)

  test('small-model titles use only the new prompt, without replay or title turns in the fork', async () => {
    const source = await startSource()
    const getClient = await initializeOpencodeForDirectory(ctx.directories.projectDirectory)
    if (getClient instanceof Error) throw getClient
    const directory = ctx.directories.projectDirectory
    const before = await getClient().session.list({ directory })
    const prompts = ['Reply with exactly: fork-cache-investigation', 'Reply with exactly: fork-permission-review']
    const titles: string[] = []
    const expected = ['Cache Investigation', 'Permission Review']
    for (const [index, prompt] of prompts.entries()) {
      const fork = await forkFrom(source.id, [{ name: 'prompt', type: 3, value: prompt }])
      const sessionId = await waitForThreadSession(fork.id)
      await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000 })
      const session = await getClient().session.get({ sessionID: sessionId, directory })
      expect(session.data?.title).toBe(expected[index])
      const deadline = Date.now() + 4_000
      let title = ''
      while (Date.now() < deadline) {
        title = (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((thread) => thread.id === fork.id)?.name ?? ''
        if (title === expected[index]) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      titles.push(title)
      const sourceHistory = await sessionMessages((await getThreadSession(source.id))!)
      const history = await sessionMessages(sessionId)
      expect(history.filter((entry) => entry.info.role === 'user')).toHaveLength(sourceHistory.filter((entry) => entry.info.role === 'user').length + 1)
      expect(history.filter((entry) => entry.info.role === 'assistant')).toHaveLength(sourceHistory.filter((entry) => entry.info.role === 'assistant').length + 1)
      expect((await ctx.discord.thread(fork.id).text()).replace(`<#${source.id}>`, '<#SOURCE_THREAD>')).toContain(`Forked from <#SOURCE_THREAD>.\n${prompt}`)
    }
    expect(titles).toMatchInlineSnapshot(`
      [
        "Cache Investigation",
        "Permission Review",
      ]
    `)
    const after = await getClient().session.list({ directory })
    expect((after.data?.length ?? 0) - (before.data?.length ?? 0)).toBe(2)
    expect((await getClient().session.get({ sessionID: (await getThreadSession(source.id))!, directory })).data?.title).not.toBe(prompts[0])
  }, 30_000)

  test('a promptless fork takes its first message title after runtime reconstruction and keeps it on later turns', async () => {
    const source = await startSource()
    const fork = await forkFrom(source.id)
    const sessionId = await waitForThreadSession(fork.id)
    // The durable marker outlives the runtime that created the fork.
    disposeRuntime(fork.id)
    const prompt = 'Reply with exactly: fork-deferred-task'
    await ctx.discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: prompt })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000 })
    const getClient = await initializeOpencodeForDirectory(ctx.directories.projectDirectory)
    if (getClient instanceof Error) throw getClient
    const directory = ctx.directories.projectDirectory
    expect((await getClient().session.get({ sessionID: sessionId, directory })).data?.title).toBe('Deferred Fork Task')
    await ctx.discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: fork-later-turn' })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000, afterMessageIncludes: 'fork-later-turn' })
    expect((await getClient().session.get({ sessionID: sessionId, directory })).data?.title).toBe('Deferred Fork Task')
    expect((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((thread) => thread.id === fork.id)?.name).toMatchInlineSnapshot(`"Deferred Fork Task"`)
    expect(await getThreadSession(fork.id)).toBe(sessionId)
  }, 30_000)

  test('a user-chosen fork title is preserved before the first task message', async () => {
    const source = await startSource()
    const fork = await forkFrom(source.id)
    const sessionId = await waitForThreadSession(fork.id)
    const getClient = await initializeOpencodeForDirectory(ctx.directories.projectDirectory)
    if (getClient instanceof Error) throw getClient
    const directory = ctx.directories.projectDirectory
    const updated = await getClient().session.update({ sessionID: sessionId, directory, title: 'User chosen branch' })
    if (updated.error) throw new Error('Could not set explicit fork title')
    await ctx.discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: keep-custom-fork-title' })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000 })
    expect((await getClient().session.get({ sessionID: sessionId, directory })).data?.title).toBe('User chosen branch')
    expect((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((thread) => thread.id === fork.id)?.name).toMatchInlineSnapshot(`"User chosen branch"`)
  }, 30_000)
})
