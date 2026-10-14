import { describe, expect, test } from 'vitest'
import { buildRetiredSessionSeed } from './retired-session-seed.js'

const history = [
  { id: '1', author: 'chubes', fromBot: false, text: 'fix the footer' },
  { id: '2', author: 'Roadie', fromBot: true, text: 'Fixed in #12.' },
  { id: '3', author: 'chubes', fromBot: false, text: '   ' },
  { id: '4', author: 'chubes', fromBot: false, text: 'now ship it' },
]

describe('buildRetiredSessionSeed', () => {
  test('carries the thread oldest first, minus the triggering message and blanks', () => {
    expect(buildRetiredSessionSeed({
      retiredSessionId: 'ses_old',
      retiredBackend: 'OpenCode',
      history,
      excludeMessageId: '4',
    })).toMatchInlineSnapshot(`
      "[Session moved] This thread was running on OpenCode (session ses_old), which Roadie no longer uses. This is a new session.
      Files, tool results, todos and the earlier session's full transcript did not carry over; only the chat messages below did. Re-read files before relying on them.
      Recent thread messages, oldest first:

      chubes: fix the footer
      assistant: Fixed in #12."
    `)
  })

  test('keeps the newest messages within the budget and says older ones were dropped', () => {
    const seed = buildRetiredSessionSeed({ retiredSessionId: 'ses_old', retiredBackend: 'OpenCode', history, maxChars: 30 })
    expect(seed).toContain('(older ones omitted)')
    expect(seed).toContain('chubes: now ship it')
    expect(seed).not.toContain('fix the footer')
  })

  test('says when the history could not be read', () => {
    expect(buildRetiredSessionSeed({ retiredSessionId: 'ses_old', retiredBackend: 'OpenCode', history: new Error('x') }))
      .toContain('could not be read')
    expect(buildRetiredSessionSeed({ retiredSessionId: 'ses_old', retiredBackend: 'OpenCode', history: undefined }))
      .toContain('could not be read')
    expect(buildRetiredSessionSeed({ retiredSessionId: 'ses_old', retiredBackend: 'OpenCode', history: [] }))
      .toContain('no earlier messages')
  })
})
