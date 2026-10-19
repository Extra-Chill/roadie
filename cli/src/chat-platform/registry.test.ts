import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  getChatPlatform,
  getFailedChatPlatforms,
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

function platform(
  id: string,
  events: string[],
  { fail = false, required }: { fail?: boolean; required?: boolean } = {},
): ChatPlatformDefinition {
  return {
    id,
    ...(required !== undefined && { required }),
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

  test('a failing platform is recorded while the healthy ones keep running', async () => {
    const events: string[] = []
    registerChatPlatform(platform('alpha', events))
    registerChatPlatform(platform('broken', events, { fail: true }))
    const handle = await startChatPlatforms({ ...context, platformIds: ['broken', 'alpha'] })
    if (handle instanceof Error) throw handle
    expect(events).toEqual(['start:alpha'])
    expect(getFailedChatPlatforms()).toEqual([{ id: 'broken', error: 'broken refused' }])
    await handle.stop()
    expect(events).toEqual(['start:alpha', 'stop:alpha'])
  })

  test('a recorded failure clears when the platform is requested again', async () => {
    const events: string[] = []
    registerChatPlatform(platform('broken', events, { fail: true }))
    registerChatPlatform(platform('alpha', events))
    const first = await startChatPlatforms({ ...context, platformIds: ['broken', 'alpha'] })
    if (first instanceof Error) throw first
    expect(getFailedChatPlatforms()).toEqual([{ id: 'broken', error: 'broken refused' }])
    await first.stop()
    unregisterChatPlatform('broken')
    registerChatPlatform(platform('broken', events))
    const second = await startChatPlatforms({ ...context, platformIds: ['broken'] })
    if (second instanceof Error) throw second
    expect(getFailedChatPlatforms()).toEqual([])
    await second.stop()
  })

  test('returns an Error when every requested platform failed', async () => {
    const events: string[] = []
    registerChatPlatform(platform('broken', events, { fail: true }))
    registerChatPlatform(platform('cracked', events, { fail: true }))
    const result = await startChatPlatforms({ ...context, platformIds: ['broken', 'cracked'] })
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('Every requested chat platform failed')
    expect((result as Error).message).toContain('broken (broken refused)')
    expect((result as Error).message).toContain('cracked (cracked refused)')
    expect(events).toEqual([])
    expect(getFailedChatPlatforms()).toEqual([
      { id: 'broken', error: 'broken refused' },
      { id: 'cracked', error: 'cracked refused' },
    ])
  })

  test('a required failing platform rolls back the ones already running', async () => {
    const events: string[] = []
    registerChatPlatform(platform('alpha', events))
    registerChatPlatform(platform('broken', events, { fail: true, required: true }))
    registerChatPlatform(platform('omega', events))
    const result = await startChatPlatforms({
      ...context,
      platformIds: ['alpha', 'broken', 'omega'],
    })
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('broken failed to start')
    expect(events).toEqual(['start:alpha', 'stop:alpha'])
    expect(getFailedChatPlatforms()).toEqual([{ id: 'broken', error: 'broken refused' }])
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
