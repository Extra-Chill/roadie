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
import { readPoolAccounts, readPoolRotations, SHARED_POOL_ID } from '../../credentials/store.js'

export const PI_POOL_PROVIDER = 'roadie'
export const PI_CODEX_POOL_PROVIDER = 'roadie-codex'
export const PI_KEY_ENV = 'ROADIE_PI_KEY'
/** ChatGPT-subscription models offered through the pool (Pi accepts unlisted ids too). */
export const DEFAULT_CODEX_MODELS = ['gpt-6-luna', 'gpt-5.5']

/**
 * Pi's Codex client reads the ChatGPT account id from its token, so it gets a
 * placeholder token naming no real account; the proxy authenticates the
 * request by its x-roadie-key and swaps in the pool account's real token.
 */
function placeholderCodexToken(): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ 'https://api.openai.com/auth': { chatgpt_account_id: 'roadie-pool' } })}.roadie`
}

/** Does any of these pools hold a ChatGPT (Codex) account? */
export function hasCodexAccounts({ dataDir, poolIds = [SHARED_POOL_ID] }: { dataDir: string; poolIds?: string[] }): boolean {
  return poolIds.some((poolId) => {
    const accounts = readPoolAccounts({ dataDir, poolId })
    return !(accounts instanceof Error) && accounts.some((account) => account.provider === 'openai-codex')
  })
}

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

export function piPoolModelsJson({ baseUrl, rotations, codexModels = [] }: { baseUrl: string; rotations: string[]; codexModels?: string[] }) {
  const keyHeader = { 'x-roadie-key': `\${${PI_KEY_ENV}}` }
  return {
    providers: {
      ...(codexModels.length > 0 && {
        [PI_CODEX_POOL_PROVIDER]: {
          baseUrl,
          api: 'openai-codex-responses',
          apiKey: placeholderCodexToken(),
          headers: keyHeader,
          models: codexModels.map((id) => ({
            id,
            name: id,
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 272000,
            maxTokens: 128000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      }),
      ...(rotations.length > 0 && { [PI_POOL_PROVIDER]: {
        baseUrl,
        api: 'anthropic-messages',
        apiKey: 'roadie-pool-managed',
        headers: keyHeader,
        models: rotations.map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 200000,
          maxTokens: 32000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      } }),
    },
  }
}

/** Write the pool provider into a Roadie-owned Pi agent dir, keeping any other providers there. */
export function writePiPoolAgentDir({ agentDir, baseUrl, rotations, codexModels = [] }: { agentDir: string; baseUrl: string; rotations: string[]; codexModels?: string[] }) {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const file = path.join(agentDir, 'models.json')
  let existing: { providers?: Record<string, unknown> } = {}
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const pool = piPoolModelsJson({ baseUrl, rotations, codexModels })
  fs.writeFileSync(file, JSON.stringify({ ...existing, providers: { ...existing.providers, ...pool.providers } }, null, 2), { mode: 0o600 })
  // The proxy speaks HTTP + SSE only; Pi's Codex client would try a WebSocket first.
  const settingsFile = path.join(agentDir, 'settings.json')
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  } catch {}
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, transport: 'sse' }, null, 2), { mode: 0o600 })
}
