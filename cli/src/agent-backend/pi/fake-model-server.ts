// A scripted OpenAI-compatible chat completions server for driving real Pi
// processes in tests, with no model quota. Pi reaches it as a custom provider
// (models.json, api "openai-completions").
//
// Replies come from matchers first (see FakeMatcher), then the built-in
// script: after a tool result, answer with the result text. A user message
// containing RUN_TOOL calls `bash` with the text after it; CALL_TOOL <name>
// <json> calls any tool with those arguments. Anything else gets a greeting.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

type ChatMessage = { role: string; content?: unknown; tool_call_id?: string }

/**
 * One streamed piece of a scripted reply. Same shape as the AI SDK stream
 * parts the OpenCode deterministic provider took, so its matchers port as-is.
 * `stream-start` and the text-start/end markers emit nothing; they keep
 * per-part delays aligned with the old scripts.
 */
export type FakePart =
  | { type: 'stream-start'; warnings?: unknown[] }
  | { type: 'text-start' | 'text-end'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: 'stop' | 'tool-calls' | 'length'; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }

export type FakeMatcher = {
  id: string
  enabled?: boolean
  /** Higher wins; ties keep list order. */
  priority?: number
  /** Every condition given must hold. Unset matches every request. */
  when?: {
    /** Role of the last message: 'user', 'assistant' or 'tool'. */
    lastMessageRole?: string
    /** Text of the latest user message, without Roadie's envelope (see typedText). */
    latestUserTextEquals?: string
    latestUserTextIncludes?: string
    latestUserTextRegex?: string
    /** Text of every message, joined. */
    promptTextIncludes?: string
    promptTextRegex?: string
    /** JSON of the whole request messages array (tool calls and ids included). */
    rawPromptIncludes?: string
    rawPromptRegex?: string
    /** Request carries no tools (e.g. a title or judge call). */
    toolsEmpty?: boolean
  }
  then:
    | {
        parts: FakePart[]
        /** Wait before each part, by index. */
        partDelaysMs?: number[]
        defaultPartDelayMs?: number
      }
    | {
        /** Fail the request with this HTTP status and error message. */
        error: { status: number; message: string }
        delayMs?: number
      }
}

export type FakeModelRequest = {
  /** Model id the client asked for (e.g. 'fake-1'). */
  model: string
  messages: ChatMessage[]
  tools: unknown[]
  /** Id of the matcher that answered, or 'script' for the built-in script. */
  matcher: string
  /** Set when the client hung up before the reply finished (an abort). */
  aborted: boolean
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('')
  return ''
}

/**
 * What the user typed: Roadie's envelope (the <discord-user> tag, whose
 * thread-name repeats the thread's first message, and <system-reminder>
 * blocks) removed, so a marker in a thread title does not match later turns.
 */
export function typedText(text: string): string {
  return text
    .replace(/<discord-user\b[^>]*\/>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim()
}

export function scriptedReply(messages: ChatMessage[]): { text: string } | { tool: string; args: Record<string, unknown> } {
  const last = messages.at(-1)
  if (last?.role === 'tool') return { text: `tool said: ${textOf(last.content).trim()}` }
  // The injection guard judge (a tool-less, system-prompted model call) always
  // reports a flagged tool output so tests can assert the redaction.
  if (messages.some((m) => textOf(m.content).includes('security-focused alignment analyst'))) {
    return { text: `{"flagged": true, "confidence": 0.99, "observation": "test injection"}` }
  }
  const user = [...messages].reverse().find((m) => m.role === 'user')
  const said = textOf(user?.content)
  const match = /RUN_TOOL (.+)$/m.exec(said)
  if (match) return { tool: 'bash', args: { command: match[1]!.trim() } }
  const call = /CALL_TOOL (\S+) (\{.*\})\s*$/m.exec(said)
  if (call) return { tool: call[1]!, args: JSON.parse(call[2]!) as Record<string, unknown> }
  return { text: 'hello from the fake model' }
}

function scriptParts(messages: ChatMessage[]): FakePart[] {
  const reply = scriptedReply(messages)
  if ('text' in reply) {
    return [
      ...reply.text.split(/(?<= )/).map((delta): FakePart => ({ type: 'text-delta', id: 'script', delta })),
      { type: 'finish', finishReason: 'stop' },
    ]
  }
  return [
    { type: 'tool-call', toolCallId: '', toolName: reply.tool, input: JSON.stringify(reply.args) },
    { type: 'finish', finishReason: 'tool-calls' },
  ]
}

export function matcherMatches(matcher: FakeMatcher, request: { messages: ChatMessage[]; tools?: unknown[] }): boolean {
  if (matcher.enabled === false) return false
  const when = matcher.when
  if (!when) return true
  const { messages } = request
  if (when.toolsEmpty && (request.tools?.length ?? 0) > 0) return false
  if (when.lastMessageRole && messages.at(-1)?.role !== when.lastMessageRole) return false
  const latestUser = typedText(textOf([...messages].reverse().find((m) => m.role === 'user')?.content))
  if (when.latestUserTextEquals !== undefined && latestUser !== when.latestUserTextEquals) return false
  if (when.latestUserTextIncludes !== undefined && !latestUser.includes(when.latestUserTextIncludes)) return false
  if (when.latestUserTextRegex !== undefined && !new RegExp(when.latestUserTextRegex).test(latestUser)) return false
  const promptText = messages.map((m) => textOf(m.content)).join('\n')
  if (when.promptTextIncludes !== undefined && !promptText.includes(when.promptTextIncludes)) return false
  if (when.promptTextRegex !== undefined && !new RegExp(when.promptTextRegex).test(promptText)) return false
  const raw = JSON.stringify(messages)
  if (when.rawPromptIncludes !== undefined && !raw.includes(when.rawPromptIncludes)) return false
  if (when.rawPromptRegex !== undefined && !new RegExp(when.rawPromptRegex).test(raw)) return false
  return true
}

export function findMatcher(matchers: FakeMatcher[], request: { messages: ChatMessage[]; tools?: unknown[] }): FakeMatcher | undefined {
  return matchers
    .map((matcher, index) => ({ matcher, index }))
    .sort((a, b) => (b.matcher.priority ?? 0) - (a.matcher.priority ?? 0) || a.index - b.index)
    .find(({ matcher }) => matcherMatches(matcher, request))?.matcher
}

const FINISH_REASONS: Record<string, string> = { 'tool-calls': 'tool_calls', stop: 'stop', length: 'length' }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function startFakeModelServer({ matchers = [] }: { matchers?: FakeMatcher[] } = {}): Promise<{
  baseUrl: string
  requests: number
  bodies: string[]
  /** Every request with the matcher that answered it, in arrival order. */
  log: FakeModelRequest[]
  close(): Promise<void>
}> {
  const state = { requests: 0, bodies: [] as string[], log: [] as FakeModelRequest[] }
  const server = http.createServer((req, res) => {
    let body = ''
    // Decode across chunks: a multi-byte character split between two chunks
    // must not turn into two replacement characters.
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', async () => {
      state.requests++
      state.bodies.push(body)
      const parsed = JSON.parse(body || '{}') as { model?: string; messages?: ChatMessage[]; tools?: unknown[] }
      const model = parsed.model ?? 'fake-1'
      const messages = parsed.messages ?? []
      const matcher = findMatcher(matchers, { messages, tools: parsed.tools })
      const entry: FakeModelRequest = { model, messages, tools: parsed.tools ?? [], matcher: matcher?.id ?? 'script', aborted: false }
      state.log.push(entry)
      // A client abort closes the socket; stop streaming into it.
      let closed = false
      res.on('close', () => {
        closed = true
        if (!res.writableFinished) entry.aborted = true
      })

      if (matcher && 'error' in matcher.then) {
        if (matcher.then.delayMs) await sleep(matcher.then.delayMs)
        res.writeHead(matcher.then.error.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: matcher.then.error.message, type: 'fake_error', code: matcher.then.error.status } }))
        return
      }

      // SLOW_REPLY in the pending user turn holds the response open, so tests
      // can act on a session mid-turn (e.g. abort a running task child).
      if (!matcher && messages.some((m) => m.role === 'user' && textOf(m.content).includes('SLOW_REPLY'))) {
        await sleep(1_500)
      }
      const then = matcher?.then && 'parts' in matcher.then ? matcher.then : undefined
      const parts = then ? then.parts : scriptParts(messages)

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
        if (!closed) res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      }
      chunk({ role: 'assistant' })
      let toolIndex = 0
      let finished = false
      let usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      for (const [index, part] of parts.entries()) {
        const delay = then?.partDelaysMs?.[index] ?? then?.defaultPartDelayMs ?? 0
        if (delay > 0) await sleep(delay)
        if (closed) return
        if (part.type === 'text-delta') chunk({ content: part.delta })
        else if (part.type === 'reasoning-delta') chunk({ reasoning_content: part.delta })
        else if (part.type === 'tool-call') {
          const id = part.toolCallId || `call_${state.requests}_${toolIndex}`
          chunk({ tool_calls: [{ index: toolIndex++, id, type: 'function', function: { name: part.toolName, arguments: part.input } }] })
        } else if (part.type === 'finish') {
          finished = true
          if (part.usage) usage = { prompt_tokens: part.usage.inputTokens, completion_tokens: part.usage.outputTokens, total_tokens: part.usage.totalTokens }
          chunk({}, FINISH_REASONS[part.finishReason])
        }
      }
      if (!finished) chunk({}, toolIndex > 0 ? 'tool_calls' : 'stop')
      if (closed) return
      res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model, choices: [], usage })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests
    },
    bodies: state.bodies,
    log: state.log,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** models.json content registering the fake server as provider "fake", models "fake-1" and "fake-2". */
export type FakeModel = {
  id: string
  name?: string
  /** A reasoning model offers thinking levels (Roadie's model variants). */
  reasoning?: boolean
}

/**
 * Two identical models by default, so tests can switch a session's model.
 * All are served by the same fake server under the `fake` provider.
 */
export function fakeModelsJson(
  baseUrl: string,
  { models = [{ id: 'fake-1' }, { id: 'fake-2' }] }: { models?: FakeModel[] } = {},
): string {
  return JSON.stringify({
    providers: {
      fake: {
        baseUrl,
        api: 'openai-completions',
        apiKey: 'fake',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: models.map(({ id, name, reasoning = false }) => ({ id, name: name ?? id.replace('fake-', 'Fake '), reasoning, input: ['text', 'image'], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      },
    },
  }, null, 2)
}
