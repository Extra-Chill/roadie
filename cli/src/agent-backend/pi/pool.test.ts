// Pi pool agent-dir wiring (#51, #276): one `roadie` provider, one model per rotation.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { setPoolRotation, SHARED_POOL_ID } from '../../credentials/store.js'
import { poolCatalog } from '../../credentials/messages-proxy.js'
import { PI_POOL_PROVIDER, writePiPoolAgentDir } from './pool.js'

function tempDataDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), prefix))
}

async function seedRotations(dataDir: string, entries: Record<string, string[]>): Promise<void> {
  for (const [name, rotation] of Object.entries(entries)) {
    const set = await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name, entries: rotation })
    if (set instanceof Error) throw set
  }
}

type Providers = Record<string, { api: string; baseUrl: string; models: Array<{ id: string; reasoning?: boolean; input?: string[]; compat?: { forceAdaptiveThinking?: boolean } }> }>

describe('pool provider', () => {
  test('every rotation is one roadie model, whatever its entries\' providers', async () => {
    const dataDir = tempDataDir('pi-pool-')
    await seedRotations(dataDir, {
      'claude-best': ['anthropic/claude-opus-5-5'],
      'claude-legacy': ['anthropic/claude-sonnet-4-5'],
      'glm-best': ['zai-coding-plan/glm-5.3-flash'],
      subagent: ['zai-coding-plan/glm-5.3-flash', 'opencode-go/glm-5.3-flash', 'openai/gpt-6-luna', 'anthropic/claude-sonnet-5-5'],
    })
    // A hidden rotation (#343): the catalog record carries the flag...
    const hide = await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'subagent', entries: ['zai-coding-plan/glm-5.3-flash', 'opencode-go/glm-5.3-flash', 'openai/gpt-6-luna', 'anthropic/claude-sonnet-5-5'], hidden: true })
    if (hide instanceof Error) throw hide
    const catalog = poolCatalog({ dataDir, poolIds: [SHARED_POOL_ID] })
    expect(catalog.rotations['subagent']).toEqual({
      entries: ['zai-coding-plan/glm-5.3-flash', 'opencode-go/glm-5.3-flash', 'openai/gpt-6-luna', 'anthropic/claude-sonnet-5-5'],
      hidden: true,
    })
    expect(catalog.rotations['glm-best']).toEqual({ entries: ['zai-coding-plan/glm-5.3-flash'] })
    const { rotations } = catalog
    expect(Object.keys(rotations)).toEqual(['claude-best', 'claude-legacy', 'glm-best', 'subagent'])
    expect(catalog.adaptiveRotations).toEqual(['claude-best', 'subagent'])
    // ...and the model stays in models.json: hidden rotations remain fully
    // routable (ROADIE_PI_MODEL, Homeboy cooks); only the /model picker hides them.
    const agentDir = path.join(dataDir, 'agent')
    writePiPoolAgentDir({ agentDir, baseUrl: 'http://127.0.0.1:47120', ...catalog })
    const { providers } = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')) as { providers: Providers }
    expect(Object.keys(providers)).toEqual([PI_POOL_PROVIDER])
    const pool = providers[PI_POOL_PROVIDER]!
    expect(pool).toMatchObject({ api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:47120' })
    expect(pool.models.map((model) => model.id)).toEqual(Object.keys(rotations))
    expect(pool.models.map((model) => model.id)).toContain('subagent')
    expect(pool.models[0]).toMatchObject({ reasoning: true, input: ['text', 'image'] })
    const compat = Object.fromEntries(pool.models.map((model) => [model.id, model.compat]))
    // Adaptive thinking follows a rotation's adaptive Anthropic entry.
    expect(compat).toEqual({ 'claude-best': { forceAdaptiveThinking: true }, 'claude-legacy': undefined, 'glm-best': undefined, subagent: { forceAdaptiveThinking: true } })
  })

  test('replaces the pool\'s own providers, including retired roadie-* ones, and keeps the rest', async () => {
    const agentDir = path.join(tempDataDir('pi-pool-'), 'agent')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        fake: { baseUrl: 'http://localhost', models: [] },
        'roadie-openai': { baseUrl: 'http://old', models: [] },
        'roadie-codex': { baseUrl: 'http://old', models: [] },
      },
    }))
    writePiPoolAgentDir({ agentDir, baseUrl: 'http://127.0.0.1:47120', rotations: { 'claude-best': { entries: ['anthropic/claude-opus-5-5'], description: 'Hard coding tasks' } } })
    const { providers } = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')) as { providers: Providers }
    expect(Object.keys(providers).sort()).toEqual(['fake', PI_POOL_PROVIDER])
    expect(providers[PI_POOL_PROVIDER]!.models[0]).toMatchObject({ id: 'claude-best', name: 'claude-best — Hard coding tasks' })
  })
})
