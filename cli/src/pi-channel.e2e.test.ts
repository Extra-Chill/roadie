// A Discord channel opted into the Pi backend (#51): the real bot, the
// Discord digital twin, real `pi` processes, and a scripted model server.
// Skipped when no `pi` binary is available (set ROADIE_PI_BIN).

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { setAgentBackendProvider } from './agent-backend/registry.js'
import { openCodeBackendProvider } from './agent-backend/opencode.js'
import { PiBackendProvider } from './agent-backend/pi/backend.js'
import { withPiChannels } from './agent-backend/pi/router.js'
import { fakeModelsJson, startFakeModelServer } from './agent-backend/pi/fake-model-server.js'
import { getSessionSleep, getThreadSession } from './database.js'
import { pendingActionButtonContexts } from './commands/action-buttons.js'
import { wakeDueSessionSleeps } from './task-runner.js'
import { startIpcPolling, stopIpcPolling } from './ipc-polling.js'
import { restartGlobalEventListener } from './session-handler/global-event-listener.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'
import { findPi } from './agent-backend/pi/find-pi.js'

const TEXT_CHANNEL_ID = '200000000000001510'

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
    // The bot entrypoint (cli-runner) starts IPC polling, not startDiscordBot.
    await startIpcPolling({ discordClient: ctx.botClient })
  })

  afterAll(async () => {
    stopIpcPolling()
    restore?.()
    await pi?.dispose()
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

  test('roadie_action_buttons shows buttons; a click continues the Pi session', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'CALL_TOOL roadie_action_buttons {"buttons":[{"label":"Go on, pi","color":"green"}]}',
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => Boolean(t.name?.startsWith('CALL_TOOL roadie_action_buttons')),
    })
    const th = ctx.discord.thread(thread.id)
    const start = Date.now()
    let action: { contextHash: string; messageId: string } | undefined
    while (!action && Date.now() - start < 20_000) {
      const entry = [...pendingActionButtonContexts.entries()].find(([, c]) => c.thread.id === thread.id && Boolean(c.messageId))
      if (entry) action = { contextHash: entry[0], messageId: entry[1].messageId! }
      else await new Promise((r) => setTimeout(r, 100))
    }
    if (!action) throw new Error('no action buttons')
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })
    const sessionId = await getThreadSession(thread.id)
    const interaction = await th.user(TEST_USER_ID).clickButton({ messageId: action.messageId, customId: `action_button:${action.contextHash}:0` })
    await th.waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000, afterMessageIncludes: '**pi-tester:** Go on, pi' })
    expect(await getThreadSession(thread.id)).toBe(sessionId)
    expect(await th.text({ showInteractions: true })).toMatchInlineSnapshot(`
      "--- from: user (pi-tester)
      CALL_TOOL roadie_action_buttons {"buttons":[{"label":"Go on, pi","color":"green"}]}
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      **Action Required**
      _Selected: Go on, pi_
      tool said: Action button(s) shown: Go on, pi
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*
      [user clicks button]
      » **pi-tester:** Go on, pi
      hello from the fake model
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*"
    `)
  }, 60_000)

  test('roadie_sleep persists a wake; the wake continues the same Pi session', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'CALL_TOOL roadie_sleep {"until":"2030-01-01T09:00:00Z","reason":"pi deploy"}',
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => Boolean(t.name?.startsWith('CALL_TOOL roadie_sleep')),
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000 })
    const sessionId = (await getThreadSession(thread.id))!
    expect(pi.owns(sessionId)).toBe(true)
    expect((await getSessionSleep({ sessionId }))?.status).toBe('planned')
    await wakeDueSessionSleeps({ rest: ctx.botClient.rest, now: new Date('2030-01-01T09:00:01Z') })
    await waitForBotMessageContaining({ discord: ctx.discord, threadId: thread.id, text: 'hello from the fake model', timeout: 20_000 })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000, afterMessageIncludes: 'hello from the fake model', afterAuthorId: ctx.discord.botUserId })
    expect(await getThreadSession(thread.id)).toBe(sessionId)
    expect((await getSessionSleep({ sessionId }))?.status).toBe('consumed')
    expect(await ctx.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
      "--- from: user (pi-tester)
      CALL_TOOL roadie_sleep {"until":"2030-01-01T09:00:00Z","reason":"pi deploy"}
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      -# ┣ roadie_sleep until 2030-01-01T09:00:00Z _pi deploy_

      tool said: Sleeping until 2030-01-01 09:00 UTC. Reason: pi deploy. This tool result is not a wake. Do not continue the waited work. Do not call more tools. Reply with one short line that you are waiting until that time, then stop. The real wake is a later Discord message that starts with "Woke after sleeping until". Only then continue the wait reason. A new user message in this thread cancels the sleep. If you still need that later wake after answering, call roadie_sleep again with until set to the same UTC time.
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*
      -# Woke after sleeping until 2030-01-01 09:00 UTC
      Reason: pi deploy
      Continue the work you were waiting for.
      [embed]
      hello from the fake model
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*"
    `)
  }, 60_000)

  test('roadie_file_upload shows the upload prompt; a new message ends the wait', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'CALL_TOOL roadie_file_upload {"prompt":"Send the pi config"}',
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => Boolean(t.name?.startsWith('CALL_TOOL roadie_file_upload')),
    })
    await waitForBotMessageContaining({ discord: ctx.discord, threadId: thread.id, text: 'Send the pi config', timeout: 20_000 })
    await ctx.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'never mind' })
    await waitForBotMessageContaining({ discord: ctx.discord, threadId: thread.id, text: 'No files were uploaded', timeout: 20_000 })
    // The queued "never mind" runs as its own turn after the tool turn ends.
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000, afterMessageIncludes: 'hello from the fake model', afterAuthorId: ctx.discord.botUserId })
    expect(await ctx.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
      "--- from: user (pi-tester)
      CALL_TOOL roadie_file_upload {"prompt":"Send the pi config"}
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      **File Upload Requested**
      Send the pi config
      _Cancelled - user sent a new message_
      --- from: user (pi-tester)
      never mind
      --- from: assistant (TestBot)
      tool said: No files were uploaded (user may have cancelled or sent a new message)
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*
      hello from the fake model
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*"
    `)
  }, 60_000)

  test('the question tool shows a dropdown; a pick answers it and the Pi turn continues', async () => {
    const questions = [{ question: 'Which runtime?', header: 'Runtime', options: [{ label: 'Pi', description: 'Small and fast' }, { label: 'OpenCode', description: 'The old one' }] }]
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: `CALL_TOOL question ${JSON.stringify({ questions })}` })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => Boolean(t.name?.startsWith('CALL_TOOL question')),
    })
    const th = ctx.discord.thread(thread.id)
    const start = Date.now()
    let dropdown: { messageId: string; customId: string } | undefined
    while (!dropdown && Date.now() - start < 20_000) {
      for (const message of await th.getMessages()) {
        const ids = JSON.stringify(message.components ?? []).match(/ask_question:[^"]+/)
        if (ids) dropdown = { messageId: message.id, customId: ids[0] }
      }
      if (!dropdown) await new Promise((r) => setTimeout(r, 100))
    }
    if (!dropdown) throw new Error('no question dropdown')
    const interaction = await th.user(TEST_USER_ID).selectMenu({ messageId: dropdown.messageId, customId: dropdown.customId, values: ['0'] })
    await th.waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
    await waitForBotMessageContaining({ discord: ctx.discord, threadId: thread.id, text: 'User has answered your questions', timeout: 20_000 })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000, afterMessageIncludes: 'User has answered your questions', afterAuthorId: ctx.discord.botUserId })
    const text = await th.text({ showInteractions: true })
    expect(text).toContain('tool said: User has answered your questions: "Which runtime?"="Pi"')
    expect(text).toMatchInlineSnapshot(`
      "--- from: user (pi-tester)
      CALL_TOOL question {"questions":[{"question":"Which runtime?","header":"Runtime","options":[{"label":"Pi","description":"Small and fast"},{"label":"OpenCode","description":"The old one"}]}]}
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      **Runtime**
      Which runtime?
      ✓ _Pi_
      [user selects dropdown: 0]
      » **pi-tester:** Pi
      tool said: User has answered your questions: "Which runtime?"="Pi". You can now continue with the user's answers in mind.
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*"
    `)
  }, 60_000)

  test('a typed message dismisses a pending question and runs as a new turn, like OpenCode', async () => {
    const questions = [{ question: 'Name the release?', header: 'Release', options: [{ label: 'Luna', description: 'gpt-6-luna' }] }]
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: `CALL_TOOL question ${JSON.stringify({ questions })}` })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
      predicate: (t) => Boolean(t.name?.includes('Name the release')),
    })
    await waitForBotMessageContaining({ discord: ctx.discord, threadId: thread.id, text: 'Name the release?', timeout: 20_000 })
    await ctx.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'call it Selene' })
    await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 20_000, afterMessageIncludes: 'call it Selene' })
    const pending = await pi.getBackend().sessions.questions!({ directory: ctx.directories.projectDirectory })
    expect(pending instanceof Error ? pending : pending.length).toBe(0)
    expect(await ctx.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
      "--- from: user (pi-tester)
      CALL_TOOL question {"questions":[{"question":"Name the release?","header":"Release","options":[{"label":"Luna","description":"gpt-6-luna"}]}]}
      --- from: assistant (TestBot)
      -# *using fake/fake-1*
      **Release**
      Name the release?
      --- from: user (pi-tester)
      call it Selene
      --- from: assistant (TestBot)
      hello from the fake model
      -# *project ⋅ main ⋅ Ns ⋅ fake-1*"
    `)
  }, 60_000)
})

