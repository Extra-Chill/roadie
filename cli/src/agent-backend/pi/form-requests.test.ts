// Pending MCP form requests: speaker-only answers, timeout, and abort.

import { describe, expect, test, vi } from 'vitest'
import { AgentRequestError } from '../types.js'
import { McpFormRequests } from './form-requests.js'

function harness({ timeoutMs }: { timeoutMs?: number } = {}) {
  const answers: Array<{ requestId: string; answer: { action: string; content?: Record<string, unknown> } }> = []
  const asked: Array<{ requestId: string; server: string }> = []
  const replied: Array<{ requestId: string; action: string }> = []
  const forms = new McpFormRequests({
    timeoutMs,
    onAsked: (form) => asked.push({ requestId: form.requestId, server: form.server }),
    onReplied: (reply) => replied.push({ requestId: reply.requestId, action: reply.action }),
  })
  const ask = (requestId = 'ui-1', owner = 'wp:1') => forms.ask({
    requestId,
    sessionId: 'ses-1',
    server: 'rpm_abc123def456_wordpress',
    tool: 'buy-plan',
    message: 'Buy the pro plan?',
    schema: { type: 'object', properties: {} },
    owner,
    answer: (answer) => answers.push({ requestId, answer }),
  })
  return { forms, answers, asked, replied, ask }
}

describe('McpFormRequests', () => {
  test('asking announces the form; the person can accept with content', () => {
    const { forms, answers, asked, replied, ask } = harness()
    ask()
    expect(asked).toEqual([{ requestId: 'ui-1', server: 'rpm_abc123def456_wordpress' }])
    expect(forms.reply({ requestId: 'ui-1', action: 'accept', content: { confirm: true }, personKey: 'wp:1' })).toBeUndefined()
    expect(answers).toEqual([{ requestId: 'ui-1', answer: { action: 'accept', content: { confirm: true } } }])
    expect(replied).toEqual([{ requestId: 'ui-1', action: 'accept' }])
  })

  test('only the asking person can accept or decline', () => {
    const { forms, answers, ask } = harness()
    ask()
    const refused = forms.reply({ requestId: 'ui-1', action: 'accept', content: { confirm: true }, personKey: 'wp:2' })
    expect(refused).toBeInstanceOf(AgentRequestError)
    // The form is still pending: the right person can still answer.
    expect(forms.reply({ requestId: 'ui-1', action: 'decline', personKey: 'wp:1' })).toBeUndefined()
    expect(answers).toEqual([{ requestId: 'ui-1', answer: { action: 'decline' } }])
  })

  test('an unnamed caller cannot consent', () => {
    const { forms, answers, ask } = harness()
    ask()
    expect(forms.reply({ requestId: 'ui-1', action: 'accept', content: {} })).toBeInstanceOf(AgentRequestError)
    expect(forms.reply({ requestId: 'ui-1', action: 'decline' })).toBeInstanceOf(AgentRequestError)
    expect(answers).toEqual([])
    // But the system may cancel (timeout, abort path uses cancelForSession).
    expect(forms.reply({ requestId: 'ui-1', action: 'cancel' })).toBeUndefined()
    expect(answers).toEqual([{ requestId: 'ui-1', answer: { action: 'cancel' } }])
  })

  test('a cancel claiming the wrong person is refused', () => {
    const { forms, answers, ask } = harness()
    ask()
    expect(forms.reply({ requestId: 'ui-1', action: 'cancel', personKey: 'wp:2' })).toBeInstanceOf(AgentRequestError)
    expect(forms.reply({ requestId: 'ui-1', action: 'cancel', personKey: 'wp:1' })).toBeUndefined()
    expect(answers).toEqual([{ requestId: 'ui-1', answer: { action: 'cancel' } }])
  })

  test('a form without a recorded owner refuses every consent, failing closed', () => {
    const { forms, answers } = harness()
    forms.ask({
      requestId: 'ui-2',
      sessionId: 'ses-1',
      server: 'rpm_x_y',
      tool: 't',
      message: 'm',
      schema: {},
      answer: () => {},
    })
    expect(forms.reply({ requestId: 'ui-2', action: 'accept', content: {}, personKey: 'wp:1' })).toBeInstanceOf(AgentRequestError)
    expect(answers).toEqual([])
  })

  test('the timeout answers cancel', () => {
    vi.useFakeTimers()
    try {
      const { answers, replied, ask } = harness({ timeoutMs: 50 })
      ask()
      vi.advanceTimersByTime(60)
      expect(answers).toEqual([{ requestId: 'ui-1', answer: { action: 'cancel', noAnswer: true } }])
      expect(replied).toEqual([{ requestId: 'ui-1', action: 'cancel' }])
    } finally {
      vi.useRealTimers()
    }
  })

  test('an answered form does not fire its timeout again', () => {
    vi.useFakeTimers()
    try {
      const { forms, answers, ask } = harness({ timeoutMs: 50 })
      ask()
      forms.reply({ requestId: 'ui-1', action: 'decline', personKey: 'wp:1' })
      vi.advanceTimersByTime(100)
      expect(answers).toEqual([{ requestId: 'ui-1', answer: { action: 'decline' } }])
    } finally {
      vi.useRealTimers()
    }
  })

  test('abort cancels every open form of the session', () => {
    const { forms, answers, replied, ask } = harness()
    ask('ui-1')
    ask('ui-2')
    forms.cancelForSession('ses-1')
    expect(answers.map((entry) => entry.answer.action)).toEqual(['cancel', 'cancel'])
    expect(replied.map((entry) => entry.action)).toEqual(['cancel', 'cancel'])
    expect(forms.hasPendingFor('ses-1')).toBe(false)
  })

  test('an unknown request id is an error, not a crash', () => {
    const { forms } = harness()
    expect(forms.reply({ requestId: 'nope', action: 'cancel' })).toBeInstanceOf(AgentRequestError)
  })

  test('the form flow never consults permission rules: it answers with none in scope', () => {
    // Structural, but pinned: McpFormRequests.reply takes no rules and no
    // permission input, so a deny-all (or always-allow) ruleset cannot reach
    // the answer. The backend wiring (backend.ts) keeps decidePermission out
    // of the form path; the e2e suite proves the wiring.
    const { forms, answers, ask } = harness()
    ask()
    const denyEverything = [{ permission: '*', pattern: '*', action: 'deny' as const }]
    expect(denyEveryRule(denyEverything)).toBe(true)
    expect(forms.reply({ requestId: 'ui-1', action: 'accept', content: { confirm: true }, personKey: 'wp:1' })).toBeUndefined()
    expect(answers).toEqual([{ requestId: 'ui-1', answer: { action: 'accept', content: { confirm: true } } }])
  })
})

function denyEveryRule(rules: Array<{ action: string }>): boolean {
  return rules.every((rule) => rule.action === 'deny')
}
