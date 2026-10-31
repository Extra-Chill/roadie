// E2e: /fork branches the session into a new thread with its own session.
// Without a prompt the fork waits for the user; `from:` forks from before an
// earlier user message, so the fork's history ends where that message began.

import { describe, test, expect } from 'vitest'
import { ApplicationCommandOptionType, ChannelType } from 'discord.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { getDb, getThreadSession } from './database.js'
import { waitForFooterMessage } from './test-utils.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { addFilter } from './hooks.js'
import { getThreadWorkingDirectory } from './database.js'
import { setChannelDirectory } from './database.js'
import {
  disposeRuntime,
  getRuntime,
  resumeInterruptedSessions,
} from './session-handler/runtime-registry.js'
import { applyPendingSessionTitle } from './session-title.js'
import { getAgentBackendProvider } from './agent-backend/registry.js'
import { clearIdentityCache, type Person } from './identity.js'
const exec = promisify(execFile)
import { TITLE_REQUEST_SYSTEM } from './title-request.js'
import type { FakeMatcher } from './agent-backend/pi/fake-model-server.js'

const TEXT_CHANNEL_ID = '200000000000001074'

describe.skipIf(!findPi())('/fork', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-fork-e2e',
    dirName: 'qa-fork-e2e',
    username: 'fork-tester',
    extraMatchers: [
      { id: 'site-coding-write', priority: 142, when: { latestUserTextIncludes: 'SITE_CODING_WRITE', lastMessageRole: 'user' }, then: {
        parts: [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'site-coding-call', toolName: 'bash', input: JSON.stringify({ command: `cd '${path.resolve(process.cwd(), 'tmp/qa-fork-e2e/project')}' && printf source > site-coding.txt`, description: 'Code in the repository from a site-root conversation', hasSideEffect: true }) }, { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      } },
      { id: 'workspace-write', priority: 140, when: { latestUserTextIncludes: 'WORKSPACE_WRITE_MARKER', lastMessageRole: 'user' }, then: {
        parts: [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'workspace-write-call', toolName: 'bash', input: JSON.stringify({ command: 'printf isolated > fork-result.txt', description: 'Write only in fork workspace', hasSideEffect: true }) }, { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      } },
      { id: 'workspace-write-complete', priority: 141, when: { latestUserTextIncludes: 'WORKSPACE_WRITE_MARKER', lastMessageRole: 'tool' }, then: {
        parts: [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'done' }, { type: 'text-delta', id: 'done', delta: 'workspace-write-complete' }, { type: 'text-end', id: 'done' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      } },
      ...[
      ['fork-cache-investigation', 'Cache Investigation'],
      ['fork-permission-review', 'Permission Review'],
      ['fork-deferred-task', 'Deferred Fork Task'],
      ['new-thread-task', 'New Thread Task'],
       ['fork-title-slow', 'Follow-up Investigation'],
       ].map<FakeMatcher>(([marker, title]) => ({
      id: `generated-title-${marker}`, priority: 200,
      when: { latestUserTextIncludes: marker, rawPromptIncludes: TITLE_REQUEST_SYSTEM, toolsEmpty: true,
        // The model responds only when the request has neither the parent
        // conversation nor Roadie's full coding-system instructions.
        rawPromptRegex: '^(?!.*fork-first)(?!.*The user is reading your messages)(?!.*Forked from)(?!.*current git branch)(?!.*working directory)',
      },
      then: { ...(marker === 'fork-title-slow' ? { partDelaysMs: [0, 0, 0, 4000, 0] } : {}), parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'title' },
        { type: 'text-delta', id: 'title', delta: title! },
        { type: 'text-end', id: 'title' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 } },
      ] },
      })),
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

  const backendSessions = () => ctx.pi!.getBackend().sessions

  async function sessionMessages(sessionId: string) {
    const messages = await backendSessions().messages({ sessionId, directory: ctx.directories.projectDirectory })
    if (messages instanceof Error) throw messages
    return messages
  }

  async function sessionTitle(sessionId: string): Promise<string | undefined> {
    const session = await backendSessions().get({ sessionId })
    if (session instanceof Error) throw session
    return session?.title
  }

  async function sessionCount(directory: string): Promise<number> {
    const list = await backendSessions().list({ directory })
    if (list instanceof Error) throw list
    return list.length
  }

  async function waitForGeneratedTitle(sessionId: string, expected: string): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await sessionTitle(sessionId) === expected) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Generated title did not become ${expected}`)
  }

  test.each(['success', 'denied', 'setup-error'] as const)(
    'acknowledges before a slow person filter and completes the %s reply',
    async (outcome) => {
      const source = await startSource()
      const before = (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => thread.id)
      let identityFinished = false
      clearIdentityCache()
      const removePerson = addFilter('person', async (): Promise<Person> => {
        await new Promise((resolve) => setTimeout(resolve, 3_500))
        identityFinished = true
        return { allowed: outcome !== 'denied', capabilities: new Set(['sessions']), permissions: [] }
      })
      const removeWorkspace = outcome === 'setup-error'
        ? addFilter('fork_workspace', () => ({ async provision() { return new Error('delayed setup failed') } }))
        : () => {}
      try {
        const started = Date.now()
        const interaction = await ctx.discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({
          name: 'fork',
          options: [{ name: 'workspace', type: 3, value: outcome === 'setup-error' ? 'separate' : 'shared' }],
        })
        const ack = await ctx.discord.thread(source.id).waitForInteractionAck({ interactionId: interaction.id, timeout: 2_500 })
        expect(Date.now() - started).toBeLessThan(3_000)
        expect(ack.type).toBe(5)
        expect(identityFinished).toBe(false)
        const expected = outcome === 'success' ? 'Session forked!' : outcome === 'denied' ? "You don't have permission" : 'Failed to fork session: delayed setup failed'
        await ctx.discord.thread(source.id).waitForMessage({ timeout: 8_000, predicate: (message) => message.content.includes(expected) })
        expect(identityFinished).toBe(true)
        const after = (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => thread.id)
        if (outcome === 'success') expect(after).toHaveLength(before.length + 1)
        else expect(after).toEqual(before)
      } finally {
        removePerson()
        removeWorkspace()
        clearIdentityCache()
      }
    }, 25_000,
  )

  test('unowned forks leave the interaction token for the owning machine', async () => {
    const unownedId = '200000000000001075'
    const owned = await ctx.discord.prisma.channel.findUniqueOrThrow({ where: { id: TEXT_CHANNEL_ID } })
    await ctx.discord.prisma.channel.create({ data: { id: unownedId, guildId: owned.guildId, type: 0, name: 'unowned-fork' } })
    let identityCalled = false
    const remove = addFilter('person', (person) => { identityCalled = true; return person })
    clearIdentityCache()
    try {
      const interaction = await ctx.discord.channel(unownedId).user(TEST_USER_ID).runSlashCommand({ name: 'fork' })
      await new Promise((resolve) => setTimeout(resolve, 3_500))
      expect((await ctx.discord.channel(unownedId).getInteractionResponse(interaction.id))?.acknowledged).toBe(false)
      expect(identityCalled).toBe(false)
    } finally {
      remove()
      clearIdentityCache()
      await ctx.discord.prisma.channel.delete({ where: { id: unownedId } })
    }
  }, 20_000)

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
    expect(messages.some((m) => m.message.role === 'assistant')).toBe(true)
    expect(JSON.stringify(messages)).not.toContain('A copy of this conversation was made in thread')
    // The source learns where the copy went, as context only: no new turn, no reply.
    const sourceBefore = await ctx.discord.thread(source.id).text()
    const noteIn = (entries: Awaited<ReturnType<typeof sessionMessages>>) => entries.filter((entry) =>
      entry.parts.some((part) => part.kind === 'text' && part.text.includes(`A copy of this conversation was made in thread <#${fork.id}> (session ${forkSession})`)))
    let sourceMessages = await sessionMessages(sourceSession!)
    for (const deadline = Date.now() + 4_000; noteIn(sourceMessages).length === 0 && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      sourceMessages = await sessionMessages(sourceSession!)
    }
    expect(noteIn(sourceMessages)).toHaveLength(1)
    expect(noteIn(sourceMessages)[0]?.parts.some((part) => part.kind === 'text' && part.text.includes('This thread continues unchanged'))).toBe(true)
    expect(sourceMessages.at(-1)?.message.role).not.toBe('assistant')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await ctx.discord.thread(source.id).text()).toBe(sourceBefore)
  }, 25_000)

  test('channel: moves the conversation and subsequent turns to the target project', async () => {
    const targetId = '200000000000001076'
    const targetDirectory = path.join(ctx.directories.root, 'cross-channel-project')
    fs.mkdirSync(targetDirectory, { recursive: true })
    const source = await startSource()
    const owned = await ctx.discord.prisma.channel.findUniqueOrThrow({ where: { id: TEXT_CHANNEL_ID } })
    await ctx.discord.prisma.channel.create({ data: {
      id: targetId, guildId: owned.guildId, type: ChannelType.GuildText, name: 'fork-target',
    } })
    await setChannelDirectory({ channelId: targetId, directory: targetDirectory, channelType: 'text' })
    let requested = false
    const remove = addFilter('fork_workspace', (_provider, request) => {
      expect(request.channelId).toBe(targetId)
      expect(request.projectDirectory).toBe(targetDirectory)
      expect(request.sourceDirectory).toBe(ctx.directories.projectDirectory)
      requested = true
      return null // Exercise the target-project fallback without a host binding.
    })
    try {
      const interaction = await ctx.discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({
        name: 'fork', options: [
          { name: 'channel', type: ApplicationCommandOptionType.Channel, value: targetId },
          { name: 'prompt', type: ApplicationCommandOptionType.String, value: 'WORKSPACE_WRITE_MARKER cross-channel' },
        ],
      })
      await ctx.discord.thread(source.id).waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
      const fork = await ctx.discord.channel(targetId).waitForThread({ timeout: 6_000 })
      expect('parent_id' in fork && fork.parent_id).toBe(targetId)
      const sessionId = await waitForThreadSession(fork.id)
      await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 10_000 })
      expect(requested).toBe(true)
      expect(await getThreadWorkingDirectory(fork.id)).toMatchObject({
        projectDirectory: targetDirectory, workingDirectory: targetDirectory,
      })
      expect(await backendSessions().get({ sessionId, directory: targetDirectory })).toMatchObject({ directory: targetDirectory })
      expect(fs.readFileSync(path.join(targetDirectory, 'fork-result.txt'), 'utf8')).toBe('isolated')
      expect(await ctx.discord.thread(fork.id).text()).toContain(`Forked from <#${source.id}> in <#${TEXT_CHANNEL_ID}>. Now working in the target project: ${targetDirectory}.`)
      // Reconstruct the runtime to check durable routing on the follow-up turn.
      disposeRuntime(fork.id)
      fs.unlinkSync(path.join(targetDirectory, 'fork-result.txt'))
      await ctx.discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: 'WORKSPACE_WRITE_MARKER follow-up' })
      await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 10_000, afterMessageIncludes: 'WORKSPACE_WRITE_MARKER follow-up' })
      expect(fs.readFileSync(path.join(targetDirectory, 'fork-result.txt'), 'utf8')).toBe('isolated')
    } finally { remove() }
  }, 35_000)

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
    const userMessages = sourceMessages.filter((m) => m.message.role === 'user')
    expect(userMessages.length).toBeGreaterThanOrEqual(2)
    const second = userMessages[userMessages.length - 1]!

    const fork = await forkFrom(source.id, [{ name: 'from', type: 3, value: second.message.id }])
    const forkMessages = await sessionMessages(await waitForThreadSession(fork.id))
    const forkUserCount = forkMessages.filter((m) => m.message.role === 'user').length
    expect(forkUserCount).toBe(userMessages.length - 1)
  }, 30_000)

  test('forks execute in real isolated worktrees, including workspace-bound sources and reconstruction', async () => {
    const directory = ctx.directories.projectDirectory
    fs.writeFileSync(path.join(directory, 'source-dirty.txt'), 'keep source edits')
    fs.writeFileSync(path.join(directory, 'fork-result.txt'), 'source must stay unchanged')
    const source = await startSource()
    const allocations: string[] = []
    const forkThreads: string[] = []
    let nested: { id: string } | undefined
    const remove = addFilter('fork_workspace', () => ({ async provision(request) {
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
      nested = await forkFrom(forkThreads[0]!, [{ name: 'prompt', type: 3, value: 'WORKSPACE_WRITE_MARKER nested' }])
      await waitForThreadSession(nested.id)
      await waitForFooterMessage({ discord: ctx.discord, threadId: nested.id, timeout: 10_000 })
      expect((await getThreadWorkingDirectory(nested.id))?.workingDirectory).toBe(allocations[2])
      expect(fs.readFileSync(path.join(allocations[2]!, 'fork-result.txt'), 'utf8')).toBe('isolated')
      expect(fs.existsSync(path.join(allocations[2]!, 'fork-local-only.txt'))).toBe(false)
      expect(fs.readFileSync(path.join(allocations[0]!, 'fork-result.txt'), 'utf8')).toBe('keep existing fork')
      expect(fs.readFileSync(path.join(directory, 'fork-result.txt'), 'utf8')).toBe('source must stay unchanged')
      expect(new Set(allocations).size).toBe(3)
    } finally { remove() }
    // Without a provider the fork is an ordinary conversation fork: the
    // workspace-bound fork inherits its source directory, the source fork
    // stays unbound, and nothing new is allocated.
    const count = allocations.length
    const inherited = await forkFrom(nested!.id, [{ name: 'prompt', type: 3, value: 'Reply with exactly: inherited fork' }])
    await waitForThreadSession(inherited.id)
    await waitForFooterMessage({ discord: ctx.discord, threadId: inherited.id, timeout: 10_000 })
    expect((await getThreadWorkingDirectory(inherited.id))?.workingDirectory).toBe(allocations[2])
    expect(allocations).toHaveLength(count)
    const plain = await forkFrom(source.id)
    await waitForThreadSession(plain.id)
    expect(await getThreadWorkingDirectory(plain.id)).toBeUndefined()
    expect(allocations).toHaveLength(count)
  }, 60_000)

  test('a non-Git home uses active task ownership without reading the conversation for scope', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-fork-home-')))
    const repository = ctx.directories.projectDirectory
    await setChannelDirectory({ channelId: TEXT_CHANNEL_ID, directory: home, channelType: 'text' })
    const allocations: string[] = []
    const sessions: Array<{ id: string; directory: string; threadId: string }> = []
    let taskActive = false
    let restoreHistory = () => {}
    const remove = addFilter('fork_workspace', () => taskActive ? ({ async provision(request) {
      restoreHistory()
      expect(request.sourceDirectory).toBe(home)
      const target = path.join(ctx.directories.root, `site-fork-${request.requestId}`)
      const branch = `site-fork-${request.requestId}`
      await exec('git', ['worktree', 'add', '-b', branch, target, 'HEAD'], { cwd: repository })
      allocations.push(target)
      return { workingDirectory: target, projectDirectory: repository, label: branch, kind: 'git-worktree' as const }
    } }) : null)
    try {
      const source = await startSource()
      const sourceSession = await waitForThreadSession(source.id)
      sessions.push({ id: sourceSession, directory: home, threadId: source.id })
      await ctx.discord.thread(source.id).user(TEST_USER_ID).sendMessage({ content: 'SITE_CODING_WRITE' })
      await waitForFooterMessage({ discord: ctx.discord, threadId: source.id, afterMessageIncludes: 'SITE_CODING_WRITE', afterAuthorId: TEST_USER_ID, timeout: 10_000 })
      expect(fs.readFileSync(path.join(repository, 'site-coding.txt'), 'utf8')).toBe('source')
      // Successful historical writes do not establish an active task owner.
      const historical = await forkFrom(source.id)
      const historicalSession = await waitForThreadSession(historical.id)
      sessions.push({ id: historicalSession, directory: home, threadId: historical.id })
      expect(await getThreadWorkingDirectory(historical.id)).toBeUndefined()
      expect(allocations).toHaveLength(0)
      taskActive = true
      const ops = backendSessions()
      const messages = ops.messages
      restoreHistory = () => { ops.messages = messages }
      ops.messages = new Proxy(messages, { apply(target, receiver, parameters) {
        const input = parameters[0]
        if (input?.sessionId === sourceSession && input.limit === undefined) throw new Error('Fork scope must not fetch the conversation')
        return Reflect.apply(target, receiver, parameters)
      } })
      disposeRuntime(source.id)
      const fork = await forkFrom(source.id, [{ name: 'prompt', type: 3, value: 'WORKSPACE_WRITE_MARKER site fork' }])
      const forkSession = await waitForThreadSession(fork.id)
      sessions.push({ id: forkSession, directory: allocations[0]!, threadId: fork.id })
      await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 10_000 })
      expect(forkSession).not.toBe(sourceSession)
      expect(fs.readFileSync(path.join(allocations[0]!, 'fork-result.txt'), 'utf8')).toBe('isolated')
      expect(fs.existsSync(path.join(allocations[0]!, 'site-coding.txt'))).toBe(false)
      expect(fs.existsSync(path.join(home, 'fork-result.txt'))).toBe(false)
      const sourceInfo = await backendSessions().get({ sessionId: sourceSession })
      expect(sourceInfo instanceof Error ? sourceInfo : sourceInfo?.directory).toBe(home)
      expect(await getThreadWorkingDirectory(source.id)).toBeUndefined()
      expect((await getThreadWorkingDirectory(fork.id))?.workingDirectory).toBe(allocations[0])
      expect((await getThreadWorkingDirectory(fork.id))?.projectDirectory).toBe(repository)
      const copied = await backendSessions().messages({ sessionId: forkSession, directory: allocations[0] })
      if (copied instanceof Error) throw copied
      expect(copied.some((message) => message.parts.some((part) => part.kind === 'text' && part.text.includes('SITE_CODING_WRITE')))).toBe(true)
    } finally {
      restoreHistory()
      remove()
      await setChannelDirectory({ channelId: TEXT_CHANNEL_ID, directory: repository, channelType: 'text' })
      // Pi sessions live in the suite's data dir and go with it. Deleting them
      // here would race the forks' pending title updates.
      for (const session of sessions) disposeRuntime(session.threadId)
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)

  test('provisioning failure creates no fork thread and runs no prompt', async () => {
    const source = await startSource()
    const beforeFile = fs.existsSync(path.join(ctx.directories.projectDirectory, 'fork-result.txt')) ? fs.readFileSync(path.join(ctx.directories.projectDirectory, 'fork-result.txt'), 'utf8') : null
    const before = await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()
    const remove = addFilter('fork_workspace', () => ({ async provision() { return new Error('fixture allocation failed') } }))
    try {
      const interaction = await ctx.discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({ name: 'fork', options: [{ name: 'prompt', type: 3, value: 'WORKSPACE_WRITE_MARKER must not run' }] })
      await ctx.discord.thread(source.id).waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
      expect((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => thread.id)).toEqual(before.map((thread) => thread.id))
      const afterFile = fs.existsSync(path.join(ctx.directories.projectDirectory, 'fork-result.txt')) ? fs.readFileSync(path.join(ctx.directories.projectDirectory, 'fork-result.txt'), 'utf8') : null
      expect(afterFile).toBe(beforeFile)
    } finally { remove() }
  }, 25_000)

  // Pi resumes a session wherever its header points, so a plain-directory
  // workspace is a real target. The task must never run in the source checkout.
  test('a plain-directory workspace runs the fork there, never in the source checkout', async () => {
    const source = await startSource()
    const sourceFile = path.join(ctx.directories.projectDirectory, 'fork-result.txt')
    const beforeFile = fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8') : null
    let provisioned: string | undefined
    const remove = addFilter('fork_workspace', () => ({ async provision(request) {
      const workingDirectory = path.join(ctx.directories.root, `plain-${request.requestId}`)
      fs.mkdirSync(workingDirectory, { recursive: true })
      provisioned = workingDirectory
      return { workingDirectory, projectDirectory: ctx.directories.projectDirectory, label: 'plain', kind: 'directory' as const }
    } }))
    try {
      const fork = await forkFrom(source.id, [{ name: 'prompt', type: 3, value: 'WORKSPACE_WRITE_MARKER plain directory' }])
      await waitForThreadSession(fork.id)
      await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 10_000 })
      expect((await getThreadWorkingDirectory(fork.id))?.workingDirectory).toBe(provisioned)
      expect(fs.readFileSync(path.join(provisioned!, 'fork-result.txt'), 'utf8')).toBe('isolated')
      expect(fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8') : null).toBe(beforeFile)
    } finally { remove() }
  }, 25_000)

  test('small-model titles use only the new prompt, without replay or title turns in the fork', async () => {
    const source = await startSource()
    const directory = ctx.directories.projectDirectory
    const before = await sessionCount(directory)
    const prompts = ['Reply with exactly: fork-cache-investigation', 'Reply with exactly: fork-permission-review']
    const titles: string[] = []
    const expected = ['Cache Investigation', 'Permission Review']
    for (const [index, prompt] of prompts.entries()) {
      const fork = await forkFrom(source.id, [{ name: 'prompt', type: 3, value: prompt }])
      const sessionId = await waitForThreadSession(fork.id)
      await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000 })
      await waitForGeneratedTitle(sessionId, expected[index]!)
      expect(await sessionTitle(sessionId)).toBe(expected[index])
      const deadline = Date.now() + 4_000
      let title = ''
      while (Date.now() < deadline) {
        title = (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((thread) => thread.id === fork.id)?.name ?? ''
        if (title === expected[index]) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      titles.push(title)
      // Forked-to notes are context only; a later fork also inherits earlier ones.
      const withoutNotes = (entries: Awaited<ReturnType<typeof sessionMessages>>) => entries.filter((entry) =>
        !entry.parts.some((part) => part.kind === 'text' && part.text.includes('A copy of this conversation was made in thread')))
      const sourceHistory = withoutNotes(await sessionMessages((await getThreadSession(source.id))!))
      const history = withoutNotes(await sessionMessages(sessionId))
      expect(history.filter((entry) => entry.message.role === 'user')).toHaveLength(sourceHistory.filter((entry) => entry.message.role === 'user').length + 1)
      expect(history.filter((entry) => entry.message.role === 'assistant')).toHaveLength(sourceHistory.filter((entry) => entry.message.role === 'assistant').length + 1)
      expect((await ctx.discord.thread(fork.id).text()).replace(`<#${source.id}>`, '<#SOURCE_THREAD>')).toContain(`Forked from <#SOURCE_THREAD>.\n${prompt}`)
      // The fork's new prompt leads with the user's request; the fork context trails it.
      const forkPrompt = history.filter((entry) => entry.message.role === 'user').at(-1)
      const forkPromptText = forkPrompt?.parts.find((part) => part.kind === 'text')?.text ?? ''
      expect(forkPromptText.startsWith(prompt)).toBe(true)
      expect(forkPromptText.startsWith('(Forked from')).toBe(false)
    }
    expect(titles).toMatchInlineSnapshot(`
      [
        "Cache Investigation",
        "Permission Review",
      ]
    `)
    expect(await sessionCount(directory) - before).toBe(2)
    expect(await sessionTitle((await getThreadSession(source.id))!)).not.toBe(prompts[0])
  }, 30_000)

  test('a promptless fork ignores restart recovery and takes its first actual message title', async () => {
    const source = await startSource()
    const fork = await forkFrom(source.id)
    const sessionId = await waitForThreadSession(fork.id)
    // The durable marker outlives the runtime that created the fork.
    disposeRuntime(fork.id)
    await resumeInterruptedSessions({
      discordClient: ctx.botClient, appId: ctx.discord.botUserId,
      consume: () => ({ resume: [{ threadId: fork.id, sessionId, userId: TEST_USER_ID, username: 'fork-tester' }], stale: [] }),
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000 })
    expect(await (await getDb()).query.pending_session_titles.findFirst({ where: { session_id: sessionId } })).toMatchObject({ task_prompt: null })
    const prompt = 'Reply with exactly: fork-deferred-task'
    await ctx.discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: prompt })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000, afterMessageIncludes: 'fork-deferred-task' })
    await waitForGeneratedTitle(sessionId, 'Deferred Fork Task')
    expect(await sessionTitle(sessionId)).toBe('Deferred Fork Task')
    await ctx.discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: fork-later-turn' })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000, afterMessageIncludes: 'fork-later-turn' })
    expect(await sessionTitle(sessionId)).toBe('Deferred Fork Task')
    // The thread rename follows the backend's session.updated event.
    await expect.poll(async () => (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((thread) => thread.id === fork.id)?.name).toBe('Deferred Fork Task')
    expect(await getThreadSession(fork.id)).toBe(sessionId)
  }, 30_000)

  test('a new thread is named from its first task through the isolated title request', async () => {
    const existing = new Set((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((t) => t.id))
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: new-thread-task' })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({ timeout: 4_000, predicate: (t) => !existing.has(t.id) })
    const sessionId = await waitForThreadSession(thread.id)
    await waitForGeneratedTitle(sessionId, 'New Thread Task')
    await expect.poll(async () => (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((t) => t.id === thread.id)?.name).toBe('New Thread Task')
    // Named once: the marker is consumed, so later turns keep the title.
    expect(await (await getDb()).query.pending_session_titles.findFirst({ where: { session_id: sessionId } })).toBeUndefined()
  }, 30_000)

  test('a user-chosen fork title is preserved before the first task message', async () => {
    const source = await startSource()
    const fork = await forkFrom(source.id)
    const sessionId = await waitForThreadSession(fork.id)
    const directory = ctx.directories.projectDirectory
    const updated = await backendSessions().setTitle!({ sessionId, directory, title: 'User chosen branch' })
    if (updated instanceof Error) throw updated
    await ctx.discord.thread(fork.id).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: keep-custom-fork-title' })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000 })
    expect(await sessionTitle(sessionId)).toBe('User chosen branch')
    // The thread rename follows the backend's session.updated event.
    await expect.poll(async () => (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((thread) => thread.id === fork.id)?.name).toBe('User chosen branch')
  }, 30_000)

  test('failed naming keeps the original task across recovery and later local-queue turns', async () => {
    const source = await startSource()
    const fork = await forkFrom(source.id)
    const sessionId = await waitForThreadSession(fork.id)
    const directory = ctx.directories.projectDirectory
    const getBackend = await getAgentBackendProvider().initializeForDirectory(directory)
    if (getBackend instanceof Error) throw getBackend
    const backend = getBackend()
    const session = await backend.sessions.get({ sessionId, directory })
    if (!session || session instanceof Error) throw new Error('Missing fork fixture session')
    const originalPrompt = 'Reply with exactly: fork-cache-investigation'
    const failure = new Error('Fixture title inference unavailable')
    const result = await applyPendingSessionTitle({
      session, prompt: originalPrompt, directory,
      backend: { ...backend, sessions: { ...backend.sessions, generateTitle: async () => failure } },
    })
    expect(result).toBe(failure)
    const pending = () => getDb().then((db) => db.query.pending_session_titles.findFirst({ where: { session_id: sessionId } }))
    expect((await pending())?.task_prompt).toBe(originalPrompt)

    disposeRuntime(fork.id)
    await resumeInterruptedSessions({
      discordClient: ctx.botClient, appId: ctx.discord.botUserId,
      consume: () => ({ resume: [{ threadId: fork.id, sessionId, userId: TEST_USER_ID, username: 'fork-tester' }], stale: [] }),
    })
    const recoveryMessages = await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000 })
    expect((await pending())?.task_prompt).toBe(originalPrompt)
    expect(await backend.sessions.get({ sessionId, directory })).toMatchObject({ title: session.title })
    expect((await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((thread) => thread.id === fork.id)?.name).not.toBe('Cache Investigation')

    const runtime = getRuntime(fork.id)
    if (!runtime) throw new Error('Missing reconstructed runtime')
    await runtime.enqueueIncoming({
      prompt: 'Reply with exactly: fork-permission-review', userId: TEST_USER_ID, username: 'fork-tester',
      appId: ctx.discord.botUserId, mode: 'local-queue',
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000, afterMessageId: recoveryMessages.at(-1)!.id })
    await waitForGeneratedTitle(sessionId, 'Cache Investigation')
    expect((await ctx.discord.thread(fork.id).text()).replace(`<#${source.id}>`, '<#SOURCE_THREAD>').replace(/^-# \*.*$/gm, '<FOOTER>')).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      Forked from <#SOURCE_THREAD>. Continue the conversation here.
      -# Roadie restarted while this session was running. Resuming.
      ok
      <FOOTER>
      ok
      <FOOTER>"
    `)
    await expect.poll(async () => (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).find((thread) => thread.id === fork.id)?.name).toBe('Cache Investigation')
    expect(await pending()).toBeUndefined()
  }, 30_000)

  test('a slow title request does not delay the actual fork task reply', async () => {
    const source = await startSource()
    const fork = await forkFrom(source.id, [{ name: 'prompt', type: 3, value: 'Reply with exactly: fork-title-slow' }])
    const sessionId = await waitForThreadSession(fork.id)
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 8_000 })
    expect(await sessionTitle(sessionId)).not.toBe('Follow-up Investigation')
    expect((await ctx.discord.thread(fork.id).text()).replace(`<#${source.id}>`, '<#SOURCE_THREAD>')).toContain('fork-title-slow')
    await waitForGeneratedTitle(sessionId, 'Follow-up Investigation')
    expect(await sessionTitle(sessionId)).toMatchInlineSnapshot(`"Follow-up Investigation"`)
  }, 30_000)
})
