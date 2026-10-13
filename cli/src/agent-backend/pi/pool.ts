// Pi sessions billed through Roadie's credential pools (#51).
//
// Roadie owns the Pi agent directory and writes a `roadie` provider per wire
// format into its models.json, against the loopback pool proxy
// (../../credentials/messages-proxy.ts), one model per pool rotation, like
// OpenCode's `roadie/<rotation>`:
//   - `roadie` (api `anthropic-messages`): rotations with an `anthropic/`
//     entry, served by the proxy's `/v1/messages`.
//   - `roadie-openai` (api `openai-completions`, #176): rotations with an
//     API-key provider entry (models.dev catalog providers like z.ai), served
//     by the proxy's `/chat/completions`.
// A single Pi model speaks exactly one wire format, so a mixed rotation is
// listed under both providers and each model falls through only among the
// candidates of its own format.
//
// ChatGPT (Codex) subscription accounts don't use rotations: they get the
// separate `roadie-codex` provider. Each Pi process gets its own key in
// ROADIE_PI_KEY; Pi sends it as a header (models.json resolves the env var)
// and the proxy maps it to the session. Pi never sees a credential.

import fs from 'node:fs'
import path from 'node:path'
import { parseRotationEntry } from '../../credentials/router.js'
import { readPoolAccounts, readPoolRotations, SHARED_POOL_ID } from '../../credentials/store.js'

export const PI_POOL_PROVIDER = 'roadie'
/** Provider id for rotations served as OpenAI-compatible chat completions (#176). */
export const PI_OPENAI_POOL_PROVIDER = 'roadie-openai'
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

/**
 * Rotation names whose candidates include an API-key provider (a models.dev
 * catalog provider like zai-coding-plan, or any provider with an account
 * --base-url), in the given pools (#176). Anthropic keys speak Anthropic
 * Messages and ChatGPT (Codex) accounts are OAuth, so their entries don't
 * count; the proxy serves these rotations on `/chat/completions`.
 */
export function openaiCompatRotations({ dataDir, poolIds = [SHARED_POOL_ID] }: { dataDir: string; poolIds?: string[] }): string[] {
  const names = new Set<string>()
  for (const poolId of poolIds) {
    const rotations = readPoolRotations({ dataDir, poolId })
    if (rotations instanceof Error) continue
    for (const [name, entries] of Object.entries(rotations)) {
      const openai = entries.some((entry) => {
        const parsed = parseRotationEntry(entry)
        return parsed !== null && parsed.provider !== 'anthropic' && parsed.provider !== 'openai-codex'
      })
      if (openai) names.add(name)
    }
  }
  return [...names].sort()
}

function poolModel(rotation: string) {
  return {
    id: rotation,
    name: rotation,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

export function piPoolModelsJson({ baseUrl, rotations, openaiRotations = [], codexModels = [] }: { baseUrl: string; rotations: string[]; openaiRotations?: string[]; codexModels?: string[] }) {
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
        models: rotations.map(poolModel),
      } }),
      ...(openaiRotations.length > 0 && { [PI_OPENAI_POOL_PROVIDER]: {
        baseUrl,
        api: 'openai-completions',
        apiKey: 'roadie-pool-managed',
        headers: keyHeader,
        models: openaiRotations.map(poolModel),
      } }),
    },
  }
}

/** Write the pool providers into a Roadie-owned Pi agent dir, keeping any other providers there. */
export function writePiPoolAgentDir({ agentDir, baseUrl, rotations, openaiRotations = [], codexModels = [] }: { agentDir: string; baseUrl: string; rotations: string[]; openaiRotations?: string[]; codexModels?: string[] }) {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const file = path.join(agentDir, 'models.json')
  let existing: { providers?: Record<string, unknown> } = {}
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const pool = piPoolModelsJson({ baseUrl, rotations, openaiRotations, codexModels })
  fs.writeFileSync(file, JSON.stringify({ ...existing, providers: { ...existing.providers, ...pool.providers } }, null, 2), { mode: 0o600 })
  // The proxy speaks HTTP + SSE only; Pi's Codex client would try a WebSocket first.
  const settingsFile = path.join(agentDir, 'settings.json')
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  } catch {}
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, transport: 'sse' }, null, 2), { mode: 0o600 })
}
