// Per-channel backend choice: Pi channels see Pi's catalog and logins; others keep the default.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AgentBackend, AgentBackendProvider } from '../types.js'
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

describe('checkPiVersion', () => {
  test('accepts 1.x, rejects 0.x and a missing binary', () => {
    expect(checkPiVersion('pi', () => '1.1.0\n')).toBe('1.1.0')
    expect(checkPiVersion('pi', () => '0.73.1')).toBeInstanceOf(Error)
    expect(checkPiVersion('pi', () => { throw new Error('ENOENT') })).toBeInstanceOf(Error)
  })
})

