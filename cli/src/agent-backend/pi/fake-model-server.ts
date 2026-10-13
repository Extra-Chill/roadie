// A scripted OpenAI-compatible chat completions server for driving real Pi
// processes in tests, with no model quota. Pi reaches it as a custom provider
// (models.json, api "openai-completions").
//
// Script: after a tool result, answer with the result text. A user message
// containing RUN_TOOL calls `bash` with the text after it; CALL_TOOL <name>
// <json> calls any tool with those arguments. Anything else gets a greeting.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

type ChatMessage = { role: string; content?: unknown; tool_call_id?: string }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('')
  return ''
}

export function scriptedReply(messages: ChatMessage[]): { text: string } | { tool: string; args: Record<string, unknown> } {
  const last = messages.at(-1)
  if (last?.role === 'tool') return { text: `tool said: ${textOf(last.content).trim()}` }
  const user = [...messages].reverse().find((m) => m.role === 'user')
  const said = textOf(user?.content)
  const match = /RUN_TOOL (.+)$/m.exec(said)
  if (match) return { tool: 'bash', args: { command: match[1]!.trim() } }
  const call = /CALL_TOOL (\S+) (\{.*\})\s*$/m.exec(said)
  if (call) return { tool: call[1]!, args: JSON.parse(call[2]!) as Record<string, unknown> }
  return { text: 'hello from the fake model' }
}

export async function startFakeModelServer(): Promise<{ baseUrl: string; requests: number; bodies: string[]; close(): Promise<void> }> {
  const state = { requests: 0, bodies: [] as string[] }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', async () => {
      state.requests++
      state.bodies.push(body)
      const parsed = JSON.parse(body || '{}') as { messages?: ChatMessage[] }
      // SLOW_REPLY in the pending user turn holds the response open, so tests
      // can act on a session mid-turn (e.g. abort a running task child).
      if ((parsed.messages ?? []).some((m) => m.role === 'user' && textOf(m.content).includes('SLOW_REPLY'))) {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
      }
      const reply = scriptedReply(parsed.messages ?? [])
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
        res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
      chunk({ role: 'assistant' })
      if ('text' in reply) {
        for (const word of reply.text.split(/(?<= )/)) chunk({ content: word })
        chunk({}, 'stop')
      } else {
        chunk({ tool_calls: [{ index: 0, id: `call_${state.requests}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] })
        chunk({}, 'tool_calls')
      }
      res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** models.json content registering the fake server as provider "fake", model "fake-1". */
export function fakeModelsJson(baseUrl: string): string {
  return JSON.stringify({
    providers: {
      fake: {
        baseUrl,
        api: 'openai-completions',
        apiKey: 'fake',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-1', name: 'Fake 1', reasoning: false, input: ['text', 'image'], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  }, null, 2)
}
