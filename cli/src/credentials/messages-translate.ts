// Anthropic Messages <-> any pi-ai wire format, for pool candidates that do
// not speak Anthropic Messages (#276).
//
// The pool proxy's one client-facing wire is Anthropic Messages. When a
// rotation's candidate is an API-key provider (OpenAI-compatible chat
// completions) or a ChatGPT subscription (Codex Responses), the proxy turns
// the Anthropic request into a pi-ai Context, lets pi-ai's own provider speak
// the upstream wire (its per-provider compat: z.ai roles, max_tokens field,
// Codex request shape), and writes pi-ai's events back as Anthropic Messages.
//
// Two cross-format rules, both pi-ai's own model-switch semantics:
//   - Translated thinking goes back unsigned. Pi replays an unsigned thinking
//     block as plain text, exactly as pi-ai's transformMessages turns a
//     foreign model's thinking into text, so it is valid on every route.
//   - Tool call ids are normalized the way pi-ai's Anthropic adapter does,
//     so a call made on one format can be answered on any other.

import crypto from 'node:crypto'
import type http from 'node:http'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai'
import { getModel } from '@earendil-works/pi-ai/compat'

type Json = Record<string, unknown>
type Block = Json & { type?: unknown }

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What a translated upstream call needs from the Anthropic request besides its Context. */
export type TranslatedRequest = {
  context: Context
  stream: boolean
  maxTokens?: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const blocks = (content: unknown): Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : []

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function image(block: Block): ImageContent | undefined {
  const source = block['source'] as Json | undefined
  if (source?.['type'] !== 'base64' || typeof source['data'] !== 'string') return undefined
  return { type: 'image', data: source['data'], mimeType: text(source['media_type']) || 'image/png' }
}

function userParts(content: Block[]): (TextContent | ImageContent)[] {
  return content.flatMap((block): (TextContent | ImageContent)[] => {
    if (block.type === 'text') return [{ type: 'text', text: text(block['text']) }]
    if (block.type === 'image') {
      const part = image(block)
      return part ? [part] : []
    }
    return []
  })
}

/** Anthropic thinking config to a pi-ai reasoning effort; undefined leaves reasoning off. */
function reasoningEffort(payload: Json): ReasoningEffort | undefined {
  const thinking = payload['thinking'] as Json | undefined
  if (!thinking || thinking['type'] === 'disabled') return undefined
  const effort = (payload['output_config'] as Json | undefined)?.['effort']
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') return effort
  const budget = thinking['budget_tokens']
  if (typeof budget === 'number') return budget < 4_096 ? 'low' : budget < 16_384 ? 'medium' : 'high'
  return 'medium'
}

/** Translate an Anthropic Messages request body into a pi-ai Context and call options. */
export function anthropicRequestToContext(payload: Json, now: number = Date.now()): TranslatedRequest {
  const system = blocks(payload['system']).map((block) => text(block['text'])).filter(Boolean).join('\n\n')
  const toolNames = new Map<string, string>()
  const messages: Message[] = []
  for (const message of Array.isArray(payload['messages']) ? (payload['messages'] as Json[]) : []) {
    const content = blocks(message['content'])
    if (message['role'] === 'assistant') {
      const parts = content.flatMap((block): (TextContent | ThinkingContent | ToolCall)[] => {
        if (block.type === 'text') return [{ type: 'text', text: text(block['text']) }]
        if (block.type === 'thinking') return [{ type: 'thinking', thinking: text(block['thinking']), thinkingSignature: text(block['signature']) }]
        if (block.type === 'redacted_thinking') return [{ type: 'thinking', thinking: '', thinkingSignature: text(block['data']), redacted: true }]
        if (block.type === 'tool_use') {
          const id = text(block['id'])
          toolNames.set(id, text(block['name']))
          return [{ type: 'toolCall', id, name: text(block['name']), arguments: (block['input'] as ToolCall['arguments']) ?? {} }]
        }
        return []
      })
      messages.push({
        role: 'assistant',
        content: parts,
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: text(payload['model']),
        usage: ZERO_USAGE,
        stopReason: parts.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: now,
      })
      continue
    }
    // Anthropic carries tool results inside the user turn; pi-ai has a message per result.
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const id = text(block['tool_use_id'])
      const result: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: id,
        toolName: toolNames.get(id) ?? '',
        content: userParts(blocks(block['content'])),
        isError: block['is_error'] === true,
        timestamp: now,
      }
      messages.push(result)
    }
    const parts = userParts(content)
    if (parts.length > 0) messages.push({ role: 'user', content: parts, timestamp: now })
  }
  const tools = Array.isArray(payload['tools'])
    ? (payload['tools'] as Json[])
        .filter((tool) => typeof tool['name'] === 'string' && tool['input_schema'])
        .map((tool): Tool => ({ name: text(tool['name']), description: text(tool['description']), parameters: tool['input_schema'] as Tool['parameters'] }))
    : []
  const effort = reasoningEffort(payload)
  return {
    context: { ...(system && { systemPrompt: system }), messages, ...(tools.length > 0 && { tools }) },
    stream: payload['stream'] === true,
    ...(typeof payload['max_tokens'] === 'number' && { maxTokens: payload['max_tokens'] }),
    ...(typeof payload['temperature'] === 'number' && { temperature: payload['temperature'] }),
    ...(effort && { reasoningEffort: effort }),
  }
}

/**
 * The pi-ai model a pool candidate is served as: pi-ai's catalog entry when it
 * knows the provider and model (its compat is exact), otherwise a generic
 * model whose compat pi-ai detects from the base URL.
 */
export function piModelFor({ api, provider, modelId, baseUrl }: { api: Api; provider: string; modelId: string; baseUrl: string }): Model<Api> {
  let known: Model<Api> | undefined
  try {
    known = getModel(provider as never, modelId as never) as Model<Api> | undefined
  } catch {}
  if (known && known.api === api) return { ...known, baseUrl }
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** pi-ai's Anthropic tool id rule, applied to ids from any format. */
export function anthropicToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `toolu_${crypto.randomBytes(8).toString('hex')}`
}

const STOP_REASONS: Partial<Record<StopReason, string>> = { stop: 'end_turn', length: 'max_tokens', toolUse: 'tool_use' }

function anthropicUsage(usage: Usage) {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  }
}

/** A finished pi-ai message as an Anthropic Messages response body (non-streaming requests). */
export function anthropicMessage({ message, model }: { message: AssistantMessage; model: string }): Json {
  return {
    id: `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: message.content.flatMap((part): Json[] => {
      if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : []
      if (part.type === 'thinking') return part.thinking && !part.redacted ? [{ type: 'thinking', thinking: part.thinking, signature: '' }] : []
      return [{ type: 'tool_use', id: anthropicToolId(part.id), name: part.name, input: part.arguments }]
    }),
    stop_reason: STOP_REASONS[message.stopReason] ?? 'end_turn',
    stop_sequence: null,
    usage: anthropicUsage(message.usage),
  }
}

/**
 * Writes pi-ai events to a client as an Anthropic Messages SSE stream. Text
 * and thinking stream as they arrive; a tool call is sent whole when pi-ai
 * finishes it, because its id and name are only certain then.
 */
export function anthropicStreamWriter({ res, model }: { res: http.ServerResponse; model: string }) {
  const indexes = new Map<number, number>()
  let next = 0
  let started = false
  const send = (event: string, data: Json) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const start = () => {
    if (started) return
    started = true
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    send('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }
  const open = (contentIndex: number, block: Json) => {
    start()
    const index = next++
    indexes.set(contentIndex, index)
    send('content_block_start', { type: 'content_block_start', index, content_block: block })
  }
  const close = (contentIndex: number) => {
    const index = indexes.get(contentIndex)
    if (index === undefined) return
    indexes.delete(contentIndex)
    send('content_block_stop', { type: 'content_block_stop', index })
  }
  const delta = (contentIndex: number, value: Json) => {
    const index = indexes.get(contentIndex)
    if (index !== undefined) send('content_block_delta', { type: 'content_block_delta', index, delta: value })
  }
  return {
    get started() {
      return started
    },
    /** Write one event; returns true once the stream has ended (done or error). */
    write(event: AssistantMessageEvent): boolean {
      switch (event.type) {
        case 'text_start':
          open(event.contentIndex, { type: 'text', text: '' })
          return false
        case 'text_delta':
          delta(event.contentIndex, { type: 'text_delta', text: event.delta })
          return false
        case 'thinking_start':
          open(event.contentIndex, { type: 'thinking', thinking: '' })
          return false
        case 'thinking_delta':
          delta(event.contentIndex, { type: 'thinking_delta', thinking: event.delta })
          return false
        case 'text_end':
        case 'thinking_end':
          close(event.contentIndex)
          return false
        case 'toolcall_end': {
          const { id, name, arguments: input } = event.toolCall
          open(event.contentIndex, { type: 'tool_use', id: anthropicToolId(id), name, input: {} })
          delta(event.contentIndex, { type: 'input_json_delta', partial_json: JSON.stringify(input ?? {}) })
          close(event.contentIndex)
          return false
        }
        case 'done': {
          start()
          for (const contentIndex of [...indexes.keys()]) close(contentIndex)
          send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: STOP_REASONS[event.message.stopReason] ?? 'end_turn', stop_sequence: null },
            usage: anthropicUsage(event.message.usage),
          })
          send('message_stop', { type: 'message_stop' })
          res.end()
          return true
        }
        case 'error': {
          start()
          send('error', { type: 'error', error: { type: 'api_error', message: event.error.errorMessage ?? 'upstream error' } })
          res.end()
          return true
        }
        default:
          return false
      }
    },
  }
}
