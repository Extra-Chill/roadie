// A small stateless MCP client for the 2026-07-28 protocol revision, used by
// the Roadie Pi extension for person-scoped remote servers that advertise it
// (WordPress.com MCP v2 is the first target; nothing here is server-specific).
//
// Why a second client: Pi's built-in MCP client (pi-mcp) speaks protocol
// revisions up to 2025-11-25 and declares no elicitation, so servers that
// drive form elicitation refuse form-only operations. The 2026-07-28 revision
// is stateless JSON POST: every request carries `_meta` (protocol version,
// client capabilities, client info) and the `MCP-Protocol-Version`,
// `Mcp-Method` and `Mcp-Name` headers. A `tools/call` may answer
// `resultType: "input_required"` with form elicitation requests and a signed
// `requestState`; the continuation repeats the same call with `inputResponses`
// and that `requestState`.
//
// Auth tokens only ever travel in request headers and are never logged.
// This module is imported by the Pi extension: no Roadie imports.

/** The only protocol revision this client speaks. */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'

/** The client identity every request carries. */
export const MCP_CLIENT_NAME = 'roadie'

export type NativeMcpFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * The `_meta` object every request must carry: the protocol version, the
 * client capabilities (this client answers form elicitation only) and the
 * client info.
 */
export function buildRequestMeta({ version }: { version: string }): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
    [META_CLIENT_CAPABILITIES]: { elicitation: { form: {} } },
    [META_CLIENT_INFO]: { name: MCP_CLIENT_NAME, version },
  }
}

/** Headers for one request. `toolName` (and the resource/prompt names) go on the calls that name an object. */
export function buildRequestHeaders({ method, toolName }: { method: string; toolName?: string }): Record<string, string> {
  return {
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    'Mcp-Method': method,
    ...(toolName && { 'Mcp-Name': toolName }),
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  }
}

/** One JSON-RPC request over stateless HTTP POST; resolves the result or an Error carrying the server's code. */
export async function nativeMcpRequest({
  url,
  headers,
  method,
  params,
  fetchImpl = fetch,
  timeoutMs = 120_000,
  signal,
}: {
  url: string
  headers: Record<string, string>
  method: string
  params: Record<string, unknown>
  fetchImpl?: NativeMcpFetch
  timeoutMs?: number
  /** The calling tool's abort signal: an aborted turn aborts the request. */
  signal?: AbortSignal
}): Promise<Record<string, unknown> | Error> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      // Auth headers (the bearer token) are caller-supplied; never logged.
      headers: {
        ...headers,
        ...buildRequestHeaders({ method, ...(typeof params.name === 'string' && { toolName: params.name }) }),
      },
      body,
      signal: controller.signal,
    })
  } catch (error) {
    return new Error(`${method} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
  if (!response.ok) {
    return new Error(`${method} failed with HTTP ${response.status}`)
  }
  let parsed: unknown
  try {
    const contentType = String(response.headers.get('content-type') ?? '')
    const text = await response.text()
    parsed = contentType.includes('text/event-stream') ? sseDataPayload(text) : JSON.parse(text)
  } catch (error) {
    return new Error(`${method} returned an unreadable body: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Error(`${method} returned no JSON-RPC response`)
  }
  const message = parsed as { result?: unknown; error?: { code?: unknown; message?: unknown } }
  if ('error' in message && message.error && typeof message.error === 'object') {
    const code = typeof message.error.code === 'number' ? message.error.code : undefined
    const detail = typeof message.error.message === 'string' ? message.error.message : 'request failed'
    const error = new Error(`${method} failed: ${detail}`)
    ;(error as Error & { code?: number }).code = code
    return error
  }
  if (!('result' in message) || !message.result || typeof message.result !== 'object') {
    return new Error(`${method} returned no result`)
  }
  return message.result as Record<string, unknown>
}

/** The JSON-RPC payload inside a `data:` line of an SSE body (the last one wins). */
function sseDataPayload(text: string): unknown {
  let parsed: unknown
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      parsed = JSON.parse(line.slice(5).trim())
    } catch {}
  }
  return parsed
}

export type NativeMcpDiscover = {
  supportedVersions: string[]
  capabilities?: Record<string, unknown>
  instructions?: string
}

/** `server/discover`: which protocol revisions and features the server offers. */
export async function discoverServer({
  url,
  headers,
  version,
  fetchImpl,
}: {
  url: string
  headers: Record<string, string>
  version: string
  fetchImpl?: NativeMcpFetch
}): Promise<NativeMcpDiscover | Error> {
  const result = await nativeMcpRequest({
    url,
    headers,
    method: 'server/discover',
    params: { _meta: buildRequestMeta({ version }) },
    fetchImpl,
  })
  if (result instanceof Error) return result
  const supportedVersions = Array.isArray(result.supportedVersions)
    ? result.supportedVersions.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    supportedVersions,
    ...(result.capabilities && typeof result.capabilities === 'object' ? { capabilities: result.capabilities as Record<string, unknown> } : {}),
    ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {}),
  }
}

/** True when the server speaks the revision this client implements. */
export function supportsNativeProtocol(discover: NativeMcpDiscover): boolean {
  return discover.supportedVersions.includes(MCP_PROTOCOL_VERSION)
}

export type NativeMcpTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** `tools/list` for a stateless server. */
export async function listTools({
  url,
  headers,
  version,
  fetchImpl,
}: {
  url: string
  headers: Record<string, string>
  version: string
  fetchImpl?: NativeMcpFetch
}): Promise<NativeMcpTool[] | Error> {
  const result = await nativeMcpRequest({
    url,
    headers,
    method: 'tools/list',
    params: { _meta: buildRequestMeta({ version }) },
    fetchImpl,
  })
  if (result instanceof Error) return result
  if (!Array.isArray(result.tools)) return new Error('tools/list returned no tools array')
  return result.tools.flatMap((tool): NativeMcpTool[] => {
    if (!tool || typeof tool !== 'object' || typeof (tool as NativeMcpTool).name !== 'string') return []
    const entry = tool as NativeMcpTool
    return [{
      name: entry.name,
      ...(typeof entry.description === 'string' && { description: entry.description }),
      ...(entry.inputSchema && typeof entry.inputSchema === 'object' ? { inputSchema: entry.inputSchema as Record<string, unknown> } : {}),
    }]
  })
}

/** One answer to a form elicitation. Content is only sent with accept. */
export type NativeFormAnswer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }

/**
 * A form answer for the wire: accept with empty (or no) content sends no
 * content at all — servers treat a bare accept as "approve as asked".
 */
export function buildFormAnswer({ action, content }: { action: NativeFormAnswer['action']; content?: Record<string, unknown> }): NativeFormAnswer {
  const filled = content && typeof content === 'object' && Object.keys(content).length > 0 ? content : undefined
  return action === 'accept' && filled ? { action, content: filled } : { action }
}

export type NativeInputRequest = {
  method?: string
  params?: {
    mode?: string
    message?: string
    requestedSchema?: Record<string, unknown>
  }
}

export type NativeCallContinuation = {
  inputResponses: Record<string, NativeFormAnswer>
  requestState: unknown
}

export type NativeCallResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>
  isError?: boolean
  structuredContent?: unknown
  /** Present when the server wants input before it will run the operation. */
  inputRequired?: {
    inputRequests: Record<string, NativeInputRequest>
    requestState: unknown
  }
}

/** The `tools/call` result, normalized; `resultType: "input_required"` becomes `inputRequired`. */
export async function callTool({
  url,
  headers,
  version,
  tool,
  args,
  continuation,
  fetchImpl,
  signal,
}: {
  url: string
  headers: Record<string, string>
  version: string
  tool: string
  args: Record<string, unknown>
  continuation?: NativeCallContinuation
  fetchImpl?: NativeMcpFetch
  signal?: AbortSignal
}): Promise<NativeCallResult | Error> {
  const result = await nativeMcpRequest({
    url,
    headers,
    method: 'tools/call',
    params: {
      _meta: buildRequestMeta({ version }),
      name: tool,
      arguments: args,
      ...(continuation && { inputResponses: continuation.inputResponses, requestState: continuation.requestState }),
    },
    fetchImpl,
    signal,
  })
  if (result instanceof Error) return result
  if (result.resultType === 'input_required') {
    const inputRequests = result.inputRequests && typeof result.inputRequests === 'object' && !Array.isArray(result.inputRequests)
      ? result.inputRequests as Record<string, NativeInputRequest>
      : {}
    return {
      content: [],
      inputRequired: { inputRequests, requestState: result.requestState },
    }
  }
  const content = Array.isArray(result.content)
    ? result.content.filter((part): part is NativeCallResult['content'][number] => Boolean(part) && typeof part === 'object')
    : []
  return {
    content,
    ...(result.isError === true && { isError: true }),
    ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
  }
}

// ── Form schema rendering ────────────────────────────────────────
// What Roadie can collect from a person for a form: select fields (enum or
// boolean) and short text fields (string, number). Anything else — and any
// form with too many fields to draw — is not renderable and is answered
// cancel with the reason, rather than guessing at the server's question.

/** Discord draws at most 5 component rows per message; one row holds the Accept/Decline/Cancel buttons. */
export const MAX_FORM_SELECT_FIELDS = 4
/** Discord modals accept at most 5 text inputs. */
export const MAX_FORM_TEXT_FIELDS = 5

export type NativeFormField =
  | {
      kind: 'select'
      name: string
      title: string
      required: boolean
      /** One row per choice; `content` is what an accept sends for it. */
      options: Array<{ value: string; label: string; content: unknown }>
    }
  | {
      kind: 'text'
      name: string
      title: string
      required: boolean
      inputType: 'string' | 'number' | 'integer'
      placeholder?: string
    }

export type NativeFormSchema = { ok: true; fields: NativeFormField[] } | { ok: false; reason: string }

/** Parse a form's `requestedSchema` into what the dialog can draw, or why it cannot. */
export function parseFormSchema(schema: unknown): NativeFormSchema {
  if (schema === undefined || schema === null) return { ok: true, fields: [] }
  if (typeof schema !== 'object' || Array.isArray(schema)) return { ok: false, reason: 'the form schema is not an object' }
  const { properties, required } = schema as { properties?: unknown; required?: unknown }
  if (properties === undefined || properties === null) return { ok: true, fields: [] }
  if (typeof properties !== 'object' || Array.isArray(properties)) return { ok: false, reason: 'the form properties are not an object' }
  const requiredNames = new Set(
    Array.isArray(required) ? required.filter((entry): entry is string => typeof entry === 'string') : [],
  )
  const fields: NativeFormField[] = []
  for (const [name, raw] of Object.entries(properties)) {
    const field = parseFormField({ name, required: requiredNames.has(name), raw })
    if (!field) return { ok: false, reason: `the field "${name}" is something Roadie cannot ask about` }
    fields.push(field)
  }
  const selects = fields.filter((field) => field.kind === 'select').length
  const texts = fields.filter((field) => field.kind === 'text').length
  if (selects > MAX_FORM_SELECT_FIELDS) return { ok: false, reason: `the form has ${selects} choice fields, more than Roadie can show (${MAX_FORM_SELECT_FIELDS})` }
  if (texts > MAX_FORM_TEXT_FIELDS) return { ok: false, reason: `the form has ${texts} text fields, more than Roadie can show (${MAX_FORM_TEXT_FIELDS})` }
  return { ok: true, fields }
}

function parseFormField({ name, required, raw }: { name: string; required: boolean; raw: unknown }): NativeFormField | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const schema = raw as { type?: unknown; enum?: unknown; title?: unknown; description?: unknown }
  const title = typeof schema.title === 'string' && schema.title.trim() ? schema.title.trim() : name
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.length > 25) return undefined
    if (!schema.enum.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry))) return undefined
    return {
      kind: 'select',
      name,
      title,
      required,
      options: schema.enum.map((entry, index) => ({
        value: String(index),
        label: enumLabel(entry),
        content: entry,
      })),
    }
  }
  if (schema.type === 'boolean') {
    return {
      kind: 'select',
      name,
      title,
      required,
      options: [
        { value: 'true', label: 'Yes', content: true },
        { value: 'false', label: 'No', content: false },
      ],
    }
  }
  const placeholder = typeof schema.description === 'string' && schema.description.trim()
    ? schema.description.trim().slice(0, 100)
    : undefined
  if (schema.type === 'string') return { kind: 'text', name, title, required, inputType: 'string', ...(placeholder && { placeholder }) }
  if (schema.type === 'number' || schema.type === 'integer') {
    return { kind: 'text', name, title, required, inputType: schema.type, ...(placeholder && { placeholder }) }
  }
  return undefined
}

function enumLabel(entry: string | number | boolean): string {
  return String(entry).slice(0, 100)
}
