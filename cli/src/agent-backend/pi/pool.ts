// Pi sessions billed through Roadie's credential pools (#51).
//
// Roadie owns the Pi agent directory and writes one provider into its
// models.json, `roadie` (api `anthropic-messages`), against the pool proxy
// (../../credentials/messages-proxy.ts), with one model per pool rotation,
// through `roadie/<rotation>` model aliases. The proxy serves every rotation entry
// behind that one wire format (#276): Anthropic natively, API-key providers
// and ChatGPT subscriptions translated, so a rotation falls through its
// entries in order whatever their provider.
//
// Each Pi process gets its own key in ROADIE_PI_KEY; Pi sends it as a header
// (models.json resolves the env var) and the proxy maps it to the session.
// Pi never sees a credential.

import fs from 'node:fs'
import path from 'node:path'
import { parseRotationEntry } from '../../credentials/router.js'
import { readPoolRotations, SHARED_POOL_ID, type PoolRotations } from '../../credentials/store.js'

export const PI_POOL_PROVIDER = 'roadie'
export const PI_KEY_ENV = 'ROADIE_PI_KEY'

function poolModel(rotation: string, description?: string) {
  return {
    id: rotation,
    // Pi's models.json schema exposes display metadata through `name`.
    name: description ? `${rotation} — ${description}` : rotation,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** Anthropic model families using adaptive thinking (Claude 4.6+ and 5.x). */
export function supportsAdaptiveThinking(modelId: string): boolean {
  return /(?:^|-)claude-(?:opus|sonnet)-(?:4-(?:6|[7-9]|\d{2,})|[5-9](?:-|$)|\d{2,}(?:-|$))/.test(modelId)
}

/** Rotations with an adaptive-thinking Anthropic entry: Pi must request adaptive thinking for them. */
export function adaptiveAnthropicRotations({ dataDir, poolIds, rotations }: { dataDir: string; poolIds?: string[]; rotations: string[] }): string[] {
  const adaptive = new Set<string>()
  for (const poolId of poolIds ?? [SHARED_POOL_ID]) {
    const entriesByRotation = readPoolRotations({ dataDir, poolId })
    if (entriesByRotation instanceof Error) continue
    for (const rotation of rotations) {
      if (entriesByRotation[rotation]?.some((entry) => {
        const parsed = parseRotationEntry(entry)
        return parsed?.provider === 'anthropic' && supportsAdaptiveThinking(parsed.modelId)
      })) adaptive.add(rotation)
    }
  }
  return [...adaptive].sort()
}

export function piPoolModelsJson({ baseUrl, rotations, adaptiveRotations = [] }: { baseUrl: string; rotations: PoolRotations; adaptiveRotations?: string[] }) {
  return {
    providers: {
      [PI_POOL_PROVIDER]: {
        baseUrl,
        api: 'anthropic-messages',
        apiKey: 'roadie-pool-managed',
        headers: { 'x-roadie-key': `\${${PI_KEY_ENV}}` },
        models: Object.keys(rotations).sort().map((rotation) => ({ ...poolModel(rotation, rotations[rotation]?.description), ...(adaptiveRotations.includes(rotation) && { compat: { forceAdaptiveThinking: true } }) })),
      },
    },
  }
}

// Rotations hidden from the /model picker (#343), recorded from the catalog
// the Pi agent dir was written from at pool startup. Like the rotation list
// itself, a change takes effect on the next bot restart.
let pickerHidden: string[] = []

export function setPickerHiddenRotations(rotations: PoolRotations) {
  pickerHidden = Object.keys(rotations).filter((name) => rotations[name]?.hidden === true)
}

export function pickerHiddenRotations(): string[] {
  return pickerHidden
}

/**
 * Write the pool provider into a Roadie-owned Pi agent dir. Providers named
 * `roadie` or `roadie-*` are the pool's and are replaced; any other provider
 * there is kept. `adaptiveRotations` comes from whoever holds the rotation
 * entries: the local pool, or a remote pool host's catalog.
 */
export function writePiPoolAgentDir({ agentDir, baseUrl, rotations, adaptiveRotations = [] }: { agentDir: string; baseUrl: string; rotations: PoolRotations; adaptiveRotations?: string[] }) {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const file = path.join(agentDir, 'models.json')
  let existing: { providers?: Record<string, unknown> } = {}
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const kept = Object.fromEntries(Object.entries(existing.providers ?? {}).filter(([id]) => id !== PI_POOL_PROVIDER && !id.startsWith(`${PI_POOL_PROVIDER}-`)))
  const pool = piPoolModelsJson({ baseUrl, rotations, adaptiveRotations })
  fs.writeFileSync(file, JSON.stringify({ ...existing, providers: { ...kept, ...pool.providers } }, null, 2), { mode: 0o600 })
}
