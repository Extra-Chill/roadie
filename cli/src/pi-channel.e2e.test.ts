// A Discord channel opted into the Pi backend (#51): the real bot, the
// Discord digital twin, real `pi` processes, and a scripted model server.
// Skipped when no `pi` binary is available (set ROADIE_PI_BIN).

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { setAgentBackendProvider } from './agent-backend/registry.js'
import { openCodeBackendProvider } from './agent-backend/opencode.js'
import { PiBackendProvider } from './agent-backend/pi/backend.js'
import { withPiChannels } from './agent-backend/pi/router.js'
import { fakeModelsJson, startFakeModelServer } from './agent-backend/pi/fake-model-server.js'
import { getThreadSession } from './database.js'
import { restartGlobalEventListener } from './session-handler/global-event-listener.js'
import { waitForFooterMessage } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001510'

function findPi(): string | undefined {
  for (const bin of [process.env['ROADIE_PI_BIN'], 'pi'].filter(Boolean) as string[]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' })
      return bin
    } catch {}
  }
  return undefined
}

const bin = findPi()

describe.skipIf(!bin)('Pi channel', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'pi-channel-e2e',
    dirName: 'pi-channel-e2e',
    username: 'pi-tester',
  })
  let server: Awaited<ReturnType<typeof startFakeModelServer>>
  let pi: PiBackendProvider
  let restore: (() => void) | undefined

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
    restore = setAgentBackendProvider(withPiChannels({
      fallback: openCodeBackendProvider,
      pi,
      channels: new Set([TEXT_CHANNEL_ID]),
    }))
    restartGlobalEventListener()
  })

  afterAll(async () => {
    restore?.()
    pi?.dispose()
    await server?.close()
  })

  test('a message starts a Pi session; the reply and footer render in the thread', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: 'say hi to pi' })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => t.name === 'say hi to pi',
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })
    const sessionId = await getThreadSession(thread.id)
    expect(sessionId && pi.owns(sessionId)).toBe(true)
    const text = await ctx.discord.thread(thread.id).text()
    expect(text).toMatchInlineSnapshot(`
      "--- from: user (pi-tester)
      say hi to pi
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      hello from the fake model
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*"
    `)
  }, 40_000)

  test('a tool call renders and its output reaches the reply', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: 'RUN_TOOL echo pi-tool-ok' })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => Boolean(t.name?.startsWith('RUN_TOOL')),
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })
    const text = await ctx.discord.thread(thread.id).text()
    expect(text).toMatchInlineSnapshot(`
      "--- from: user (pi-tester)
      RUN_TOOL echo pi-tool-ok
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      -# ┣ bash _echo pi-tool-ok_

      tool said: pi-tool-ok
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*"
    `)
  }, 40_000)
})
