// E2e regression test for action button click continuation in thread sessions.
// Reproduces the bug where button click interaction acks but the session does not continue.

import { describe, test, expect } from 'vitest'
import { findPi } from './agent-backend/pi/find-pi.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'
import { getDb, getThreadSession, listPendingActionButtons } from './database.js'
import { pending_action_buttons } from './schema.js'
import { eq } from 'drizzle-orm'
import { cancelPendingActionButtons, showActionButtons } from './commands/action-buttons.js'
import { disposeRuntime } from './session-handler/runtime-registry.js'

const TEXT_CHANNEL_ID = '200000000000001006'

async function waitForPendingActionButtons({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<{ contextHash: string; messageId: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const [entry] = await listPendingActionButtons(threadId)
    if (entry) {
      return { contextHash: entry.context_hash, messageId: entry.message_id }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for pending action buttons context')
}

describe.skipIf(!findPi())('queue advanced: action buttons', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-action-buttons-e2e',
    dirName: 'qa-action-buttons-e2e',
    username: 'queue-action-tester',
  })

  for (const restart of [false, true]) {
    test(`button click continues the session with a follow-up assistant reply (restart: ${restart})`, async () => {
      await ctx.discord
        .channel(TEXT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .sendMessage({
          content: `Reply with exactly: action-button-setup${restart ? '-restart' : ''}`,
        })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === `Reply with exactly: action-button-setup${restart ? '-restart' : ''}`
        },
      })

      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: ctx.discord.botUserId,
      })

      const currentSessionId = await getThreadSession(thread.id)
      if (!currentSessionId) {
        throw new Error('Expected thread session id before showing action buttons')
      }

      const channel = await ctx.botClient.channels.fetch(thread.id)
      if (!channel || !channel.isThread()) {
        throw new Error('Expected Discord thread channel for action button test')
      }

      // Leave no live runtime holding the old Discord client. Posting buttons
      // does not require a runtime; the click must recreate it from storage.
      if (restart) {
        disposeRuntime(thread.id)
        await cancelPendingActionButtons(thread.id)
      }
      await showActionButtons({
        thread: channel,
        sessionId: currentSessionId,
        directory: ctx.directories.projectDirectory,
        buttons: [{ label: 'Continue action-buttons flow', color: 'green' }],
      })

      const action = await waitForPendingActionButtons({
        threadId: thread.id,
        timeoutMs: 12_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Action Required',
        timeout: 12_000,
      })

      if (restart) {
        await ctx.restartBot()
        ctx.botClient.channels.cache.delete(thread.id)
      }
      expect(await listPendingActionButtons(thread.id)).toHaveLength(1)

      const interaction = await th.user(TEST_USER_ID).clickButton({
        messageId: action.messageId,
        customId: `action_button:${action.contextHash}:0`,
      })

      await th.waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 4_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'action-buttons-click-continued',
        timeout: 12_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'action-buttons-click-continued',
        afterAuthorId: ctx.discord.botUserId,
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline.replace('action-button-setup-restart', 'action-button-setup'))
        .toMatchInlineSnapshot(`
        "--- from: user (queue-action-tester)
        Reply with exactly: action-button-setup
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        **Action Required**
        _Selected: Continue action-buttons flow_
        [user clicks button]
        » **queue-action-tester:** Continue action-buttons flow
        action-buttons-click-continued
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
      expect(timeline).toContain('action-buttons-click-continued')
    }, 20_000)
  }

  test('replaces older buttons, preserves them across typed replies, and expires or dismisses pending sets', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'Reply with exactly: action-button-dismiss-setup',
    })

    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => {
        return t.name === 'Reply with exactly: action-button-dismiss-setup'
      },
    })

    const th = ctx.discord.thread(thread.id)

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'ok',
      timeout: 4_000,
    })

    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 4_000,
      afterMessageIncludes: 'ok',
      afterAuthorId: ctx.discord.botUserId,
    })

    const currentSessionId = await getThreadSession(thread.id)
    if (!currentSessionId) {
      throw new Error('Expected thread session id before showing action buttons')
    }

    const channel = await ctx.botClient.channels.fetch(thread.id)
    if (!channel || !channel.isThread()) {
      throw new Error('Expected Discord thread channel for action button test')
    }

    await showActionButtons({
      thread: channel,
      sessionId: currentSessionId,
      directory: ctx.directories.projectDirectory,
      buttons: [{ label: 'Earlier choice', color: 'white' }],
    })
    await waitForPendingActionButtons({
      threadId: thread.id,
      timeoutMs: 4_000,
    })

    await showActionButtons({
      thread: channel,
      sessionId: currentSessionId,
      directory: ctx.directories.projectDirectory,
      buttons: [{ label: 'Dismiss me', color: 'white' }],
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      text: 'Replaced.',
      timeout: 4_000,
    })
    expect(
      (await listPendingActionButtons(thread.id)).map((context) => context.buttons[0]?.label),
    ).toEqual(['Dismiss me'])

    await th.user(TEST_USER_ID).sendMessage({
      content: 'Reply with exactly: post-dismiss-user-message',
    })

    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 4_000,
      afterMessageIncludes: 'post-dismiss-user-message',
      afterAuthorId: TEST_USER_ID,
    })
    const action = await waitForPendingActionButtons({
      threadId: thread.id,
      timeoutMs: 4_000,
    })

    const interaction = await th.user(TEST_USER_ID).clickButton({
      messageId: action.messageId,
      customId: `action_button:${action.contextHash}:0`,
    })
    await th.waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 12_000,
      afterMessageIncludes: 'Dismiss me',
      afterAuthorId: ctx.discord.botUserId,
    })

    const timeline = await th.text({ showInteractions: true })
    expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (queue-action-tester)
        Reply with exactly: action-button-dismiss-setup
        --- from: assistant (TestBot)
        -# *using fake/fake-1*
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        **Action Required**
        _Replaced._
        **Action Required**
        _Selected: Dismiss me_
        --- from: user (queue-action-tester)
        Reply with exactly: post-dismiss-user-message
        --- from: assistant (TestBot)
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*
        [user clicks button]
        » **queue-action-tester:** Dismiss me
        ok
        -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ fake-1*"
      `)
    expect(timeline).toContain('post-dismiss-user-message')

    await showActionButtons({
      thread: channel,
      sessionId: currentSessionId,
      directory: ctx.directories.projectDirectory,
      buttons: [{ label: 'Expired choice' }],
    })
    const expired = await waitForPendingActionButtons({ threadId: thread.id, timeoutMs: 4_000 })
    const db = await getDb()
    await db
      .update(pending_action_buttons)
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where(eq(pending_action_buttons.context_hash, expired.contextHash))
    const expiredClick = await th.user(TEST_USER_ID).clickButton({
      messageId: expired.messageId,
      customId: `action_button:${expired.contextHash}:0`,
    })
    await th.waitForInteractionAck({ interactionId: expiredClick.id, timeout: 4_000 })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      text: '_Expired_',
      timeout: 4_000,
    })
    expect(await listPendingActionButtons(thread.id)).toEqual([])

    await showActionButtons({
      thread: channel,
      sessionId: currentSessionId,
      directory: ctx.directories.projectDirectory,
      buttons: [{ label: 'Dismiss on disposal' }],
    })
    disposeRuntime(thread.id)
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      text: '_Buttons dismissed._',
      timeout: 4_000,
    })
    expect(await listPendingActionButtons(thread.id)).toEqual([])
  }, 20_000)
})
