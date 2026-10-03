// E2e: host context provider output reaches the model.
// The deterministic provider only answers "context-seen" when the provider's
// marker is in the raw prompt OpenCode sends, so a reply proves the
// session_start context was pinned into the system prompt.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, test, expect } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { setContextProviderCommand } from './context-provider.js'
import { waitForBotMessageContaining } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001050'
const MARKER = 'HOST_CONTEXT_MARKER_7f3a'

describe('context provider', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-context-e2e-'))
    const provider = path.join(dir, 'provider.sh')
    fs.writeFileSync(
      provider,
      `#!/bin/sh\ncat >/dev/null\necho '{"sections":[{"id":"memory","title":"Host memory","content":"${MARKER}"}]}'\n`,
      { mode: 0o755 },
    )
    setContextProviderCommand(provider)
  })
  afterAll(() => {
    setContextProviderCommand(undefined)
  })

  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-context-provider-e2e',
    dirName: 'qa-context-provider-e2e',
    username: 'context-provider-tester',
    extraMatchers: [
      {
        id: 'host-context-seen',
        priority: 120,
        when: {
          latestUserTextIncludes: 'CONTEXT_PROBE',
          rawPromptIncludes: MARKER,
        },
        then: {
          parts: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'ctx' },
            { type: 'text-delta', id: 'ctx', delta: 'context-seen' },
            { type: 'text-end', id: 'ctx' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        },
      },
    ],
  })

  test('session_start context is in the prompt the model receives', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'CONTEXT_PROBE what do you know?',
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => t.name?.includes('CONTEXT_PROBE') ?? false,
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'context-seen',
      timeout: 8_000,
    })
    expect(await ctx.discord.thread(thread.id).text()).toContain('context-seen')
  }, 20_000)
})
