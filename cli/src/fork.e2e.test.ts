// E2e: /fork branches the session into a new thread with its own session.
// Without a prompt the fork waits for the user; `from:` forks from before an
// earlier user message, so the fork's history ends where that message began.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { waitForFooterMessage } from './test-utils.js'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { addFilter } from './hooks.js'
import { getThreadWorkingDirectory } from './database.js'
import { disposeRuntime } from './session-handler/thread-session-runtime.js'
const exec = promisify(execFile)

const TEXT_CHANNEL_ID = '200000000000001074'

describe('/fork', () => {
  const previousWorkspaceFlag = process.env.OPENCODE_EXPERIMENTAL_WORKSPACES
  beforeAll(() => { process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = 'true' })
  afterAll(() => {
    if (previousWorkspaceFlag === undefined) delete process.env.OPENCODE_EXPERIMENTAL_WORKSPACES
    else process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = previousWorkspaceFlag
  })
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-fork-e2e',
    dirName: 'qa-fork-e2e',
    username: 'fork-tester',
    extraMatchers: [
      { id: 'workspace-write', priority: 140, when: { latestUserTextIncludes: 'WORKSPACE_WRITE_MARKER', lastMessageRole: 'user' }, then: {
        parts: [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'workspace-write-call', toolName: 'bash', input: JSON.stringify({ command: 'printf isolated > fork-result.txt', description: 'Write only in fork workspace', hasSideEffect: true }) }, { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      } },
      { id: 'workspace-write-complete', priority: 141, when: { latestUserTextIncludes: 'WORKSPACE_WRITE_MARKER', lastMessageRole: 'tool' }, then: {
        parts: [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'done' }, { type: 'text-delta', id: 'done', delta: 'workspace-write-complete' }, { type: 'text-end', id: 'done' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      } },
    ],
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

  test('separate forks execute in real isolated worktrees, including workspace-bound sources and reconstruction', async () => {
    const directory = ctx.directories.projectDirectory
    await exec('git', ['add', 'opencode.json'], { cwd: directory })
    const unchanged = await exec('git', ['diff', '--cached', '--quiet'], { cwd: directory }).then(() => true, () => false)
    if (!unchanged) await exec('git', ['commit', '-m', 'Commit deterministic runtime fixture'], { cwd: directory })
    fs.writeFileSync(path.join(directory, 'source-dirty.txt'), 'keep source edits')
    fs.writeFileSync(path.join(directory, 'fork-result.txt'), 'source must stay unchanged')
    const source = await startSource()
    const allocations: string[] = []
    const forkThreads: string[] = []
    const remove = addFilter('fork_workspace', () => ({ defaultMode: 'separate' as const, async provision(request) {
      const workingDirectory = path.join(ctx.directories.root, `fork-${request.requestId}`)
      const branch = `fork-${request.requestId}`
      await exec('git', ['worktree', 'add', '-b', branch, workingDirectory, 'HEAD'], { cwd: directory })
      allocations.push(workingDirectory)
      return { workingDirectory, projectDirectory: directory, label: branch, kind: 'git-worktree' as const, workspaceId: branch, baseRef: (await exec('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim() }
    } }))
    try {
      for (let i = 0; i < 2; i++) {
        const fork = await forkFrom(source.id, [{ name: 'prompt', type: 3, value: `WORKSPACE_WRITE_MARKER ${i}` }])
        forkThreads.push(fork.id)
        await waitForThreadSession(fork.id)
        await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 10_000 })
        const binding = await getThreadWorkingDirectory(fork.id)
        expect(binding?.workingDirectory).toBe(allocations[i])
        expect(binding?.kind).toBe('git-worktree')
        expect(fs.readFileSync(path.join(allocations[i]!, 'fork-result.txt'), 'utf8')).toBe('isolated')
        expect(fs.existsSync(path.join(allocations[i]!, 'source-dirty.txt'))).toBe(false)
        expect(fs.readFileSync(path.join(directory, 'fork-result.txt'), 'utf8')).toBe('source must stay unchanged')
        const visible = await ctx.discord.thread(fork.id).text()
        expect(visible).toContain('Uncommitted edits from the source checkout are not copied.')
        expect(visible).toContain('workspace-write-complete')
        disposeRuntime(fork.id)
        await ctx.discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: reconstructed fork' })
        await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000, afterMessageIncludes: 'reconstructed fork' })
        expect((await getThreadWorkingDirectory(fork.id))?.workingDirectory).toBe(allocations[i])
      }
      expect(allocations[0]).not.toBe(allocations[1])
      // Forking an already-warped session must move only its new copy.
      fs.writeFileSync(path.join(allocations[0]!, 'fork-result.txt'), 'keep existing fork')
      fs.writeFileSync(path.join(allocations[0]!, 'fork-local-only.txt'), 'keep fork edits')
      const nested = await forkFrom(forkThreads[0]!, [{ name: 'prompt', type: 3, value: 'WORKSPACE_WRITE_MARKER nested' }])
      await waitForThreadSession(nested.id)
      await waitForFooterMessage({ discord: ctx.discord, threadId: nested.id, timeout: 10_000 })
      expect((await getThreadWorkingDirectory(nested.id))?.workingDirectory).toBe(allocations[2])
      expect(fs.readFileSync(path.join(allocations[2]!, 'fork-result.txt'), 'utf8')).toBe('isolated')
      expect(fs.existsSync(path.join(allocations[2]!, 'fork-local-only.txt'))).toBe(false)
      expect(fs.readFileSync(path.join(allocations[0]!, 'fork-result.txt'), 'utf8')).toBe('keep existing fork')
      expect(fs.readFileSync(path.join(directory, 'fork-result.txt'), 'utf8')).toBe('source must stay unchanged')
      expect(new Set(allocations).size).toBe(3)
      const count = allocations.length
      const sharedNested = await forkFrom(nested.id, [{ name: 'workspace', type: 3, value: 'shared' }, { name: 'prompt', type: 3, value: 'WORKSPACE_WRITE_MARKER shared nested' }])
      await waitForThreadSession(sharedNested.id)
      await waitForFooterMessage({ discord: ctx.discord, threadId: sharedNested.id, timeout: 10_000 })
      expect((await getThreadWorkingDirectory(sharedNested.id))?.workingDirectory).toBe(allocations[2])
      expect(allocations).toHaveLength(count)
      const shared = await forkFrom(source.id, [{ name: 'workspace', type: 3, value: 'shared' }])
      await waitForThreadSession(shared.id)
      expect(await getThreadWorkingDirectory(shared.id)).toBeUndefined()
      expect(allocations).toHaveLength(count)
    } finally { remove() }
  }, 60_000)

  test('separate provisioning failure creates no fork thread and runs no prompt', async () => {
    const source = await startSource()
    const beforeFile = fs.existsSync(path.join(ctx.directories.projectDirectory, 'fork-result.txt')) ? fs.readFileSync(path.join(ctx.directories.projectDirectory, 'fork-result.txt'), 'utf8') : null
    const before = await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()
    const remove = addFilter('fork_workspace', () => ({ async provision() { return new Error('fixture allocation failed') } }))
    try {
      const interaction = await ctx.discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({ name: 'fork', options: [{ name: 'workspace', type: 3, value: 'separate' }, { name: 'prompt', type: 3, value: 'WORKSPACE_WRITE_MARKER must not run' }] })
      await ctx.discord.thread(source.id).waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
      expect((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => thread.id)).toEqual(before.map((thread) => thread.id))
      const afterFile = fs.existsSync(path.join(ctx.directories.projectDirectory, 'fork-result.txt')) ? fs.readFileSync(path.join(ctx.directories.projectDirectory, 'fork-result.txt'), 'utf8') : null
      expect(afterFile).toBe(beforeFile)
    } finally { remove() }
  }, 25_000)

  test('an unregistered directory cannot dispatch an isolated fork into the source checkout', async () => {
    const source = await startSource()
    const sourceFile = path.join(ctx.directories.projectDirectory, 'fork-result.txt')
    const beforeFile = fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8') : null
    const existing = new Set((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => thread.id))
    let invoked = false
    const remove = addFilter('fork_workspace', () => ({ async provision(request) {
      invoked = true
      const workingDirectory = path.join(ctx.directories.root, `unsupported-${request.requestId}`)
      fs.mkdirSync(workingDirectory, { recursive: true })
      return { workingDirectory, projectDirectory: ctx.directories.projectDirectory, label: 'unsupported', kind: 'directory' as const }
    } }))
    try {
      const result = await ctx.discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({ name: 'fork', options: [{ name: 'workspace', type: 3, value: 'separate' }, { name: 'prompt', type: 3, value: 'WORKSPACE_WRITE_MARKER source must not run' }] })
      await ctx.discord.thread(source.id).waitForInteractionAck({ interactionId: result.id, timeout: 4_000 })
      // Wait for the handler's terminal error edit, not merely deferReply.
      const deadline = Date.now() + 8_000
      let settled = false
      while (Date.now() < deadline) {
        const threads = await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()
        if (invoked && threads.every((thread) => existing.has(thread.id))) {
          await new Promise((resolve) => setTimeout(resolve, 200))
          settled = (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).every((thread) => existing.has(thread.id))
          if (settled) break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(settled).toBe(true)
      expect((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).every((thread) => existing.has(thread.id))).toBe(true)
      expect(fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8') : null).toBe(beforeFile)
    } finally { remove() }
  }, 25_000)
})
