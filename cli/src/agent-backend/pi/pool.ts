// Pi sessions billed through Roadie's credential pools (#51).
//
// Roadie owns the Pi agent directory and writes a `roadie` provider into its
// models.json: Anthropic Messages against the loopback pool proxy
// (../../credentials/messages-proxy.ts), one model per pool rotation, like
// OpenCode's `roadie/<rotation>`. Each Pi process gets its own key in
// ROADIE_PI_KEY; Pi sends it as a header (models.json resolves the env var)
// and the proxy maps it to the session. Pi never sees a credential.

import fs from 'node:fs'
import path from 'node:path'
import { readPoolRotations, SHARED_POOL_ID } from '../../credentials/store.js'

export const PI_POOL_PROVIDER = 'roadie'
export const PI_KEY_ENV = 'ROADIE_PI_KEY'

/** Rotation names whose candidates include an Anthropic model, in the given pools. */
export function anthropicRotations({ dataDir, poolIds = [SHARED_POOL_ID] }: { dataDir: string; poolIds?: string[] }): string[] {
  const names = new Set<string>()
  for (const poolId of poolIds) {
    const rotations = readPoolRotations({ dataDir, poolId })
    if (rotations instanceof Error) continue
    for (const [name, entries] of Object.entries(rotations)) {
      if (entries.some((entry) => entry.startsWith('anthropic/'))) names.add(name)
    }
  }
  return [...names].sort()
}

export function piPoolModelsJson({ baseUrl, rotations }: { baseUrl: string; rotations: string[] }) {
  return {
    providers: {
      [PI_POOL_PROVIDER]: {
        baseUrl,
        api: 'anthropic-messages',
        apiKey: PI_KEY_ENV,
        headers: { 'x-roadie-key': PI_KEY_ENV },
        models: rotations.map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 200000,
          maxTokens: 32000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  }
}

/** Write the pool provider into a Roadie-owned Pi agent dir, keeping any other providers there. */
export function writePiPoolAgentDir({ agentDir, baseUrl, rotations }: { agentDir: string; baseUrl: string; rotations: string[] }) {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const file = path.join(agentDir, 'models.json')
  let existing: { providers?: Record<string, unknown> } = {}
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const pool = piPoolModelsJson({ baseUrl, rotations })
  fs.writeFileSync(file, JSON.stringify({ ...existing, providers: { ...existing.providers, ...pool.providers } }, null, 2), { mode: 0o600 })
}
