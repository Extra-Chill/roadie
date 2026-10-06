#!/usr/bin/env node
// Credential-pools spike driver. Proves, against a real `opencode serve`:
//   A. a chat.headers tag reaches a custom provider's fetch, per session,
//   B. concurrent sessions on ONE server resolve to different credentials,
//   C. per-pool rotation works (alice's first key is rate limited),
//   D. no x-roadie-* header leaks upstream,
//   E. an untagged session never reaches upstream (fail closed).
//
// Fully isolated: temp HOME/XDG dirs, its own ports, no real credentials.
// Usage: node spikes/credential-pools/run.mjs [path/to/opencode]
// SPIKE_AI_SDK_FROM must point at a node_modules tree containing
// @ai-sdk/openai-compatible (defaults to this checkout's cli/).

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

const people = ['alice', 'bob', null]
const sessions = []
for (const pool of people) sessions.push({ pool, id: (await api('POST', '/session', {})).id })
fs.writeFileSync(
  sessionPools,
  JSON.stringify(Object.fromEntries(sessions.filter((s) => s.pool).map((s) => [s.id, s.pool]))),
)

// All three prompts in flight at once against the one server.
const results = await Promise.all(
  sessions.map(async (s) => {
    const reply = await api('POST', `/session/${s.id}/message`, {
      model: { providerID: 'pool', modelID: 'm' },
      parts: [{ type: 'text', text: 'hello' }],
    }).catch((e) => ({ thrown: String(e) }))
    const text = (reply?.parts || [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')
    return { ...s, text, error: reply?.info?.error || reply?.thrown || null }
  }),
)

const upstream = fs
  .readFileSync(log, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

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

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`)
console.log(`upstream requests: ${upstream.length}, temp dir: ${root}`)
const failed = checks.some((c) => !c.ok)
if (failed) console.error('--- opencode output ---\n' + server.output().slice(-3000))
cleanup()
process.exit(failed ? 1 : 0)
