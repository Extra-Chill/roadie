import { describe, test, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { findPi } from './agent-backend/pi/find-pi.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { ensureAgentTokenSecret, mintAgentToken } from './agent-token.js'
import { getThreadSession, getThreadWorkingDirectory, getSessionTurnAttribution, setChannelDirectory } from './database.js'
import { waitForFooterMessage } from './test-utils.js'

const exec = promisify(execFile)
const sourceChannel = '200000000000001180'
const targetChannel = '200000000000001181'

describe.skipIf(!findPi())('session fork CLI', () => {
  const ctx = setupQueueAdvancedSuite({ channelId: sourceChannel, channelName: 'session-fork', dirName: 'session-fork-cli', username: 'fork-agent',
    extraMatchers: [{
      id: 'fork-target-write', priority: 180,
      when: { latestUserTextIncludes: 'fork-target-ready', lastMessageRole: 'user' },
      then: { parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'target-write', toolName: 'bash', input: JSON.stringify({ command: 'pwd > fork-proof.txt', description: 'Prove target working directory', hasSideEffect: true }) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ] },
    }],
  })

  async function startSource() {
    const existing = new Set((await ctx.discord.channel(sourceChannel).getThreads()).map(t => t.id))
    await ctx.discord.channel(sourceChannel).user(TEST_USER_ID).sendMessage({ content: 'Reply with exactly: source-ready' })
    const thread = await ctx.discord.channel(sourceChannel).waitForThread({ timeout: 4000, predicate: t => !existing.has(t.id) })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 8000 })
    return (await getThreadSession(thread.id))!
  }

  function run(sessionId: string, args: string[]) {
    return exec(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'session', 'fork', ...args], {
      env: { ...process.env, ROADIE_DATA_DIR: ctx.directories.dataDir, ROADIE_AGENT_SHELL: '1',
        ROADIE_AGENT_TOKEN: mintAgentToken({ secret: ensureAgentTokenSecret(), sessionId }),
        ROADIE_SESSION_ID: sessionId, ROADIE_DB_URL: '', ROADIE_DB_AUTH_TOKEN: '',
        ROADIE_DB_AUTH_TOKEN_FILE: '', ROADIE_AGENT_TOKEN_SECRET: '', ROADIE_SERVICE_TOKEN_FILE: '' },
      timeout: 20000,
    })
  }

  test('forks through the real agent-shell CLI into the target project and prints the URL', async () => {
    const sessionId = await startSource()
    const directory = path.join(ctx.directories.root, 'target')
    fs.mkdirSync(directory, { recursive: true })
    const parent = await ctx.discord.prisma.channel.findUniqueOrThrow({ where: { id: sourceChannel } })
    await ctx.discord.prisma.channel.create({ data: { id: targetChannel, guildId: parent.guildId, type: 0, name: 'target' } })
    await setChannelDirectory({ channelId: targetChannel, directory, channelType: 'text' })
    const { stdout } = await run(sessionId, ['--channel', targetChannel, '--prompt', 'Reply with exactly: fork-target-ready', '--json'])
    const output = JSON.parse(stdout.trim())
    expect(output.url).toBe(`https://discord.com/channels/${parent.guildId}/${output.threadId}`)
    const threads = await ctx.discord.channel(targetChannel).getThreads()
    expect(threads.some(t => t.id === output.threadId)).toBe(true)
    expect(await getThreadSession(output.threadId)).toBe(output.forkedSessionId)
    expect(await getThreadWorkingDirectory(output.threadId)).toMatchObject({ projectDirectory: directory, workingDirectory: directory })
    await waitForFooterMessage({ discord: ctx.discord, threadId: output.threadId, timeout: 10000 })
    expect(await ctx.discord.thread(output.threadId).text()).toContain('fork-target-ready')
    const messages = await ctx.pi!.getBackend().sessions.messages({ sessionId: output.forkedSessionId, directory })
    expect(messages).not.toBeInstanceOf(Error)
    expect(JSON.stringify(messages)).toContain('fork-target-ready')
    expect(fs.readFileSync(path.join(directory, 'fork-proof.txt'), 'utf8').trim()).toBe(directory)
    expect(fs.existsSync(path.join(ctx.directories.projectDirectory, 'fork-proof.txt'))).toBe(false)
    expect((await getSessionTurnAttribution(output.forkedSessionId))?.actor).toMatchObject({ id: TEST_USER_ID, via: 'cli' })
  }, 30000)

  test('refuses another session before creating anything', async () => {
    const sessionId = await startSource()
    const before = await ctx.discord.channel(sourceChannel).getThreads()
    await expect(run(sessionId, ['--session', 'another-session'])).rejects.toMatchObject({ stderr: expect.stringContaining('agent token is bound to another session') })
    expect((await ctx.discord.channel(sourceChannel).getThreads()).map(t => t.id)).toEqual(before.map(t => t.id))
  }, 30000)
})
