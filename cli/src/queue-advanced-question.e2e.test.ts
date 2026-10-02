// E2e test for question tool: user text message during pending question should
// dismiss the question (abort), then enqueue as a normal user prompt.
// The user's message must appear as a real user message in the thread, not
// get consumed as a tool result answer (which lost voice/image content).

import { describe, test, expect } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
  waitForFooterMessage,
} from './test-utils.js'
import { getOpencodeClient } from './opencode.js'
import { getThreadSession } from './database.js'
import type { Message, Part } from '@opencode-ai/sdk/v2'

const TEXT_CHANNEL_ID = '200000000000001007'

type SessionMessage = { info: Message; parts: Part[] }

function getOpencodeClientForTest(projectDirectory: string) {
  const client = getOpencodeClient(projectDirectory)
  if (!client) {
    throw new Error('OpenCode client not found for project directory')
  }
  return client
}

function getTextFromParts(parts: Part[]): string[] {
  return parts.flatMap((part) => {
    if (part.type === 'text') {
      return [part.text]
    }
    return []
  })
}

function normalizeSessionText(text: string): string {
  return text
    .replace(/\[current git branch is [^\]]+\]/g, '')
    .replace(/<discord-user[^>]*\/>/g, '<discord-user />')
    .trim()
}

function getSessionRoleTextTimeline(messages: SessionMessage[]) {
  return messages.flatMap((message) => {
    const text = normalizeSessionText(getTextFromParts(message.parts).join(''))
    if (!text.trim()) {
      return []
    }
    return [{ role: message.info.role, text }]
  })
}

function getSessionMessageSummary(messages: SessionMessage[]) {
  return messages.map((message) => {
    return {
      role: message.info.role,
      parts: message.parts.map((part) => {
        if (part.type === 'text') {
          return {
            type: part.type,
            text: normalizeSessionText(part.text),
          }
        }
        if (part.type === 'tool') {
          return {
            type: part.type,
            tool: part.tool,
            status: part.state.status,
            title: part.state.status === 'completed' ? part.state.title : undefined,
            output: part.state.status === 'completed' ? part.state.output : undefined,
          }
        }
        return { type: part.type }
      }),
    }
  })
}

async function waitForSessionMessages({
  projectDirectory,
  sessionId,
  timeoutMs,
  predicate,
}: {
  projectDirectory: string
  sessionId: string
  timeoutMs: number
  predicate: (messages: SessionMessage[]) => boolean
}): Promise<SessionMessage[]> {
  const client = getOpencodeClientForTest(projectDirectory)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const response = await client.session.messages({
      sessionID: sessionId,
      directory: projectDirectory,
    })
    const messages = response.data ?? []
    if (predicate(messages)) {
      return messages
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }

  const finalResponse = await client.session.messages({
    sessionID: sessionId,
    directory: projectDirectory,
  })
  return finalResponse.data ?? []
}

describe('queue advanced: question tool answer', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-e2e',
    dirName: 'qa-question-e2e',
    username: 'queue-question-tester',
  })

  test('user text message dismisses pending question and enqueues as normal prompt', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'QUESTION_TEXT_ANSWER_MARKER',
    })

    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 8_000,
      predicate: (t) => {
        return t.name === 'QUESTION_TEXT_ANSWER_MARKER'
      },
    })

    const th = ctx.discord.thread(thread.id)

    // Wait for the question dropdown message to appear in Discord.
    // This is the user-visible signal that the question tool fired and
    // roadie processed the event. Avoids polling internal Maps which
    // have timing sensitivity on slower CI hardware.
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      text: 'Which option do you prefer?',
      timeout: 12_000,
    })

    // User sends a text message while question is pending.
    // This should:
    // 1. Dismiss the pending question (cleanup context)
    // 2. Abort the blocked session so OpenCode unblocks
    // 3. Enqueue the message as a normal user prompt (not consumed as answer)
    const answer = 'Reply with exactly: question-text-answer-done'
    await th.user(TEST_USER_ID).sendMessage({
      content: answer,
    })

    await waitForBotReplyAfterUserMessage({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      userMessageIncludes: answer,
      timeout: 8_000,
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'ok',
      afterUserMessageIncludes: answer,
      timeout: 8_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 8_000,
      afterMessageIncludes: 'ok',
      afterAuthorId: ctx.discord.botUserId,
    })

    const timeline = await th.text({ showInteractions: true })

    // The user's text answer must appear in Discord
    expect(timeline).toContain(answer)
    expect(timeline).toContain('ok')
    // The original question must have appeared
    expect(timeline).toContain('Which option do you prefer?')
    // The user's marker message triggered the question
    expect(timeline).toContain('QUESTION_TEXT_ANSWER_MARKER')
  }, 20_000)
})
