// Fake OpenAI-compatible upstream for the credential-pools spike.
//
// Records every request's headers to $SPIKE_LOG (JSON lines) and answers with
// a one-word streamed completion. A bearer key listed in $SPIKE_RATE_LIMITED
// (comma separated) gets HTTP 429, so the provider's per-pool rotation can be
// observed.

import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.env.SPIKE_UPSTREAM_PORT)
const log = process.env.SPIKE_LOG
const rateLimited = new Set((process.env.SPIKE_RATE_LIMITED || '').split(',').filter(Boolean))

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const key = (req.headers.authorization || '').replace(/^Bearer /, '')
      const limited = rateLimited.has(key)
      fs.appendFileSync(
        log,
        JSON.stringify({ path: req.url, key, status: limited ? 429 : 200, headers: req.headers }) + '\n',
      )
      if (limited) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'm',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      res.write(chunk({ role: 'assistant', content: `ok:${key}` }, null))
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    })
  })
  .listen(port, '127.0.0.1')
