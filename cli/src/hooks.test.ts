import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  addAction,
  addFilter,
  applyFilters,
  applyFiltersAsync,
  doAction,
  hasFilter,
  removeFilter,
  resetHooks,
} from './hooks.js'
import { loadPlugins, resolvePluginSpecs } from './plugins.js'
import { getAgentBackendProvider, resolveAgentBackendProvider, withCatalogFilters } from './agent-backend/registry.js'
import { openCodeBackendProvider } from './agent-backend/opencode.js'
import type { AgentBackendProvider } from './agent-backend/types.js'
import { isChannelPolicyConfigured, resolveChannelPolicy, setChannelsConfigPath } from './channel-policy.js'
import { isContextProviderConfigured, requestContext, setContextProviderCommand } from './context-provider.js'
import { clearIdentityCache, getCachedPerson, isIdentityHookConfigured, resolvePerson, setIdentityHookCommand } from './identity.js'
import { getOpencodeSystemMessage } from './system-message.js'

const savedPlugins = process.env.ROADIE_PLUGINS
afterEach(() => {
  resetHooks()
  resolveAgentBackendProvider()
  clearIdentityCache()
  if (savedPlugins === undefined) delete process.env.ROADIE_PLUGINS
  else process.env.ROADIE_PLUGINS = savedPlugins
})

describe('filters', () => {
  test('lower priority runs first; ties keep registration order', () => {
    addFilter('demo', (v: unknown) => `${v}b`, { priority: 20 })
    addFilter('demo', (v: unknown) => `${v}a`, { priority: 5 })
    addFilter('demo', (v: unknown) => `${v}c`, { priority: 20 })
    expect(applyFilters('demo', '', {})).toBe('abc')
  })

  test('removal by function or by the returned handle', () => {
    const upper = (v: unknown) => String(v).toUpperCase()
    const exclaim = (v: unknown) => `${v}!`
    addFilter('demo', upper)
    const off = addFilter('demo', exclaim)
    expect(applyFilters('demo', 'x', {})).toBe('X!')
    off()
    expect(removeFilter('demo', upper)).toBe(true)
    expect(hasFilter('demo')).toBe(false)
    expect(applyFilters('demo', 'x', {})).toBe('x')
  })

  test('a throwing callback is skipped and the chain continues', async () => {
    addFilter('demo', () => { throw new Error('boom') })
    addFilter('demo', (v: unknown) => `${v}+`)
    expect(applyFilters('demo', 'v', {})).toBe('v+')
    expect(await applyFiltersAsync('demo', 'v', {})).toBe('v+')
  })

  test('sync chains skip promise-returning callbacks; async chains await them', async () => {
    addFilter('demo', async (v: unknown) => `${v}async`)
    addFilter('demo', (v: unknown) => `${v}sync`)
    expect(applyFilters('demo', '', {})).toBe('sync')
    expect(await applyFiltersAsync('demo', '', {})).toBe('asyncsync')
  })

  test('context reaches every callback', () => {
    addFilter('demo', (v: unknown, ctx: unknown) => `${v}${(ctx as { tag: string }).tag}`)
    expect(applyFilters('demo', '', { tag: 'ctx' })).toBe('ctx')
  })
})

describe('actions', () => {
  test('run in priority order and survive failures', async () => {
    const calls: string[] = []
    addAction('demo', () => { calls.push('late') }, { priority: 50 })
    addAction('demo', () => { throw new Error('boom') })
    addAction('demo', async () => { calls.push('early') }, { priority: 1 })
    await doAction('demo', {})
    expect(calls).toEqual(['early', 'late'])
  })
})

describe('plugins', () => {
  function writePlugin(body: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-plugin-'))
    const file = path.join(dir, 'plugin.mjs')
    fs.writeFileSync(file, body)
    return file
  }

  test('specs come from flags, then ROADIE_PLUGINS, without duplicates', () => {
    process.env.ROADIE_PLUGINS = 'b, c\na'
    expect(resolvePluginSpecs(['a', ' '])).toEqual(['a', 'b', 'c'])
  })

  test('register(roadie) adds hooks, named or default export', async () => {
    const named = writePlugin(`export function register(roadie) { roadie.addFilter('demo', (v) => v + 'n') }`)
    const fallback = writePlugin(`export default (roadie) => { roadie.addFilter('demo', (v) => v + 'd', { priority: 20 }) }`)
    expect(await loadPlugins([named, fallback])).toEqual([named, fallback])
    expect(applyFilters('demo', '', {})).toBe('nd')
  })

  test('a plugin that fails to load or lacks register is an error', async () => {
    expect(await loadPlugins(['/nope/missing-plugin.mjs'])).toBeInstanceOf(Error)
    const bad = writePlugin(`export const notRegister = 1`)
    const result = await loadPlugins([bad])
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/register/)
  })
})

describe('built-in seams honor their filters', () => {
  test('agent_backend replaces the provider once resolved', () => {
    const fake = { ...openCodeBackendProvider, id: 'fake' } as AgentBackendProvider
    addFilter('agent_backend', () => fake)
    expect(getAgentBackendProvider().id).toBe('opencode')
    resolveAgentBackendProvider()
    expect(getAgentBackendProvider().id).toBe('fake')
  })

  test('channel_policy can supply a policy without a config file', () => {
    setChannelsConfigPath(null)
    expect(isChannelPolicyConfigured()).toBe(false)
    expect(resolveChannelPolicy('c1')).toBeUndefined()
    addFilter('channel_policy', (policy, { channelId }) => (channelId === 'c1' ? { respond: 'mention' as const } : policy))
    expect(isChannelPolicyConfigured()).toBe(true)
    expect(resolveChannelPolicy('c1')).toEqual({ respond: 'mention' })
    expect(resolveChannelPolicy('c2')).toBeUndefined()
    setChannelsConfigPath(undefined)
  })

  test('person can come from a plugin, and an unvouched actor is denied', async () => {
    setIdentityHookCommand(null)
    expect(await resolvePerson({ actor: { platform: 'discord', id: 'u1' } })).toBeNull()
    addFilter('person', async (person, { actor }) =>
      actor.id === 'u1'
        ? { allowed: true, personId: 'p1', capabilities: new Set(['sessions'] as const), permissions: [] }
        : person,
    )
    expect(isIdentityHookConfigured()).toBe(true)
    const person = await resolvePerson({ actor: { platform: 'discord', id: 'u1' } })
    expect(person?.personId).toBe('p1')
    expect(getCachedPerson({ platform: 'discord', id: 'u1' })?.personId).toBe('p1')
    expect((await resolvePerson({ actor: { platform: 'discord', id: 'u2' } }))?.allowed).toBe(false)
    setIdentityHookCommand(undefined)
  })

  test('context_sections can add host context without a provider command', async () => {
    setContextProviderCommand(null)
    expect(await requestContext({ event: 'turn', sessionId: 's1' })).toEqual([])
    addFilter('context_sections', async (sections, request) => [
      ...sections,
      { id: 'memory', content: `remembered for ${request.sessionId}` },
    ])
    expect(isContextProviderConfigured()).toBe(true)
    expect(await requestContext({ event: 'turn', sessionId: 's1' })).toEqual([
      { id: 'memory', content: 'remembered for s1' },
    ])
    setContextProviderCommand(undefined)
  })

  test('system_prompt_sections can drop and add sections', () => {
    const before = getOpencodeSystemMessage({ sessionId: 's1' })
    expect(before).toContain('## diagrams')
    addFilter('system_prompt_sections', (sections) => [
      ...sections.filter((s) => s.id !== 'diagrams'),
      { id: 'house-rules', text: '\n## house rules\nBe kind.\n' },
    ])
    const after = getOpencodeSystemMessage({ sessionId: 's1' })
    expect(after).not.toContain('## diagrams')
    expect(after).toContain('## house rules')
  })

  test('agent_providers and agent_definitions filter any backend catalog', async () => {
    const catalog = withCatalogFilters({
      providers: async () => ({
        providers: [{ id: 'a', name: 'A', models: { keep: { id: 'keep', name: 'Keep', variants: [] }, drop: { id: 'drop', name: 'Drop', variants: [] } } }],
        connected: ['a'],
        defaults: {},
      }),
      config: async () => ({}),
      agents: async () => [{ name: 'build', mode: 'primary' }, { name: 'secret', mode: 'primary' }],
    })
    addFilter('agent_providers', (value) => ({
      ...value,
      providers: value.providers.map((p) => ({ ...p, models: { keep: p.models.keep! } })),
    }))
    addFilter('agent_definitions', (agents) => agents.filter((a) => a.name !== 'secret'))
    const providers = await catalog.providers({})
    if (providers instanceof Error) throw providers
    expect(Object.keys(providers.providers[0]!.models)).toEqual(['keep'])
    expect(await catalog.agents({})).toEqual([{ name: 'build', mode: 'primary' }])
  })
})
