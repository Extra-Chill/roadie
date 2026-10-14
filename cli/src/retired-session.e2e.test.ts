// Hard cutover from OpenCode (#177): with Pi the default backend, a thread
// still bound to an OpenCode session moves to a new Pi session on its next
// message, seeded from the thread's chat history. The fallback here is a
// stub that fails the test if anything reaches it: a retired session must
// never start or prompt the old backend.

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { setAgentBackendProvider } from './agent-backend/registry.js'
import type { AgentBackendProvider } from './agent-backend/types.js'
import { PiBackendProvider } from './agent-backend/pi/backend.js'
import { withPiDefault } from './agent-backend/pi/router.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { fakeModelsJson, startFakeModelServer } from './agent-backend/pi/fake-model-server.js'
import { getThreadSession, setThreadSession } from './database.js'
import * as threadState from './session-handler/thread-runtime-state.js'
import { startIpcPolling, stopIpcPolling } from './ipc-polling.js'
import { restartGlobalEventListener } from './session-handler/global-event-listener.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001530'
const RETIRED_SESSION_ID = 'ses_retiredopencode0000000001'

const bin = findPi()

/** OpenCode stand-in: any use of it is a cutover bug. */
function untouchableFallback(touched: string[]): AgentBackendProvider {
  return {
    id: 'opencode',
    getBackend: () => null,
    async initializeForDirectory(directory) {
      touched.push(`initializeForDirectory ${directory}`)
      return new Error('the retired backend was started')
    },
    subscribeEvents: async () => new Error('fallback is down'),
    onStarted: () => {},
  }
}

describe.skipIf(!bin)('retired OpenCode sessions move to Pi', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'retired-session-e2e',
    dirName: 'retired-session-e2e',
    username: 'retired-tester',
  })
  let server: Awaited<ReturnType<typeof startFakeModelServer>>
  let pi: PiBackendProvider
  let restore: (() => void) | undefined
  const touched: string[] = []

  beforeAll(async () => {
    server = await startFakeModelServer()
    const agentDir = path.join(ctx.directories.root, 'pi-agent')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'models.json'), fakeModelsJson(server.baseUrl))
    pi = new PiBackendProvider({
      bin: bin!,
      sessionDir: path.join(ctx.directories.dataDir, 'pi-sessions'),
      model: 'fake/fake-1',
      env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' },
    })
    restore = setAgentBackendProvider(withPiDefault({ fallback: untouchableFallback(touched), pi }))
    restartGlobalEventListener()
    await startIpcPolling({ discordClient: ctx.botClient })
  })

  afterAll(async () => {
    stopIpcPolling()
    restore?.()
    await pi?.dispose()
    await server?.close()
  })

  test('the next message starts a seeded Pi session and says so in the thread', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: 'remember the word marmalade' })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => t.name === 'remember the word marmalade',
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })

    // The thread as it was before the swap: bound to an OpenCode session.
    await setThreadSession(thread.id, RETIRED_SESSION_ID)
    threadState.setSessionId(thread.id, RETIRED_SESSION_ID)
    const requestsBefore = server.bodies.length

    await ctx.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'what was the word' })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: ctx.discord.botUserId,
      text: 'This thread moved from OpenCode to Pi',
      timeout: 20_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 20_000,
      afterMessageIncludes: 'what was the word',
      afterAuthorId: TEST_USER_ID,
    })

    const sessionId = await getThreadSession(thread.id)
    expect(sessionId).not.toBe(RETIRED_SESSION_ID)
    expect(sessionId && pi.owns(sessionId)).toBe(true)
    expect(touched).toEqual([])

    // The model saw the seed (with the earlier exchange) before the new message.
    const turn = server.bodies.slice(requestsBefore).find((body) => body.includes('what was the word'))
    expect(turn).toBeDefined()
    expect(turn).toContain('[Session moved]')
    expect(turn).toContain(RETIRED_SESSION_ID)
    expect(turn).toContain('remember the word marmalade')
    expect(turn!.indexOf('[Session moved]')).toBeLessThan(turn!.lastIndexOf('what was the word'))
  }, 60_000)
})
