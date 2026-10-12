// Real-model trial of a Pi channel (#51). Opt-in (spends real model calls);
// needs a `pi` binary (ROADIE_PI_BIN) and one of:
// - ROADIE_PI_REAL_AGENT_DIR: a Pi agent dir with its own login (e.g. a
//   ChatGPT/Codex subscription), model ROADIE_PI_REAL_MODEL (default
//   openai-codex/gpt-5.5);
// - ROADIE_PI_REAL_POOL_DIR: a credential pool data dir, billed through the
//   pool proxy, rotation ROADIE_PI_REAL_ROTATION.

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { setAgentBackendProvider } from './agent-backend/registry.js'
import { openCodeBackendProvider } from './agent-backend/opencode.js'
import { PiBackendProvider } from './agent-backend/pi/backend.js'
import { withPiChannels } from './agent-backend/pi/router.js'
import { writePiPoolAgentDir } from './agent-backend/pi/pool.js'
import { startMessagesProxy, type MessagesProxy } from './credentials/messages-proxy.js'
import { SHARED_POOL_ID } from './credentials/store.js'
import { pendingActionButtonContexts } from './commands/action-buttons.js'
import { getThreadSession } from './database.js'
import { startIpcPolling, stopIpcPolling } from './ipc-polling.js'
import { restartGlobalEventListener } from './session-handler/global-event-listener.js'
import { waitForFooterMessage } from './test-utils.js'
import type { AgentEvent } from './agent-backend/events.js'

const TEXT_CHANNEL_ID = '200000000000001520'
const bin = process.env['ROADIE_PI_BIN']
const poolDir = process.env['ROADIE_PI_REAL_POOL_DIR']
const directAgentDir = process.env['ROADIE_PI_REAL_AGENT_DIR']
const rotation = process.env['ROADIE_PI_REAL_ROTATION'] || 'anthropic-claude-haiku-5-5'
const directModel = process.env['ROADIE_PI_REAL_MODEL'] || 'openai-codex/gpt-6-luna'
/** Pool mode with a ChatGPT account: bill this Codex model through the proxy. */
const codexModel = process.env['ROADIE_PI_REAL_CODEX_MODEL']

describe.skipIf(!bin || (!poolDir && !directAgentDir))('Pi channel on a real model through the credential pool', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'pi-real-e2e',
    dirName: 'pi-real-e2e',
    username: 'pi-real-tester',
  })
  let proxy: MessagesProxy | undefined
  let pi: PiBackendProvider
  let restore: (() => void) | undefined
  const usage: Array<{ input: number; cacheRead: number; cacheWrite: number; output: number }> = []
  const upstream: number[] = []

  beforeAll(async () => {
    if (directAgentDir) {
      pi = new PiBackendProvider({
        bin: bin!,
        sessionDir: path.join(ctx.directories.dataDir, 'pi-sessions'),
        model: directModel,
        env: { PI_CODING_AGENT_DIR: directAgentDir },
      })
    } else {
    proxy = await startMessagesProxy({
      dataDir: poolDir!,
      resolvePools: async () => SHARED_POOL_ID,
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init)
        upstream.push(response.status)
        if (response.status >= 400) {
          console.log(`[pi-real] upstream ${response.status}: ${(await response.clone().text()).slice(0, 400)}`)
        }
        return response
      },
    })
    const agentDir = path.join(ctx.directories.root, 'pi-agent')
    writePiPoolAgentDir({ agentDir, baseUrl: proxy.baseUrl, rotations: codexModel ? [] : [rotation], codexModels: codexModel ? [codexModel] : [] })
    pi = new PiBackendProvider({
      bin: bin!,
      sessionDir: path.join(ctx.directories.dataDir, 'pi-sessions'),
      model: codexModel ? `roadie-codex/${codexModel}` : `roadie/${rotation}`,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' },
      pool: { issueKey: (id) => proxy!.issueKey(id), revokeKey: (key) => proxy!.revokeKey(key) },
    })
    }
    const events = await pi.subscribeEvents({ signal: new AbortController().signal })
    void (async () => {
      for await (const item of events) {
        for (const event of item.events as AgentEvent[]) {
          if (event.type === 'message' && event.message.role === 'assistant' && event.message.completedAt && event.message.usage) {
            usage.push(event.message.usage)
          }
        }
      }
    })()
    restore = setAgentBackendProvider(withPiChannels({ fallback: openCodeBackendProvider, pi, channels: new Set([TEXT_CHANNEL_ID]) }))
    restartGlobalEventListener()
    await startIpcPolling({ discordClient: ctx.botClient })
  })

  afterAll(async () => {
    stopIpcPolling()
    restore?.()
    pi?.dispose()
    await proxy?.close()
    const report = { model: directAgentDir ? directModel : codexModel ? `roadie-codex/${codexModel}` : `roadie/${rotation}`, upstreamStatuses: upstream, usage }
    fs.writeFileSync(path.join(process.env['TMPDIR'] || '/tmp', 'pi-real-model-report.json'), JSON.stringify(report, null, 2))
  })

  async function thread(content: string, prefix: string) {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content })
    const created = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({ timeout: 15_000, predicate: (t) => Boolean(t.name?.startsWith(prefix)) })
    await waitForFooterMessage({ discord: ctx.discord, threadId: created.id, timeout: 120_000 })
    return created
  }

  test('a plain reply', async () => {
    const t = await thread('Reply with exactly: pi-real-ok', 'Reply with exactly')
    const text = await ctx.discord.thread(t.id).text()
    console.log(`[pi-real] reply thread:\n${text}`)
    expect(text).toContain('pi-real-ok')
    expect(pi.owns((await getThreadSession(t.id))!)).toBe(true)
  }, 150_000)

  test('a bash tool call', async () => {
    const t = await thread('Use the bash tool to run `echo pi-real-tool-$((40+2))`, then tell me exactly what it printed.', 'Use the bash tool')
    const text = await ctx.discord.thread(t.id).text()
    console.log(`[pi-real] tool thread:\n${text}`)
    expect(text).toContain('pi-real-tool-42')
    expect(text).toMatch(/bash/)
  }, 150_000)

  test('a Roadie tool: action buttons', async () => {
    const t = await thread('Call the roadie_action_buttons tool with one button labeled "Ship it". Say nothing else.', 'Call the roadie_action_buttons')
    const shown = [...pendingActionButtonContexts.values()].some((c) => c.thread.id === t.id)
    const text = await ctx.discord.thread(t.id).text()
    console.log(`[pi-real] buttons thread:\n${text}`)
    expect(shown || text.includes('Ship it')).toBe(true)
  }, 150_000)
})
