import { test, expect, describe, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildOpencodeServerConfig, buildRoadiePoolProviderConfig } from '../opencode.js'
import { setPoolRotation, SHARED_POOL_ID } from './store.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-config-'))
})

const BASE_CONFIG_ARGS = {
  externalDirectoryPermissions: { '*': 'allow' } as Record<string, 'ask' | 'allow' | 'deny'>,
  skillPermission: undefined,
  pluginList: ['file:///roadie/plugin.js', '@subrouter/opencode@0.5.1'],
}

describe('buildOpencodeServerConfig', () => {
  test('subrouter alias serves subrouter/<rotation> from the pool provider, only with a pool provider', () => {
    const pool = {
      name: 'Roadie credential pool',
      npm: 'file:///x/provider.js',
      options: {},
      models: { 'anthropic-claude-haiku-5-5': { name: 'Roadie pool anthropic-claude-haiku-5-5', tool_call: true } },
    }
    const aliased = buildOpencodeServerConfig({ ...BASE_CONFIG_ARGS, roadiePoolProvider: pool, subrouterAlias: true })
    expect(aliased.provider?.subrouter).toMatchObject({ npm: pool.npm, models: pool.models })
    const plain = buildOpencodeServerConfig({ ...BASE_CONFIG_ARGS, roadiePoolProvider: pool })
    expect(plain.provider?.subrouter).toBeUndefined()
    const noPool = buildOpencodeServerConfig({ ...BASE_CONFIG_ARGS, roadiePoolProvider: null, subrouterAlias: true })
    expect(noPool.provider?.subrouter).toBeUndefined()
  })

  test('flag off: no roadie provider, config unchanged', () => {
    const config = buildOpencodeServerConfig({ ...BASE_CONFIG_ARGS, roadiePoolProvider: null })
    expect(config.provider?.roadie).toBeUndefined()
    expect(config).toMatchInlineSnapshot(`
      {
        "$schema": "https://opencode.ai/config.json",
        "agent": {
          "explore": {
            "permission": {
              "*": "deny",
              "codesearch": "allow",
              "glob": "allow",
              "grep": "allow",
              "list": "allow",
              "read": {
                "*": "allow",
                "*.env": "deny",
                "*.env.*": "deny",
                "*.env.example": "allow",
              },
              "webfetch": "allow",
              "websearch": "allow",
            },
          },
        },
        "experimental": {
          "continue_loop_on_deny": true,
        },
        "formatter": false,
        "lsp": false,
        "permission": {
          "bash": "allow",
          "edit": "allow",
          "external_directory": {
            "*": "allow",
          },
          "webfetch": "allow",
        },
        "plugin": [
          "file:///roadie/plugin.js",
          "@subrouter/opencode@0.5.1",
        ],
        "provider": {
          "xai": {
            "models": {
              "grok-composer-2.5-fast": {
                "attachment": true,
                "cost": {
                  "cache_read": 0.2,
                  "input": 0.5,
                  "output": 2.5,
                },
                "limit": {
                  "context": 256000,
                  "output": 256000,
                },
                "name": "Grok Composer 2.5 Fast",
                "tool_call": true,
              },
            },
          },
        },
        "snapshot": false,
      }
    `)
  })

  test('flag on: provider.roadie is added with one model per rotation', () => {
    const config = buildOpencodeServerConfig({
      ...BASE_CONFIG_ARGS,
      roadiePoolProvider: {
        name: 'Roadie credential pool',
        npm: 'file:///roadie/dist/credentials/provider.js',
        options: {},
        models: {
          default: { name: 'Roadie pool default', tool_call: true },
        },
      },
    })
    expect(config.provider?.roadie).toEqual({
      name: 'Roadie credential pool',
      npm: 'file:///roadie/dist/credentials/provider.js',
      options: {},
      models: {
        default: { name: 'Roadie pool default', tool_call: true },
      },
    })
    // Everything else stays identical to the flag-off config.
    const provider = config.provider ?? {}
    const { roadie, ...rest } = provider
    expect(roadie).toBeDefined()
    expect(rest).toEqual(buildOpencodeServerConfig({ ...BASE_CONFIG_ARGS, roadiePoolProvider: null }).provider)
  })
})

describe('buildRoadiePoolProviderConfig', () => {
  test('null when the shared pool has no rotations', async () => {
    expect(await buildRoadiePoolProviderConfig({ dataDir, isDev: false })).toBeNull()
  })

  test('null when the only rotation is empty', async () => {
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: [] })
    expect(await buildRoadiePoolProviderConfig({ dataDir, isDev: false })).toBeNull()
  })

  test('one model per named rotation, sorted, loaded from the provider module', async () => {
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'zeta', entries: ['openai/gpt-5.1'] })
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })
    const config = await buildRoadiePoolProviderConfig({ dataDir, isDev: false })
    expect(config).toMatchObject({
      name: 'Roadie credential pool',
      options: {},
      models: {
        default: { name: 'Roadie pool default', tool_call: true },
        zeta: { name: 'Roadie pool zeta', tool_call: true },
      },
    })
    expect(config?.npm.endsWith('credentials/provider.js')).toBe(true)
    expect(config?.npm.startsWith('file://')).toBe(true)
  })

  test('dev mode points the npm URL at the TypeScript source', async () => {
    await setPoolRotation({ dataDir, poolId: SHARED_POOL_ID, name: 'default', entries: ['anthropic/claude-sonnet-4'] })
    const config = await buildRoadiePoolProviderConfig({ dataDir, isDev: true, baseURL: 'http://127.0.0.1:9/v1' })
    expect(config?.npm.endsWith('credentials/provider.ts')).toBe(true)
    expect(config?.options).toEqual({ baseURL: 'http://127.0.0.1:9/v1' })
  })
})
