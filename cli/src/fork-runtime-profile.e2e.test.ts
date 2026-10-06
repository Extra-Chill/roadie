import { afterAll, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execAsync } from './exec-async.js'
import { addFilter } from './hooks.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { getThreadSession, getThreadWorkingDirectory } from './database.js'
import { waitForFooterMessage } from './test-utils.js'

const channelId = '200000000000001125'
const previousFlag = process.env.OPENCODE_EXPERIMENTAL_WORKSPACES
let removeRuntime = () => {}
beforeAll(() => {
  process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = 'true'
  removeRuntime = addFilter('opencode_server_config', (config) => {
    if (config instanceof Error) return config
    const profile = JSON.parse(fs.readFileSync(path.join(ctx.directories.projectDirectory, 'opencode.json'), 'utf8'))
    return { ...config, provider: { ...config.provider, ...profile.provider }, model: profile.model, small_model: profile.small_model }
  })
})
const ctx = setupQueueAdvancedSuite({
  channelId, channelName: 'fork-runtime-profile', dirName: 'fork-runtime-profile', username: 'profile-tester',
  extraMatchers: [
    { id: 'profile-write', priority: 140, when: { latestUserTextIncludes: 'PROFILE_WRITE', lastMessageRole: 'user' }, then: { parts: [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'profile-write', toolName: 'bash', input: JSON.stringify({ command: 'printf isolated > profile-proof.txt', description: 'Write in the fresh fork', hasSideEffect: true }) },
      { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ] } },
  ],
})
afterAll(() => {
  removeRuntime()
  if (previousFlag === undefined) delete process.env.OPENCODE_EXPERIMENTAL_WORKSPACES
  else process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = previousFlag
})

test('fresh repositories retain the source runtime provider and model picker uses their effective catalogue', async () => {
  const repo = fs.mkdtempSync(path.join(ctx.directories.root, 'fresh-code-repo-'))
  const sourceConfig = JSON.parse(fs.readFileSync(path.join(ctx.directories.projectDirectory, 'opencode.json'), 'utf8'))
  const definition = sourceConfig.provider['deterministic-provider']
  // Only the host runtime has deterministic-provider. The code project adds
  // another active provider and has no source provider definition of its own.
  fs.writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ provider: { 'workspace-provider': { ...definition, name: 'Workspace provider' } } }))
  await execAsync({ command: 'git', args: ['init', '-b', 'main'] }, { cwd: repo })
  await execAsync({ command: 'git', args: ['add', 'opencode.json'] }, { cwd: repo })
  await execAsync({ command: 'git', args: ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', 'commit', '-m', 'fixture'] }, { cwd: repo })
  await ctx.discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: runtime profile source' })
  const source = await ctx.discord.channel(channelId).waitForThread({ timeout: 6000 })
  await waitForFooterMessage({ discord: ctx.discord, threadId: source.id, timeout: 10000 })
  const remove = addFilter('fork_workspace', () => ({ async provision(request) {
    const workingDirectory = path.join(ctx.directories.root, `fork-${request.requestId}`)
    const branch = `fork-${request.requestId}`
    await execAsync({ command: 'git', args: ['worktree', 'add', '-b', branch, workingDirectory, 'HEAD'] }, { cwd: repo })
    return { workingDirectory, projectDirectory: repo, label: branch, kind: 'git-worktree' as const }
  } }))
  try {
    const sourceIds = new Set((await ctx.discord.channel(channelId).getThreads()).map((thread) => thread.id))
    const interaction = await ctx.discord.thread(source.id).user(TEST_USER_ID).runSlashCommand({ name: 'fork', options: [{ name: 'prompt', type: 3, value: 'PROFILE_WRITE' }] })
    await ctx.discord.thread(source.id).waitForInteractionAck({ interactionId: interaction.id, timeout: 6000 })
    const fork = await ctx.discord.channel(channelId).waitForThread({ timeout: 8000, predicate: (thread) => !sourceIds.has(thread.id) })
    await waitForFooterMessage({ discord: ctx.discord, threadId: fork.id, timeout: 10000 })
    const binding = await getThreadWorkingDirectory(fork.id)
    expect(binding).toBeDefined()
    expect(await getThreadSession(fork.id)).not.toBe(await getThreadSession(source.id))
    expect(fs.readFileSync(path.join(binding!.workingDirectory, 'profile-proof.txt'), 'utf8')).toBe('isolated')
    expect(fs.existsSync(path.join(repo, 'profile-proof.txt'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(binding!.workingDirectory, 'opencode.json'), 'utf8')).provider['deterministic-provider']).toBeUndefined()
    const picker = await ctx.discord.thread(fork.id).user(TEST_USER_ID).runSlashCommand({ name: 'model', options: [] })
    await ctx.discord.thread(fork.id).waitForInteractionAck({ interactionId: picker.id, timeout: 6000 })
    const deadline = Date.now() + 10000
    let offered = false
    while (Date.now() < deadline) {
      offered = JSON.stringify(await ctx.discord.thread(fork.id).getMessages()).includes('Workspace provider')
      if (offered) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(offered, 'model picker must query the fork catalogue, not the parent home').toBe(true)
  } finally { remove() }
}, 60000)
