// The session runtime resolves its agent backend through the registry, so an
// injected provider receives the calls instead of OpenCode, and the default
// backend comes from ROADIE_BACKEND (--backend): Pi unless OpenCode is asked
// for explicitly (#177).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  piSettingsDefaultModel,
  clearResolvedDefaultProvider,
  getAgentBackendProvider,
  resolveAgentBackendProvider,
  setAgentBackendProvider,
} from './registry.js'
import { openCodeBackendProvider } from './opencode.js'
import type { AgentBackendProvider } from './types.js'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { toOpenCodeBackend } from './opencode-sessions.js'
import {
  clearModelListCache,
  validateCliModelOption,
} from '../session-handler/model-utils.js'

function fakeProvider(calls: string[]): AgentBackendProvider {
  const backend = toOpenCodeBackend({
    config: {
      providers: async ({ directory }: { directory?: string }) => {
        calls.push(`config.providers:${directory}`)
        return {
          data: {
            providers: [
              {
                id: 'fake',
                name: 'Fake',
                models: { 'model-1': { id: 'model-1', name: 'Model 1' } },
              },
            ],
            default: {},
          },
        }
      },
    },
  } as unknown as OpencodeClient)
  return {
    id: 'fake',
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

  test('before resolution the runtime placeholder provider is OpenCode', () => {
    expect(getAgentBackendProvider().id).toBe(openCodeBackendProvider.id)
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
      'config.providers:/tmp/roadie-backend-seam',
    ])
  })

  test('restore function reinstates the previous provider', () => {
    const undo = setAgentBackendProvider(fakeProvider([]))
    expect(getAgentBackendProvider().id).toBe('fake')
    undo()
    expect(getAgentBackendProvider().id).toBe(openCodeBackendProvider.id)
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
    vi.restoreAllMocks()
  })

  test('Pi is the default backend', () => {
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'registry-pi-default-'))
    withEnv('ROADIE_BACKEND', undefined)
    withEnv('ROADIE_PI_CHANNELS', undefined)
    withEnv('ROADIE_PI_BIN', writePiVersionShim(tmp))
    withEnv('ROADIE_PI_SESSION_DIR', path.join(tmp, 'pi-sessions'))
    expect(resolveAgentBackendProvider().id).toBe('pi+opencode')
    expect(getAgentBackendProvider().id).toBe('pi+opencode')
  })

  test('ROADIE_BACKEND=opencode restores the OpenCode default without the Pi composition', () => {
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'registry-oc-default-'))
    withEnv('ROADIE_BACKEND', 'opencode')
    withEnv('ROADIE_PI_CHANNELS', undefined)
    withEnv('ROADIE_PI_BIN', writePiVersionShim(tmp))
    expect(resolveAgentBackendProvider().id).toBe('opencode')
  })

  test('under ROADIE_BACKEND=opencode, ROADIE_PI_CHANNELS keeps opting channels into Pi (deprecated)', () => {
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'registry-oc-channels-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withEnv('ROADIE_BACKEND', 'opencode')
    withEnv('ROADIE_PI_CHANNELS', 'ch-pi')
    withEnv('ROADIE_PI_BIN', writePiVersionShim(tmp))
    withEnv('ROADIE_PI_SESSION_DIR', path.join(tmp, 'pi-sessions'))
    expect(resolveAgentBackendProvider().id).toBe('opencode+pi')
    expect(warn.mock.calls.some(([line]) => String(line).includes('deprecated'))).toBe(true)
  })

  test('ROADIE_PI_CHANNELS is ignored while Pi is the default', () => {
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'registry-pi-channels-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withEnv('ROADIE_BACKEND', undefined)
    withEnv('ROADIE_PI_CHANNELS', 'ch-pi')
    withEnv('ROADIE_PI_BIN', writePiVersionShim(tmp))
    withEnv('ROADIE_PI_SESSION_DIR', path.join(tmp, 'pi-sessions'))
    expect(resolveAgentBackendProvider().id).toBe('pi+opencode')
    expect(warn.mock.calls.some(([line]) => String(line).includes('ignored'))).toBe(true)
  })

  test('a missing or outdated pi binary fails startup when Pi is the default, unless ROADIE_BACKEND=opencode', () => {
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'registry-pi-missing-'))
    withEnv('ROADIE_BACKEND', undefined)
    withEnv('ROADIE_PI_CHANNELS', undefined)
    withEnv('ROADIE_PI_BIN', path.join(tmp, 'no-such-pi'))
    withEnv('ROADIE_PI_SESSION_DIR', path.join(tmp, 'pi-sessions'))
    expect(() => resolveAgentBackendProvider()).toThrow(/ROADIE_BACKEND=opencode/)

    // Opting back into OpenCode must not require Pi at all.
    clearResolvedDefaultProvider()
    withEnv('ROADIE_BACKEND', 'opencode')
    expect(resolveAgentBackendProvider().id).toBe('opencode')
  })

  test('an invalid ROADIE_BACKEND value is a startup error, never a fallback', () => {
    withEnv('ROADIE_BACKEND', 'claude')
    expect(() => resolveAgentBackendProvider()).toThrow(/ROADIE_BACKEND must be/)
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
