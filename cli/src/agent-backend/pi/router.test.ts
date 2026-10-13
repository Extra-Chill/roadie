// Per-channel backend choice (#51) and the Pi default (#177): Pi channels see
// Pi's catalog and logins, the Pi default creates every new session in Pi, and
// a session the fallback backend owns keeps working through it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { AgentRequestError, type AgentBackend, type AgentBackendProvider, type AgentCommand } from '../types.js'
import { backendChannelId, checkPiVersion } from '../registry.js'
import { PiBackendProvider } from './backend.js'
import { withPiChannels, withPiDefault } from './router.js'

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

describe('withPiDefault', () => {
  const LEGACY_SESSION = { id: 'ses_legacy', title: 'Legacy', directory: '/p', createdAt: 1, updatedAt: 2 }
  const PI_SESSION = { id: 'pi_new', title: 'Pi', directory: '/p', createdAt: 3, updatedAt: 4 }

  /** A PiBackendProvider stand-in: `owns` decides routing, nothing spawns. */
  function fakePi(calls: string[]): PiBackendProvider {
    return {
      owns: (sessionId: string) => sessionId.startsWith('pi_'),
      getBackend: () => ({
        sessions: {
          create: async () => {
            calls.push('pi.create')
            return PI_SESSION
          },
          get: async () => new AgentRequestError({ detail: 'no such Pi session' }),
          list: async () => {
            calls.push('pi.list')
            return [PI_SESSION]
          },
          status: async () => ({ pi_new: { state: 'idle' } }),
          questions: async () => [],
        },
        catalog: { providers: async () => ({ providers: [], connected: [], defaults: {} }), config: async () => ({}), agents: async () => [{ name: 'pi-agent', mode: 'primary' }] },
        auth: { methods: async () => ({}) },
        mcp: {
          addRemote: async () => undefined,
          status: async () => ({ pi_server: { status: 'connected' } }),
          connect: async () => undefined,
          disconnect: async () => undefined,
        },
      } as unknown as AgentBackend),
    } as unknown as PiBackendProvider
  }

  /** A fallback provider whose server is down (getBackend null) until initialized. */
  function lazyFallback(calls: string[]): AgentBackendProvider {
    return {
      id: 'fake-oc',
      getBackend: () => null,
      initializeForDirectory: async (directory) => {
        calls.push(`fallback.initialize:${directory}`)
        return () => ({
          sessions: {
            get: async ({ sessionId }: { sessionId: string }) => ({ ...LEGACY_SESSION, id: sessionId }),
            list: async () => [LEGACY_SESSION],
            status: async () => ({}),
            replyPermission: async () => new AgentRequestError({ detail: 'no such request' }),
          },
          catalog: { providers: async () => ({ providers: [], connected: [], defaults: {} }), config: async () => ({}), agents: async () => [] },
          auth: { methods: async () => ({ oc: [{ type: 'oauth' as const, label: 'OC' }] }) },
        } as unknown as AgentBackend)
      },
      subscribeEvents: () => null,
      onStarted: () => {},
    }
  }

  test('new sessions are created in Pi and initializing a directory does not start the fallback', async () => {
    const calls: string[] = []
    const provider = withPiDefault({ fallback: lazyFallback(calls), pi: fakePi(calls) })
    expect(provider.id).toBe('pi+fake-oc')
    const getBackend = await provider.initializeForDirectory('/p', {})
    if (getBackend instanceof Error) throw getBackend
    expect(calls).toEqual([])
    const backend = getBackend()
    // The catalog is Pi's while OpenCode is down.
    expect(await backend.catalog.agents({})).toEqual([{ name: 'pi-agent', mode: 'primary' }])
    expect(await backend.sessions.create({ directory: '/p' })).toEqual(PI_SESSION)
    expect(calls).toEqual(['pi.create'])
  })

  test('a session id Pi does not own routes to the fallback, starting it on first use', async () => {
    const calls: string[] = []
    const provider = withPiDefault({ fallback: lazyFallback(calls), pi: fakePi(calls) })
    const getBackend = await provider.initializeForDirectory('/p', {})
    if (getBackend instanceof Error) throw getBackend
    const backend = getBackend()
    expect(await backend.sessions.get({ sessionId: 'ses_legacy' })).toEqual(LEGACY_SESSION)
    expect(calls).toEqual(['fallback.initialize:/p'])
    // A second use goes through the same started fallback, not a new start.
    expect(await backend.sessions.get({ sessionId: 'ses_legacy2' })).toEqual({ ...LEGACY_SESSION, id: 'ses_legacy2' })
    expect(calls).toEqual(['fallback.initialize:/p'])
  })

  test('listings, status and MCP merge across backends without starting the fallback', async () => {
    const calls: string[] = []
    const provider = withPiDefault({ fallback: lazyFallback(calls), pi: fakePi(calls) })
    const getBackend = await provider.initializeForDirectory('/p', {})
    if (getBackend instanceof Error) throw getBackend
    const backend = getBackend()
    expect(await backend.sessions.list({ directory: '/p' })).toEqual([PI_SESSION])
    expect(await backend.sessions.status({ directory: '/p' })).toEqual({ pi_new: { state: 'idle' } })
    expect(await backend.mcp!.status({ directory: '/p' })).toEqual({ pi_server: { status: 'connected' } })
    expect(calls).toEqual(['pi.list'])
  })

  test('an initialized fallback joins listings, and the composite serves both backends', async () => {
    const calls: string[] = []
    const fallback = lazyFallback(calls)
    const provider = withPiDefault({ fallback, pi: fakePi(calls) })
    // The OpenCode server is up: getBackend returns it without initializing.
    fallback.getBackend = () => ({
      sessions: {
        list: async () => [LEGACY_SESSION],
        get: async ({ sessionId }: { sessionId: string }) => ({ ...LEGACY_SESSION, id: sessionId }),
      },
    } as unknown as AgentBackend)
    const backend = provider.getBackend('/p')
    expect(backend).not.toBeNull()
    expect(await backend!.sessions.list({ directory: '/p' })).toEqual([LEGACY_SESSION, PI_SESSION])
    expect(await backend!.sessions.get({ sessionId: 'ses_legacy' })).toEqual(LEGACY_SESSION)
    // Only Pi listed; the fallback was already up, nothing needed initializing.
    expect(calls).toEqual(['pi.list'])
  })
})

describe('checkPiVersion', () => {
  test('accepts 1.x, rejects 0.x and a missing binary', () => {
    expect(checkPiVersion('pi', () => '1.1.0\n')).toBe('1.1.0')
    expect(checkPiVersion('pi', () => '0.73.1')).toBeInstanceOf(Error)
    expect(checkPiVersion('pi', () => { throw new Error('ENOENT') })).toBeInstanceOf(Error)
  })
})

