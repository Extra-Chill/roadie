#!/usr/bin/env node
// Credential-pools spike driver. Proves, against a real `opencode serve`:
//   A. a chat.headers tag reaches a custom provider's fetch, per session,
//   B. concurrent sessions on ONE server resolve to different credentials,
//   C. per-pool rotation works (alice's first key is rate limited),
//   D. no x-roadie-* header leaks upstream,
//   E. an untagged session never reaches upstream (fail closed),
//   F. one session hands off across providers AND payers (alice on the
//      Anthropic wire, bob on the OpenAI wire, alice again) and every turn
//      receives the full prior history, including the other provider's reply.
//
// Fully isolated: temp HOME/XDG dirs, its own ports, no real credentials.
// Usage: node spikes/credential-pools/run.mjs [path/to/opencode]
// SPIKE_AI_SDK_FROM must point at a package.json whose node_modules contain
// @ai-sdk/openai-compatible and @ai-sdk/anthropic (defaults to this
// checkout's cli/).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const opencodeBin = process.argv[2] || 'opencode'
const tmpBase = process.env.TMPDIR || os.tmpdir()
const root = fs.mkdtempSync(path.join(tmpBase, 'roadie-pool-spike-'))

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const upstreamPort = await freePort()
const serverPort = await freePort()
const file = (name, value) => {
  const p = path.join(root, name)
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  return p
}

const pools = file('pools.json', {
  alice: ['alice-1', 'alice-2'],
  bob: ['bob-1'],
  shared: ['shared-1'],
})
const sessionPools = file('session-pools.json', {})
const log = file('upstream.jsonl', '')

const config = file('opencode.json', {
  $schema: 'https://opencode.ai/config.json',
  plugin: [pathToFileURL(path.join(here, 'pool-plugin.mjs')).href],
  provider: {
    pool: {
      name: 'Roadie pool (spike)',
      npm: pathToFileURL(path.join(here, 'pool-provider.mjs')).href,
      options: { baseURL: `http://127.0.0.1:${upstreamPort}/v1` },
      models: { m: { name: 'spike model', tool_call: false } },
    },
    'pool-anthropic': {
      name: 'Roadie pool, Anthropic wire (spike)',
      npm: pathToFileURL(path.join(here, 'pool-provider-anthropic.mjs')).href,
      options: { baseURL: `http://127.0.0.1:${upstreamPort}/v1` },
      models: { m: { name: 'spike model', tool_call: false } },
    },
  },
  model: 'pool/m',
  small_model: 'pool/m',
  share: 'disabled',
  autoupdate: false,
})

const env = {
  ...process.env,
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, '.config'),
  XDG_DATA_HOME: path.join(root, '.local/share'),
  XDG_CACHE_HOME: path.join(root, '.cache'),
  XDG_STATE_HOME: path.join(root, '.local/state'),
  OPENCODE_CONFIG: config,
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  SPIKE_UPSTREAM_PORT: String(upstreamPort),
  SPIKE_LOG: log,
  SPIKE_RATE_LIMITED: 'alice-1',
  SPIKE_POOLS: pools,
  SPIKE_SESSION_POOLS: sessionPools,
  SPIKE_AI_SDK_FROM:
    process.env.SPIKE_AI_SDK_FROM || path.join(here, '../../cli/package.json'),
}

const children = []
const start = (cmd, args) => {
  const child = spawn(cmd, args, { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  child.output = () => out
  children.push(child)
  return child
}
const cleanup = () => children.forEach((c) => c.kill('SIGTERM'))
process.on('exit', cleanup)

start(process.execPath, [path.join(here, 'stub-upstream.mjs')])
const server = start(opencodeBin, ['serve', '--port', String(serverPort), '--hostname', '127.0.0.1'])
const base = `http://127.0.0.1:${serverPort}`

const api = async (method, route, body) => {
  const res = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', 'x-opencode-directory': root },
    body: body && JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

for (let i = 0; ; i++) {
  try {
    await api('GET', '/config')
    break
  } catch (e) {
    if (i > 120) {
      console.error(server.output())
      throw e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

// Plugin reads this file on every LLM call; rewriting it between turns is how
// the spike simulates `--thread-billing speaker` (owner changes per turn).
const poolMap = {}
const setPool = (sessionID, pool) => {
  if (pool) poolMap[sessionID] = pool
  else delete poolMap[sessionID]
  fs.writeFileSync(sessionPools, JSON.stringify(poolMap))
}

const send = async (sessionID, providerID, text) => {
  const reply = await api('POST', `/session/${sessionID}/message`, {
    model: { providerID, modelID: 'm' },
    parts: [{ type: 'text', text }],
  }).catch((e) => ({ thrown: String(e) }))
  const out = (reply?.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
  return { text: out, error: reply?.info?.error || reply?.thrown || null }
}

const people = ['alice', 'bob', null]
const sessions = []
for (const pool of people) {
  const id = (await api('POST', '/session', {})).id
  sessions.push({ pool, id })
  setPool(id, pool)
}

// All three prompts in flight at once against the one server.
const results = await Promise.all(
  sessions.map(async (s) => ({ ...s, ...(await send(s.id, 'pool', 'hello')) })),
)

// F. One session, three turns, alternating provider wire format and payer.
const handoff = (await api('POST', '/session', {})).id
const turns = [
  { pool: 'alice', provider: 'pool-anthropic', prompt: 'turn-1-from-alice' },
  { pool: 'bob', provider: 'pool', prompt: 'turn-2-from-bob' },
  { pool: 'alice', provider: 'pool-anthropic', prompt: 'turn-3-from-alice' },
]
const handoffReplies = []
for (const t of turns) {
  setPool(handoff, t.pool)
  handoffReplies.push(await send(handoff, t.provider, t.prompt))
}

const upstream = fs
  .readFileSync(log, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

// The successful request for a hand-off turn: the one carrying that turn's
// prompt in the wire format that turn asked for (title generation is a
// separate request on the small model and is excluded by format/latest prompt).
const turnRequest = (t, i) =>
  upstream.find(
    (r) =>
      r.status === 200 &&
      r.format === (t.provider === 'pool' ? 'openai' : 'anthropic') &&
      r.body.includes(t.prompt) &&
      !turns.slice(i + 1).some((later) => r.body.includes(later.prompt)) &&
      !r.body.toLowerCase().includes('title'),
  )

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
const [alice, bob, untagged] = results

check('A+B alice session billed to alice pool', alice.text.includes('ok:alice-'), alice.text || alice.error)
check('A+B bob session billed to bob pool', bob.text === 'ok:bob-1', bob.text || bob.error)
check('C alice rotated past rate-limited alice-1', alice.text === 'ok:alice-2', alice.text)
check(
  'C alice-1 was tried and got 429',
  upstream.some((r) => r.key === 'alice-1' && r.status === 429),
  upstream.map((r) => `${r.key}:${r.status}`).join(' '),
)
check(
  'D no x-roadie-* header reached upstream',
  upstream.every((r) => !Object.keys(r.headers).some((h) => h.startsWith('x-roadie-'))),
  [...new Set(upstream.flatMap((r) => Object.keys(r.headers)))].join(','),
)
check(
  'E untagged session never reached upstream',
  !upstream.some((r) => r.key === '' || r.key === 'shared-1') && !untagged.text.startsWith('ok:'),
  untagged.text || JSON.stringify(untagged.error)?.slice(0, 200),
)

const [r1, r2, r3] = turns.map(turnRequest)
check(
  'F turns billed to alternating payers',
  handoffReplies[0].text === 'anth:alice-2' &&
    handoffReplies[1].text === 'ok:bob-1' &&
    handoffReplies[2].text === 'anth:alice-2',
  handoffReplies.map((r) => r.text || JSON.stringify(r.error)?.slice(0, 120)).join(' | '),
)
check(
  'F turn 2 (bob, OpenAI wire) saw turn 1 prompt and Anthropic reply',
  r2 && r2.body.includes('turn-1-from-alice') && r2.body.includes('anth:alice-2'),
  r2 ? r2.body.slice(0, 400) : 'no turn-2 request',
)
check(
  'F turn 3 (alice, Anthropic wire) saw turns 1-2 including the OpenAI reply',
  r3 &&
    r3.body.includes('turn-1-from-alice') &&
    r3.body.includes('turn-2-from-bob') &&
    r3.body.includes('ok:bob-1'),
  r3 ? r3.body.slice(0, 400) : 'no turn-3 request',
)
check('F turn 1 request went out on the Anthropic wire', r1 && r1.path.endsWith('/messages'), r1?.path)

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`)
console.log(`upstream requests: ${upstream.length}, temp dir: ${root}`)
const failed = checks.some((c) => !c.ok)
if (failed) console.error('--- opencode output ---\n' + server.output().slice(-3000))
cleanup()
process.exit(failed ? 1 : 0)
