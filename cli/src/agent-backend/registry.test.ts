// The session runtime resolves its agent backend through the registry, so an
// injected provider receives the calls, and the default backend is Pi: the
// only backend Roadie runs (#177).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  piSettingsDefaultModel,
  resolvePiAgentDir,
  clearResolvedDefaultProvider,
  getAgentBackendProvider,
  isRetiredSession,
  resolveAgentBackendProvider,
  setAgentBackendProvider,
} from './registry.js'
import type { AgentBackend, AgentBackendProvider } from './types.js'
import {
  clearModelListCache,
  validateCliModelOption,
} from '../session-handler/model-utils.js'

function fakeProvider(calls: string[]): AgentBackendProvider {
  const backend = {
    catalog: {
      providers: async ({ directory }: { directory?: string }) => {
        calls.push(`catalog.providers:${directory}`)
        return {
          providers: [{ id: 'fake', name: 'Fake', models: { 'model-1': { id: 'model-1', name: 'Model 1' } } }],
          connected: ['fake'],
          defaults: {},
        }
      },
      config: async () => ({}),
      agents: async () => [],
    },
  } as unknown as AgentBackend
  return {
    id: 'fake',
    owns: (sessionId) => sessionId.startsWith('fake-'),
    getBackend: () => backend,
    initializeForDirectory: async (directory) => {
      calls.push(`initialize:${directory}`)
      return () => backend
    },
    subscribeEvents: () => null,
    onStarted: () => {},
  }
}

describe('agent backend registry', () => {
  let restore: (() => void) | undefined

  afterEach(() => {
    restore?.()
    restore = undefined
    clearModelListCache()
  })

  test('before resolution the placeholder provider owns no session', () => {
    expect(getAgentBackendProvider().id).toBe('unresolved')
    expect(isRetiredSession('anything')).toBe(true)
  })

  test('session runtime model validation goes through the injected backend', async () => {
    const calls: string[] = []
    restore = setAgentBackendProvider(fakeProvider(calls))

    const result = await validateCliModelOption({
      model: 'fake/model-1',
      directory: '/tmp/roadie-backend-seam',
    })

    expect(result).toEqual({ providerID: 'fake', modelID: 'model-1' })
    expect(calls).toEqual([
      'initialize:/tmp/roadie-backend-seam',
      'catalog.providers:/tmp/roadie-backend-seam',
    ])
  })

  test('sessions the backend does not own are retired', () => {
    restore = setAgentBackendProvider(fakeProvider([]))
    expect(isRetiredSession('fake-1')).toBe(false)
    expect(isRetiredSession('ses_legacy')).toBe(true)
  })

  test('restore function reinstates the previous provider', () => {
    const undo = setAgentBackendProvider(fakeProvider([]))
    expect(getAgentBackendProvider().id).toBe('fake')
    undo()
    expect(getAgentBackendProvider().id).toBe('unresolved')
  })
})

describe('default backend resolution (#177)', () => {
  const savedEnv: Array<[string, string | undefined]> = []

  /** A `pi` stand-in whose --version satisfies the registry's 1.x check. */
  function writePiVersionShim(dir: string, version = '1.2.3'): string {
    const shim = path.join(dir, `fake-pi-${version}`)
    fs.writeFileSync(shim, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 })
    return shim
  }

  function withEnv(name: string, value: string | undefined): void {
    savedEnv.push([name, process.env[name]])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  beforeEach(() => {
    clearResolvedDefaultProvider()
  })

  afterEach(() => {
    for (const [name, value] of savedEnv.reverse()) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    savedEnv.length = 0
    clearResolvedDefaultProvider()
  })

  test('Pi is the backend', () => {
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'registry-pi-default-'))
    withEnv('ROADIE_BACKEND', undefined)
    withEnv('ROADIE_PI_BIN', writePiVersionShim(tmp))
    withEnv('ROADIE_PI_SESSION_DIR', path.join(tmp, 'pi-sessions'))
    expect(resolveAgentBackendProvider().id).toBe('pi')
    expect(getAgentBackendProvider().id).toBe('pi')
  })

  test('a missing or outdated pi binary fails startup', () => {
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'registry-pi-missing-'))
    withEnv('ROADIE_BACKEND', undefined)
    withEnv('ROADIE_PI_BIN', path.join(tmp, 'no-such-pi'))
    withEnv('ROADIE_PI_SESSION_DIR', path.join(tmp, 'pi-sessions'))
    expect(() => resolveAgentBackendProvider()).toThrow(/install Pi/)
    clearResolvedDefaultProvider()
    withEnv('ROADIE_PI_BIN', writePiVersionShim(tmp, '0.9.0'))
    expect(() => resolveAgentBackendProvider()).toThrow(/Pi 1.x or newer/)
  })

  test('ROADIE_BACKEND only accepts pi', () => {
    for (const value of ['opencode', 'claude']) {
      clearResolvedDefaultProvider()
      withEnv('ROADIE_BACKEND', value)
      expect(() => resolveAgentBackendProvider()).toThrow(/ROADIE_BACKEND must be "pi"/)
    }
  })
})

describe('Pi default model from settings.json', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-settings-'))
  test('reads defaultProvider/defaultModel as provider/model', () => {
    const agentDir = dir()
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ transport: 'sse', defaultProvider: 'openai-codex', defaultModel: 'gpt-6-luna' }))
    expect(piSettingsDefaultModel(agentDir)).toBe('openai-codex/gpt-6-luna')
  })
  test('a partial, missing or unreadable setting gives no model', () => {
    const agentDir = dir()
    expect(piSettingsDefaultModel(agentDir)).toBeUndefined()
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'gpt-6-luna' }))
    expect(piSettingsDefaultModel(agentDir)).toBeUndefined()
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{not json')
    expect(piSettingsDefaultModel(agentDir)).toBeUndefined()
    expect(piSettingsDefaultModel(undefined)).toBeUndefined()
  })
})

describe('Pi agent dir outside the pool-owning process', () => {
  const tmp = () => fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pi-agent-dir-'))

  test('a running pool wins and is passed to Pi', () => {
    expect(resolvePiAgentDir({ pool: { agentDir: '/pool' }, env: { PI_CODING_AGENT_DIR: '/explicit' } })).toEqual({
      agentDir: '/pool',
      env: { PI_CODING_AGENT_DIR: '/pool' },
    })
  })

  test('an explicit PI_CODING_AGENT_DIR is kept as is', () => {
    expect(resolvePiAgentDir({ env: { PI_CODING_AGENT_DIR: '/explicit' }, dataDir: tmp() })).toEqual({ agentDir: '/explicit', env: {} })
  })

  test('a CLI child of the bot reads the pool agent dir the bot wrote', () => {
    // `roadie session search` from an agent shell runs in a bot child that
    // never starts the pools; without this, ROADIE_PI_MODEL=roadie/opus was
    // "not found" because Pi read ~/.pi/agent.
    const dataDir = tmp()
    fs.mkdirSync(path.join(dataDir, 'pi-agent'))
    fs.writeFileSync(path.join(dataDir, 'pi-agent', 'models.json'), '{}')
    expect(resolvePiAgentDir({ env: {}, dataDir })).toEqual({
      agentDir: path.join(dataDir, 'pi-agent'),
      env: { PI_CODING_AGENT_DIR: path.join(dataDir, 'pi-agent') },
    })
  })

  test('ROADIE_PI_AGENT_DIR locates the written pool dir', () => {
    const custom = tmp()
    fs.writeFileSync(path.join(custom, 'models.json'), '{}')
    expect(resolvePiAgentDir({ env: { ROADIE_PI_AGENT_DIR: custom }, dataDir: tmp() }).agentDir).toBe(custom)
  })

  test("without a written pool dir Pi keeps its own default", () => {
    const result = resolvePiAgentDir({ env: {}, dataDir: tmp() })
    expect(result.env).toEqual({})
    expect(result.agentDir).toBe(path.join(os.homedir(), '.pi', 'agent'))
  })
})
