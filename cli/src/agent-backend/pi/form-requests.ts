// Pending MCP form elicitation requests for the Pi backend.
//
// A person-scoped MCP server may answer a tools/call with a form elicitation
// instead of a result. The Roadie Pi extension surfaces it as a `roadie:form`
// UI request; the backend turns that into a `form.asked` event (Discord shows
// the server's message with Accept / Decline / Cancel) and answers the
// extension with the person's decision.
//
// Consent integrity, in one place:
// - The form never consults permission rules or "always" decisions. Permission
//   rules decide whether a tool may run; only the person decides this form.
//   This module takes no rules and has no way to ask about them.
// - Only the asking person may accept or decline: the person key recorded
//   when their server was registered (addRemote `owner`) must match. Anyone
//   else, and any caller that cannot name a person, is refused. Cancel is
//   system-allowed without a person (timeout, abort, session end) because it
//   makes the server run nothing — but a cancel that claims a person key
//   still needs the right one.
// - A form may not wait forever: the timeout answers cancel.

import { AgentRequestError } from '../types.js'

export type McpFormAction = 'accept' | 'decline' | 'cancel'

export type McpFormAnswer = { action: McpFormAction; content?: Record<string, unknown> }

export type McpFormRequest = {
  requestId: string
  sessionId: string
  /** Person-scoped server the form's tool belongs to (`rpm_<hash>_<name>`). */
  server: string
  /** The MCP tool that triggered the form. */
  tool: string
  /** The server's form message, verbatim. */
  message: string
  /** The elicitation requestedSchema, as the server sent it. */
  schema: Record<string, unknown>
}

export type McpFormReply = { sessionId: string; requestId: string; action: McpFormAction }

export type McpFormOptions = {
  /** How long a form may wait for its person; expiry answers cancel. 0 or less disables. */
  timeoutMs?: number
  onAsked(form: McpFormRequest): void
  onReplied(reply: McpFormReply): void
}

type PendingForm = McpFormRequest & {
  /** The person whose server asked; the only person who may accept or decline. */
  owner?: string
  answer(answer: McpFormAnswer & { noAnswer?: boolean }): void
  timer?: ReturnType<typeof setTimeout>
}

export class McpFormRequests {
  private pending = new Map<string, PendingForm>()

  constructor(private readonly options: McpFormOptions) {}

  /** Record a form asked through the extension and announce it. */
  ask(form: McpFormRequest & { owner?: string; answer: (answer: McpFormAnswer & { noAnswer?: boolean }) => void }): void {
    const entry: PendingForm = { ...form }
    this.pending.set(form.requestId, entry)
    const timeoutMs = this.options.timeoutMs ?? 0
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        // Only still-pending forms settle; a answered form's timer is cleared.
        // A timeout is a no-answer cancel, not a person's decision.
        if (this.pending.get(form.requestId) === entry) this.settle(form.requestId, { action: 'cancel' }, true)
      }, timeoutMs)
      entry.timer.unref?.()
    }
    this.options.onAsked(shapeOf(entry))
  }

  /**
   * Answer a form on its person's behalf. Fails closed: a missing or
   * mismatched person cannot consent, and the form stays pending so the right
   * person can still answer it.
   */
  reply({ requestId, action, content, personKey }: {
    requestId: string
    action: McpFormAction
    content?: Record<string, unknown>
    /** The person answering; required to accept or decline. */
    personKey?: string
  }): void | AgentRequestError {
    const entry = this.pending.get(requestId)
    if (!entry) return new AgentRequestError({ detail: `No pending MCP form ${requestId}` })
    const refusal = this.refuses(entry, { action, personKey })
    if (refusal) return new AgentRequestError({ detail: refusal })
    this.settle(requestId, { action, ...(action === 'accept' && content && { content }) })
  }

  /** The reason a reply is refused, or undefined when it may proceed. */
  private refuses(entry: PendingForm, { action, personKey }: { action: McpFormAction; personKey?: string }): string | undefined {
    // System-initiated cancel (timeout, abort) names no person.
    if (personKey === undefined) return action === 'cancel' ? undefined : 'Only the person who was asked can answer this form.'
    if (action === 'cancel') return personKey === entry.owner ? undefined : 'Only the person who was asked can answer this form.'
    if (!entry.owner || personKey !== entry.owner) return 'Only the person who was asked can answer this form.'
    return undefined
  }

  /** Answer every open form of a session with cancel (abort, session end). */
  cancelForSession(sessionId: string): void {
    for (const requestId of [...this.pending.keys()]) {
      // Aborts are no-answer cancels, not a person's decision.
      if (this.pending.get(requestId)?.sessionId === sessionId) this.settle(requestId, { action: 'cancel' }, true)
    }
  }

  /** Whether a session has a form waiting (idle stop must not kill the process). */
  hasPendingFor(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true
    }
    return false
  }

  private settle(requestId: string, answer: McpFormAnswer, noAnswer = false): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.answer(noAnswer ? { ...answer, noAnswer: true } : answer)
    this.options.onReplied({ sessionId: entry.sessionId, requestId, action: answer.action })
  }
}

/** The wire shape of a pending form: no owner, no callbacks. */
function shapeOf(entry: PendingForm): McpFormRequest {
  return {
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    server: entry.server,
    tool: entry.tool,
    message: entry.message,
    schema: entry.schema,
  }
}
