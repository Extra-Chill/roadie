// Per-channel backend choice: Pi channels see Pi's catalog and logins; others keep the default.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AgentBackend, AgentBackendProvider, AgentCommand } from '../types.js'
import { backendChannelId, checkPiVersion } from '../registry.js'
import { PiBackendProvider } from './backend.js'
import { withPiChannels } from './router.js'

const fallbackBackend = {
  sessions: {},
  catalog: {
    providers: async () => ({ providers: [{ id: 'opencode-only', name: 'OC', models: {} }], connected: ['opencode-only'], defaults: {} }),
    config: async () => ({}),
    agents: async () => [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }],
  },
  auth: { methods: async () => ({ anthropic: [{ type: 'oauth', label: 'Claude' }] }) },
} as unknown as AgentBackend

const fallback: AgentBackendProvider = {
  id: 'fake',
  getBackend: () => fallbackBackend,
  initializeForDirectory: async () => () => fallbackBackend,
  subscribeEvents: () => null,
  onStarted: () => {},
}

describe('withPiChannels', () => {
  const sessionDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pi-router-'))
  const pi = new PiBackendProvider({ bin: 'pi', sessionDir, model: 'openai-codex/gpt-6-luna' })
  const provider = withPiChannels({ fallback, pi, channels: new Set(['pi-channel']) })

  test('a Pi channel gets Pi agents and config; any other channel the default', async () => {
    const piBackend = await provider.initializeForDirectory('/p', { channelId: 'pi-channel' })
    const other = await provider.initializeForDirectory('/p', { channelId: 'oc-channel' })
    if (piBackend instanceof Error || other instanceof Error) throw new Error('init failed')
    expect(await piBackend().catalog.config({})).toEqual({ model: 'openai-codex/gpt-6-luna' })
    expect((await piBackend().catalog.agents({})) instanceof Error).toBe(false)
    expect(await other().catalog.agents({})).toEqual([{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }])
    expect(await other().auth.methods({ directory: '/p' })).toEqual({ anthropic: [{ type: 'oauth', label: 'Claude' }] })
  })

  test('a thread resolves to its parent channel', () => {
    expect(backendChannelId({ id: 't1', isThread: () => true, parentId: 'pi-channel' })).toBe('pi-channel')
    expect(backendChannelId({ id: 'c1', isThread: () => false })).toBe('c1')
    expect(backendChannelId(null)).toBeUndefined()
  })
})

describe('withPiChannels command listings', () => {
  const sessionDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pi-router-commands-'))

  /** A Pi half with the given command listing (or failure), as ROADIE_PI_CHANNELS would build it. */
  function piWith(commands: Promise<AgentCommand[] | Error>): PiBackendProvider {
    return {
      getBackend: () => ({
        sessions: {},
        catalog: {
          providers: async () => ({ providers: [], connected: [], defaults: {} }),
          config: async () => ({}),
          agents: async () => [],
          commands: () => commands,
        },
        auth: { methods: async () => ({}), startOAuth: async () => new Error('no'), finishOAuth: async () => new Error('no'), setApiKey: async () => new Error('no') },
      }),
    } as unknown as PiBackendProvider
  }

  function fallbackWith(backend: AgentBackend | null): AgentBackendProvider {
    return {
      id: 'fake',
      getBackend: () => backend,
      initializeForDirectory: async () => backend ? () => backend : new Error('down'),
      subscribeEvents: () => null,
      onStarted: () => {},
    }
  }

  test('getBackend without a channel merges default and Pi commands, default first and deduplicated by name', async () => {
    const defaultBackend = {
      ...fallbackBackend,
      catalog: {
        ...fallbackBackend.catalog,
        commands: async () => [{ name: 'deploy', description: 'Deploy the app', source: 'command' as const }, { name: 'review', source: 'skill' as const }],
      },
    } as unknown as AgentBackend
    const routed = withPiChannels({
      fallback: fallbackWith(defaultBackend),
      pi: piWith(Promise.resolve([{ name: 'review', source: 'skill' as const }, { name: 'triage', description: 'Pi prompt', source: 'command' as const }])),
      channels: new Set(['pi-channel']),
    })
    const commands = await routed.getBackend('/p')!.catalog.commands!({ directory: '/p' })
    expect(commands).toEqual([
      { name: 'deploy', description: 'Deploy the app', source: 'command' },
      { name: 'review', source: 'skill' },
      { name: 'triage', description: 'Pi prompt', source: 'command' },
    ])
  })

  test('a down default backend still lists Pi commands (registration needs no OpenCode server)', async () => {
    const routed = withPiChannels({
      fallback: fallbackWith(null),
      pi: piWith(Promise.resolve([{ name: 'triage', source: 'command' as const }])),
      channels: new Set(['pi-channel']),
    })
    expect(await routed.getBackend('/p')!.catalog.commands!({ directory: '/p' })).toEqual([
      { name: 'triage', source: 'command' },
    ])
  })

  test('a failing Pi listing keeps the default commands; both failing returns the error', async () => {
    const boom = Promise.resolve(new Error('pi probe failed'))
    const empty = { ...fallbackBackend, catalog: { ...fallbackBackend.catalog, commands: async () => [] } } as unknown as AgentBackend
    const routed = withPiChannels({ fallback: fallbackWith(empty), pi: piWith(boom), channels: new Set(['pi-channel']) })
    expect(await routed.getBackend('/p')!.catalog.commands!({ directory: '/p' })).toEqual([])
    const both = withPiChannels({ fallback: fallbackWith(null), pi: piWith(boom), channels: new Set(['pi-channel']) })
    expect(await both.getBackend('/p')!.catalog.commands!({ directory: '/p' })).toBeInstanceOf(Error)
  })

  test('a Pi channel init merges commands the same way', async () => {
    const defaultBackend = {
      ...fallbackBackend,
      catalog: { ...fallbackBackend.catalog, commands: async () => [{ name: 'deploy', source: 'command' as const }] },
    } as unknown as AgentBackend
    const routed = withPiChannels({
      fallback: fallbackWith(defaultBackend),
      pi: piWith(Promise.resolve([{ name: 'deploy', source: 'command' as const }, { name: 'triage', source: 'command' as const }])),
      channels: new Set(['pi-channel']),
    })
    const getter = await routed.initializeForDirectory('/p', { channelId: 'pi-channel' })
    if (getter instanceof Error) throw getter
    expect(await getter().catalog.commands!({ directory: '/p' })).toEqual([
      { name: 'deploy', source: 'command' },
      { name: 'triage', source: 'command' },
    ])
  })
})

describe('checkPiVersion', () => {
  test('accepts 1.x, rejects 0.x and a missing binary', () => {
    expect(checkPiVersion('pi', () => '1.1.0\n')).toBe('1.1.0')
    expect(checkPiVersion('pi', () => '0.73.1')).toBeInstanceOf(Error)
    expect(checkPiVersion('pi', () => { throw new Error('ENOENT') })).toBeInstanceOf(Error)
  })
})

