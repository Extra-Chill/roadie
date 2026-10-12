#!/usr/bin/env node
// Minimal stdio MCP server for tests: one tool, `say`, that echoes its text.
let buffer = ''
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } })
    } else if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'say', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
    } else if (request.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `mcp says: ${request.params?.arguments?.text ?? ''}` }] } })
    } else {
      send({ jsonrpc: '2.0', id: request.id, result: {} })
    }
  }
})
