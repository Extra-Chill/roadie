import { describe, expect, test, vi } from 'vitest'
import type { AgentBackend } from '../agent-backend/types.js'
import type { ChatThread } from '../chat-platform/types.js'
import { buildRetiredSessionSeed, RETIRED_SEED_HISTORY_LIMIT, seedFromRetiredSession } from './retired-session-seed.js'

const history = [
  { id: '1', author: 'chubes', fromBot: false, text: 'fix the footer' },
  { id: '2', author: 'Roadie', fromBot: true, text: 'Fixed in #12.' },
  { id: '3', author: 'chubes', fromBot: false, text: '   ' },
  { id: '4', author: 'chubes', fromBot: false, text: 'now ship it' },
]

describe('seedFromRetiredSession', () => {
  test.each([false, true])('seeds before notifying, even with returned errors: %s', async (fail) => {
    const order: string[] = []
    const prompt = vi.fn(async () => {
      order.push('prompt')
      return fail ? new Error('backend unavailable') : undefined
    })
    const readRecentMessages = vi.fn(async () => fail ? new Error('history unavailable') : history)
    const sendNotice = vi.fn(async () => { order.push('notice') })
    const client = { sessions: { prompt } } as unknown as AgentBackend
    const chat = { readRecentMessages, sendNotice } as unknown as ChatThread

    await seedFromRetiredSession(client, chat, 'thread', '/checkout', 'new', 'old', '4')

    expect(readRecentMessages).toHaveBeenCalledWith(RETIRED_SEED_HISTORY_LIMIT)
    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'new', directory: '/checkout', noReply: true,
      parts: [{ kind: 'text', synthetic: true, text: buildRetiredSessionSeed({
        retiredSessionId: 'old', history: fail ? new Error('history unavailable') : history, excludeMessageId: '4',
      }) }],
    })
    expect(order).toEqual(['prompt', 'notice'])
    expect(sendNotice).toHaveBeenCalledWith(expect.stringContaining("earlier session can't be resumed"))
  })

  test('supports platforms without history reads', async () => {
    const prompt = vi.fn(async () => undefined)
    const sendNotice = vi.fn(async () => undefined)
    await seedFromRetiredSession(
      { sessions: { prompt } } as unknown as AgentBackend,
      { sendNotice } as unknown as ChatThread, 'thread', '/checkout', 'new', 'old',
    )
    expect(prompt.mock.calls[0]).toBeDefined()
    expect(sendNotice).toHaveBeenCalledOnce()
  })
})

describe('buildRetiredSessionSeed', () => {
  test('carries the thread oldest first, minus the triggering message and blanks', () => {
    expect(buildRetiredSessionSeed({
      retiredSessionId: 'ses_old',
      history,
      excludeMessageId: '4',
    })).toMatchInlineSnapshot(`
      "[Session moved] This thread was running session ses_old, which the current agent backend cannot resume. This is a new session.
      Files, tool results, todos and the earlier session's full transcript did not carry over; only the chat messages below did. Re-read files before relying on them.
      Recent thread messages, oldest first:

      chubes: fix the footer
      assistant: Fixed in #12."
    `)
  })

  test('keeps the newest messages within the budget and says older ones were dropped', () => {
    const seed = buildRetiredSessionSeed({ retiredSessionId: 'ses_old', history, maxChars: 30 })
    expect(seed).toContain('(older ones omitted)')
    expect(seed).toContain('chubes: now ship it')
    expect(seed).not.toContain('fix the footer')
  })

  test('says when the history could not be read', () => {
    expect(buildRetiredSessionSeed({ retiredSessionId: 'ses_old', history: new Error('x') }))
      .toContain('could not be read')
    expect(buildRetiredSessionSeed({ retiredSessionId: 'ses_old', history: undefined }))
      .toContain('could not be read')
    expect(buildRetiredSessionSeed({ retiredSessionId: 'ses_old', history: [] }))
      .toContain('no earlier messages')
  })
})
