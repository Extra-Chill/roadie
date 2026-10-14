// Pi pool agent-dir wiring (#51, #176): rotation wire formats become Pi api types.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { addPoolAccount, addPoolOAuthAccount, setPoolRotation, SHARED_POOL_ID } from '../../credentials/store.js'
import {
  anthropicRotations,
  codexModels,
  openaiCompatRotations,
  piPoolModelsJson,
  PI_CODEX_POOL_PROVIDER,
  PI_OPENAI_POOL_PROVIDER,
  PI_POOL_PROVIDER,
  writePiPoolAgentDir,
} from './pool.js'

function tempDataDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), prefix))
}

async function seedRotations(dataDir: string, entries: Record<string, string[]>): Promise<void> {
  const anthropic = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', refresh: 'refresh', access: 'access', expires: Date.now() + 3_600_000 })
  if (anthropic instanceof Error) throw anthropic
  const zai = await addPoolAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'zai-coding-plan', key: 'zai-key' })
  if (zai instanceof Error) throw zai
  for (const [name, rotation] of Object.entries(entries)) {
    const set = await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name, entries: rotation })
    if (set instanceof Error) throw set
  }
}

describe('rotation wire formats', () => {
  test('openai/ rotation entries run on ChatGPT accounts, never as API-key rotations', async () => {
    const dataDir = tempDataDir('pi-pool-')
    await seedRotations(dataDir, {
      'openai-gpt-6.1-sol': ['openai/gpt-6.1-sol'],
      subagent: ['zai-coding-plan/glm-5.3-flash', 'openai/gpt-6-luna', 'anthropic/claude-sonnet-5-5'],
    })
    expect(openaiCompatRotations({ dataDir })).toEqual(['subagent'])
    // No ChatGPT account yet: nothing to offer.
    expect(codexModels({ dataDir })).toEqual([])
    const chatgpt = await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'openai-codex', refresh: 'refresh', access: 'access', expires: Date.now() + 3_600_000 })
    if (chatgpt instanceof Error) throw chatgpt
    expect(codexModels({ dataDir })).toEqual(['gpt-6-luna', 'gpt-6.1-sol'])
  })

  test('api-key rotations are served OpenAI-compatible; anthropic rotations stay on Anthropic Messages', async () => {
    const dataDir = tempDataDir('pi-pool-')
    await seedRotations(dataDir, {
      'claude-best': ['anthropic/claude-opus-4-8'],
      'glm-best': ['zai-coding-plan/glm-5.3-flash'],
      mixed: ['anthropic/claude-opus-4-8', 'zai-coding-plan/glm-5.3-flash'],
      'codex-only': ['openai-codex/codex'],
    })
    expect(anthropicRotations({ dataDir })).toEqual(['claude-best', 'mixed'])
    expect(openaiCompatRotations({ dataDir })).toEqual(['glm-best', 'mixed'])
  })

  test('every rotation with a roadie candidate gets a model, with the pi api type per wire format', async () => {
    const dataDir = tempDataDir('pi-pool-')
    await seedRotations(dataDir, {
      'claude-best': ['anthropic/claude-opus-5-5'],
      'claude-legacy': ['anthropic/claude-sonnet-4-5'],
      'glm-best': ['zai-coding-plan/glm-5.3-flash'],
    })
    const rotations = anthropicRotations({ dataDir })
    const openaiRotations = openaiCompatRotations({ dataDir })
    const agentDir = path.join(dataDir, 'agent')
    writePiPoolAgentDir({ agentDir, baseUrl: 'http://127.0.0.1:47120', rotations, openaiRotations, dataDir })
    const { providers } = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')) as { providers: Record<string, { api: string; models: Array<{ id: string; compat?: { forceAdaptiveThinking?: boolean } }> }> }
    expect(providers[PI_POOL_PROVIDER]).toMatchObject({ api: 'anthropic-messages', models: [{ id: 'claude-best' }, { id: 'claude-legacy' }] })
    expect(providers[PI_OPENAI_POOL_PROVIDER]).toMatchObject({ api: 'openai-completions', models: [{ id: 'glm-best' }] })
    expect(providers[PI_CODEX_POOL_PROVIDER]).toBeUndefined()
    expect(providers[PI_POOL_PROVIDER]?.models.find((model) => model.id === 'claude-best')?.compat).toEqual({ forceAdaptiveThinking: true })
    expect(providers[PI_POOL_PROVIDER]?.models.find((model) => model.id === 'claude-legacy')?.compat).toBeUndefined()
    expect(providers[PI_OPENAI_POOL_PROVIDER]?.models[0]?.compat).toBeUndefined()
    for (const provider of [providers[PI_POOL_PROVIDER]!, providers[PI_OPENAI_POOL_PROVIDER]!]) {
      expect(provider.models[0]).toMatchObject({ reasoning: true, input: ['text', 'image'] })
    }
  })

  test('a mixed rotation is listed under both providers; a codex-only pool needs neither', async () => {
    const json = piPoolModelsJson({ baseUrl: 'http://127.0.0.1:47120', rotations: ['mixed'], openaiRotations: ['mixed'], codexModels: ['gpt-5.5'] })
    const providers = json.providers as Record<string, { api: string; models: Array<{ id: string }> }>
    expect(providers[PI_POOL_PROVIDER]?.models.map((m) => m.id)).toEqual(['mixed'])
    expect(providers[PI_OPENAI_POOL_PROVIDER]?.models.map((m) => m.id)).toEqual(['mixed'])
    expect(providers[PI_CODEX_POOL_PROVIDER]?.models.map((m) => m.id)).toEqual(['gpt-5.5'])
  })
})

describe('writePiPoolAgentDir', () => {
  test('writes both pool providers, keeps existing ones, and pins the sse transport', async () => {
    const agentDir = path.join(tempDataDir('pi-pool-'), 'agent')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: 'http://localhost', models: [] } } }))
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    writePiPoolAgentDir({ agentDir, baseUrl: 'http://127.0.0.1:47120', rotations: ['claude-best'], openaiRotations: ['glm-best'] })
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')) as { providers: Record<string, { api: string; baseUrl: string }> }
    expect(Object.keys(models.providers).sort()).toEqual(['fake', PI_POOL_PROVIDER, PI_OPENAI_POOL_PROVIDER])
    expect(models.providers[PI_POOL_PROVIDER]).toMatchObject({ api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:47120' })
    expect(models.providers[PI_OPENAI_POOL_PROVIDER]).toMatchObject({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:47120' })
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings).toEqual({ theme: 'dark', transport: 'sse' })
  })
})
