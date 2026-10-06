// Fake upstream for the credential-pools spike. Speaks two wire formats:
//   POST .../messages          Anthropic Messages API, replies "anth:<key>"
//   POST .../chat/completions  OpenAI chat completions, replies "ok:<key>"
//
// Records every request (path, key, status, headers, raw body) to $SPIKE_LOG
// as JSON lines. A bearer key listed in $SPIKE_RATE_LIMITED (comma separated)
// gets HTTP 429, so per-pool rotation can be observed.

import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.env.SPIKE_UPSTREAM_PORT)
const log = process.env.SPIKE_LOG
const rateLimited = new Set((process.env.SPIKE_RATE_LIMITED || '').split(',').filter(Boolean))

const sse = (event, data) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`

function anthropicStream(res, text) {
  res.write(
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_spike',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  )
  res.write(
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  )
  res.write(
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
  )
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
  )
  res.end(sse('message_stop', { type: 'message_stop' }))
}

function openaiStream(res, text) {
  const chunk = (delta, finish) =>
    sse(null, {
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
  res.write(chunk({ role: 'assistant', content: text }, null))
  res.write(chunk({}, 'stop'))
  res.end('data: [DONE]\n\n')
}

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const key = (req.headers.authorization || '').replace(/^Bearer /, '')
      const limited = rateLimited.has(key)
      const anthropic = req.url.endsWith('/messages')
      fs.appendFileSync(
        log,
        JSON.stringify({
          path: req.url,
          format: anthropic ? 'anthropic' : 'openai',
          key,
          status: limited ? 429 : 200,
          headers: req.headers,
          body,
        }) + '\n',
      )
      if (limited) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (anthropic) anthropicStream(res, `anth:${key}`)
      else openaiStream(res, `ok:${key}`)
    })
  })
  .listen(port, '127.0.0.1')
