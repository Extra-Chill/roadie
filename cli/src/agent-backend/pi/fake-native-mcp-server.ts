// A fake stateless 2026-07-28 MCP server (HTTP POST, JSON-RPC) for tests that
// drive real Pi processes against the Roadie extension's native client. Same
// role as fake-mcp-server.mjs (the stdio 2025-06-18 fake), plus the pieces
// that revision adds: server/discover, the _meta envelope, and form
// elicitation with input_required continuations.
//
// Behavior:
// - `server/discover` reports supportedVersions (default with 2026-07-28).
// - `tools/list` lists `echo` and `approve_buy`.
// - `echo` answers its text right away.
// - `approve_buy` asks a form (boolean `confirm`, enum `plan`) exactly once,
//   then answers from the continuation: accept → "bought <plan>",
//   decline → "declined", cancel → "cancelled". Without a continuation it
//   always asks again.
//
// Every request is logged (method, _meta, headers minus nothing — the token
// stays in the headers the test asserts on) via `log`.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const FORM_STATE = 'signed-form-state'

export type FakeNativeMcpRequest = {
  method: string
  params: Record<string, unknown>
  headers: Record<string, string>
}

export type FakeNativeMcpServer = Awaited<ReturnType<typeof startFakeNativeMcpServer>>

export async function startFakeNativeMcpServer({
  supportedVersions = ['2026-07-28', '2025-11-25'],
  clientInfoName,
  requireClientCapabilities,
}: {
  supportedVersions?: string[]
  /** When set, requests must carry this clientInfo.name or the call fails. */
  clientInfoName?: string
  /** When set, requests must declare these clientCapabilities or the call fails. */
  requireClientCapabilities?: Record<string, unknown>
} = {}): Promise<{
  baseUrl: string
  log: FakeNativeMcpRequest[]
  close(): Promise<void>
}> {
  const log: FakeNativeMcpRequest[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      const request = JSON.parse(body || '{}') as { id?: number; method?: string; params?: Record<string, unknown> }
      const headers = { ...req.headers } as Record<string, string>
      log.push({ method: String(request.method), params: request.params ?? {}, headers })
      const meta = (request.params?._meta ?? {}) as {
        'io.modelcontextprotocol/protocolVersion'?: string
        'io.modelcontextprotocol/clientCapabilities'?: Record<string, unknown>
        'io.modelcontextprotocol/clientInfo'?: { name?: string }
      }
      const reply = (payload: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const error = (code: number, message: string) => reply({ jsonrpc: '2.0', id: request.id, error: { code, message } })
      // The envelope the revision requires on every request.
      if (meta['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
        error(-32001, `protocol version ${String(meta['io.modelcontextprotocol/protocolVersion'])} not supported`)
        return
      }
      if (clientInfoName && meta['io.modelcontextprotocol/clientInfo']?.name !== clientInfoName) {
        error(-32002, 'unknown client')
        return
      }
      if (requireClientCapabilities && JSON.stringify(meta['io.modelcontextprotocol/clientCapabilities'] ?? {}) !== JSON.stringify(requireClientCapabilities)) {
        error(-32003, 'client capabilities missing')
        return
      }
      switch (request.method) {
        case 'server/discover': {
          reply({ jsonrpc: '2.0', id: request.id, result: { supportedVersions, capabilities: { tools: {}, elicitation: {} }, instructions: 'fake native server' } })
          return
        }
        case 'tools/list': {
          reply({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              tools: [
                { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
                {
                  name: 'approve_buy',
                  description: 'Buy a plan after the account owner approves a form',
                  inputSchema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
                },
                {
                  name: 'impossible_form',
                  description: 'Asks a form Roadie cannot render',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          })
          return
        }
        case 'tools/call': {
          const name = String(request.params?.name)
          const args = (request.params?.arguments ?? {}) as Record<string, unknown>
          if (name === 'echo') {
            reply({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `mcp says: ${String(args.text ?? '')}` }] } })
            return
          }
          if (name === 'impossible_form') {
            const inputResponses = (request.params?.inputResponses ?? {}) as Record<string, { action?: string }>
            if (!Object.keys(inputResponses).length) {
              reply({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  resultType: 'input_required',
                  inputRequests: { cfg: { method: 'elicitation/create', params: { mode: 'form', message: 'Configure?', requestedSchema: { type: 'object', properties: { meta: { type: 'object' } } } } } },
                  requestState: 'state-impossible',
                },
              })
              return
            }
            const action = inputResponses.cfg?.action ?? 'cancel'
            reply({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `form was ${action}` }] } })
            return
          }
          if (name === 'approve_buy') {
            const inputResponses = (request.params?.inputResponses ?? {}) as Record<string, { action?: string; content?: Record<string, unknown> }>
            const answer = inputResponses.cfg
            if (!answer) {
              reply({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  resultType: 'input_required',
                  inputRequests: {
                    cfg: {
                      method: 'elicitation/create',
                      params: {
                        mode: 'form',
                        message: `Approve buying the ${String(args.plan ?? 'pro')} plan?`,
                        requestedSchema: {
                          type: 'object',
                          required: ['confirm'],
                          properties: {
                            confirm: { type: 'boolean', title: 'Confirm' },
                            note: { type: 'string', title: 'Note', description: 'Anything to add?' },
                          },
                        },
                      },
                    },
                  },
                  requestState: FORM_STATE,
                },
              })
              return
            }
            const plan = String(args.plan ?? 'pro')
            if (answer.action === 'accept') {
              const note = answer.content && typeof answer.content.note === 'string' ? answer.content.note : ''
              reply({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `bought ${plan}${note ? ` (note: ${note})` : ''}` }] } })
            } else if (answer.action === 'decline') {
              reply({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'declined' }], isError: false } })
            } else {
              reply({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'cancelled' }] } })
            }
            return
          }
          error(-32602, `unknown tool ${name}`)
          return
        }
        default:
          // Anything else (e.g. initialize on the built-in path) is method-not-found.
          error(-32601, `method not found: ${String(request.method)}`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
