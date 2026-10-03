// E2e: /fork branches the session into a new thread with its own session.
// Without a prompt the fork waits for the user; `from:` forks from before an
// earlier user message, so the fork's history ends where that message began.

import { describe, test, expect } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { waitForFooterMessage } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001074'

describe('/fork', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-fork-e2e',
    dirName: 'qa-fork-e2e',
    username: 'fork-tester',
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
      predicate: (t) => !existing.has(t.id) && (t.name?.startsWith('Fork: ') ?? false),
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
})
