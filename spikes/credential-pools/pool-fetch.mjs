// Shared fetch for the credential-pools spike providers.
//
// Every LLM request goes through `poolFetch`, which:
//   1. reads the pool id the plugin put in `x-roadie-pool` (chat.headers hook),
//   2. strips every x-roadie-* header so nothing internal reaches upstream,
//   3. tries that pool's accounts in order, skipping to the next on HTTP 429.
//
// Pools come from $SPIKE_POOLS: { "<pool>": ["key1", "key2"] }. In Roadie this
// becomes the per-pool credential store; here it is a static file. The stub
// upstream reads the key from `authorization` for both wire formats.

import fs from 'node:fs'
import { createRequire } from 'node:module'

const POOL_HEADER = 'x-roadie-pool'

export async function loadSdk(name) {
  const require = createRequire(process.env.SPIKE_AI_SDK_FROM)
  return import(require.resolve(name))
}

function loadPools() {
  return JSON.parse(fs.readFileSync(process.env.SPIKE_POOLS, 'utf8'))
}

export async function poolFetch(input, init = {}) {
  const headers = new Headers(init.headers)
  const pool = headers.get(POOL_HEADER)
  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-roadie-')) headers.delete(name)
  }
  headers.delete('x-api-key')
  if (!pool) {
    return new Response(JSON.stringify({ error: { message: 'no credential pool on request' } }), {
      status: 401,
    })
  }
  const accounts = loadPools()[pool] || []
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: { message: `pool ${pool} has no accounts` } }), {
      status: 401,
    })
  }
  let last
  for (const key of accounts) {
    headers.set('authorization', `Bearer ${key}`)
    last = await fetch(input, { ...init, headers })
    if (last.status !== 429) return last
  }
  return last
}
