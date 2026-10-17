import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  getChatPlatform,
  listChatPlatformIds,
  parseChatPlatformIds,
  registerChatPlatform,
  resetChatPlatforms,
  startChatPlatforms,
  stopActiveChatPlatforms,
  unregisterChatPlatform,
  type ChatPlatformDefinition,
} from './registry.js'
import { registerBuiltinChatPlatforms } from './builtin.js'
import { loadPlugins } from '../plugins.js'

const context = { platformIds: [] as string[], options: {} }

function platform(id: string, events: string[], { fail = false } = {}): ChatPlatformDefinition {
  return {
    id,
    start: async () => {
      if (fail) return new Error(`${id} refused`)
      events.push(`start:${id}`)
      return { stop: async () => void events.push(`stop:${id}`) }
    },
  }
}

afterEach(async () => {
  await stopActiveChatPlatforms()
  resetChatPlatforms()
})

describe('registerChatPlatform', () => {
  test('rejects invalid ids and missing start', () => {
    for (const id of ['', 'Slack', '1chat', 'has space', 'über']) {
      expect(registerChatPlatform({ id, start: async () => ({ stop: async () => {} }) })).toBeInstanceOf(Error)
    }
    expect(
      registerChatPlatform({ id: 'no-start' } as unknown as ChatPlatformDefinition),
    ).toBeInstanceOf(Error)
    expect(listChatPlatformIds()).toEqual([])
  })

  test('rejects duplicates and names the earlier source', () => {
    expect(registerChatPlatform(platform('host-chat', []), { source: 'my-plugin' })).toBeUndefined()
    const duplicate = registerChatPlatform(platform('host-chat', []))
    expect(duplicate).toBeInstanceOf(Error)
    expect((duplicate as Error).message).toContain('my-plugin')
    expect(getChatPlatform('host-chat')).toBeDefined()
  })
})

describe('parseChatPlatformIds', () => {
  test('defaults to discord', () => {
    expect(parseChatPlatformIds(undefined)).toEqual(['discord'])
    expect(parseChatPlatformIds('')).toEqual(['discord'])
    expect(parseChatPlatformIds([' '])).toEqual(['discord'])
  })

  test('accepts one id, repeated flags and comma lists, deduplicated in order', () => {
    expect(parseChatPlatformIds('slack')).toEqual(['slack'])
    expect(parseChatPlatformIds('discord, slack')).toEqual(['discord', 'slack'])
    expect(parseChatPlatformIds(['discord,host-chat', 'discord', 'slack'])).toEqual([
      'discord',
      'host-chat',
      'slack',
    ])
  })
})

describe('startChatPlatforms', () => {
  test('unknown ids fail before anything starts, naming the registered platforms', async () => {
    const events: string[] = []
    registerChatPlatform(platform('alpha', events))
    const result = await startChatPlatforms({ ...context, platformIds: ['alpha', 'missing'] })
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('missing')
    expect((result as Error).message).toContain('alpha')
    expect(events).toEqual([])
  })

  test('starts in order and stops newest first', async () => {
    const events: string[] = []
    registerChatPlatform(platform('alpha', events))
    registerChatPlatform(platform('beta', events))
    const handle = await startChatPlatforms({ ...context, platformIds: ['alpha', 'beta'] })
    if (handle instanceof Error) throw handle
    expect(events).toEqual(['start:alpha', 'start:beta'])
    await handle.stop()
    expect(events).toEqual(['start:alpha', 'start:beta', 'stop:beta', 'stop:alpha'])
    // Idempotent: a second stop (e.g. signal plus test teardown) is a no-op.
    await handle.stop()
    expect(events).toHaveLength(4)
  })

  test('a failing platform rolls back the ones already running', async () => {
    const events: string[] = []
    registerChatPlatform(platform('alpha', events))
    registerChatPlatform(platform('broken', events, { fail: true }))
    const result = await startChatPlatforms({ ...context, platformIds: ['alpha', 'broken'] })
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('broken failed to start')
    expect(events).toEqual(['start:alpha', 'stop:alpha'])
  })
})

describe('built-in platforms', () => {
  test('discord and slack register through the registry; re-running is a no-op', () => {
    registerBuiltinChatPlatforms()
    registerBuiltinChatPlatforms()
    expect(listChatPlatformIds()).toEqual(['discord', 'slack'])
  })

  test('a plugin cannot shadow a built-in platform id', async () => {
    registerBuiltinChatPlatforms()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-platform-plugin-'))
    const spec = path.join(dir, 'shadow.mjs')
    fs.writeFileSync(
      spec,
      'export function register(roadie) { roadie.registerChatPlatform({ id: "discord", start: async () => ({ stop: async () => {} }) }) }\n',
    )
    const result = await loadPlugins([spec])
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('already registered')
  })
})

describe('plugin-registered platforms', () => {
  test('a platform registered through register(roadie) starts and stops', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-platform-plugin-'))
    const spec = path.join(dir, 'host-chat.mjs')
    fs.writeFileSync(
      spec,
      [
        'export function register(roadie) {',
        '  roadie.registerChatPlatform({',
        "    id: 'host-chat',",
        '    start: async (context) => {',
        "      globalThis.__hostChatEvents.push(`start:${context.platformIds.join('+')}`)",
        "      return { stop: async () => globalThis.__hostChatEvents.push('stop') }",
        '    },',
        '  })',
        '}',
        '',
      ].join('\n'),
    )
    const events: string[] = []
    ;(globalThis as Record<string, unknown>).__hostChatEvents = events
    try {
      const loaded = await loadPlugins([spec])
      if (loaded instanceof Error) throw loaded
      expect(listChatPlatformIds()).toContain('host-chat')
      const handle = await startChatPlatforms({ options: {}, platformIds: ['host-chat'] })
      if (handle instanceof Error) throw handle
      expect(events).toEqual(['start:host-chat'])
      await handle.stop()
      expect(events).toEqual(['start:host-chat', 'stop'])
      expect(unregisterChatPlatform('host-chat')).toBe(true)
    } finally {
      delete (globalThis as Record<string, unknown>).__hostChatEvents
    }
  })
})
