// Per-channel policy: parsing, lookup precedence, gates, reload, fail closed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  channelAllowsCapability,
  channelAllowsSpeaker,
  channelPolicyOverrides,
  channelStartsThreads,
  decideRespond,
  matchesWho,
  parseChannelsConfig,
  resolveChannelPolicy,
  setChannelParentResolver,
  setChannelsConfigPath,
  type WhoSubject,
} from './channel-policy.js'
import { applyChannelPolicyToIngress, type IngressInput } from './session-handler/thread-session-runtime.js'

// thread-1 → channel-ops → category-dev; channel-general → category-dev
const parents: Record<string, string> = {
  'thread-1': 'channel-ops',
  'channel-ops': 'category-dev',
  'channel-general': 'category-dev',
}

let dir: string
let file: string

const write = (text: string) => {
  fs.writeFileSync(file, text)
  // Force the mtime forward so the reload check sees a change.
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6))
  fs.utimesSync(file, t, t)
  setChannelsConfigPath(file) // resets the cache
}

const subject = (overrides: Partial<WhoSubject> = {}): WhoSubject => ({
  userId: 'u1',
  isGuildOwner: false,
  roleNames: [],
  roleIds: [],
  ...overrides,
})

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-channel-policy-'))
  file = path.join(dir, 'channels.yaml')
  setChannelParentResolver((id) => parents[id])
})

afterEach(() => {
  setChannelsConfigPath(undefined)
})

const CONFIG = `
channels:
  "category-dev":
    respond: mention
    who: ["role:team"]
    agent: team-bot
    capabilities: [sessions]
  "channel-ops":
    respond: always
    who: [owner, "user:42"]
    directory: /srv/ops
    capabilities: [sessions, shell, admin]
    permissions: ["bash:ask"]
  "channel-quiet":
    threads: existing-only
    respond: always
  "*":
    respond: never
`

describe('parseChannelsConfig', () => {
  test('accepts YAML and JSON', () => {
    expect(parseChannelsConfig(CONFIG)).not.toBeInstanceOf(Error)
    expect(parseChannelsConfig('{"channels":{"*":{"respond":"always"}}}')).toEqual({
      channels: { '*': { respond: 'always' } },
    })
  })

  test.each([
    ['unknown field', 'channels:\n  "1":\n    repsond: always\n'],
    ['bad respond', 'channels:\n  "1":\n    respond: sometimes\n'],
    ['bad who entry', 'channels:\n  "1":\n    who: ["admins"]\n'],
    ['inline threads not implemented', 'channels:\n  "1":\n    threads: none\n'],
    ['broken yaml', 'channels: [\n'],
  ])('rejects %s', (_label, text) => {
    expect(parseChannelsConfig(text)).toBeInstanceOf(Error)
  })
})

describe('resolution', () => {
  test('no config file: everything falls back to built-in behavior', () => {
    setChannelsConfigPath(null)
    expect(resolveChannelPolicy('channel-ops')).toBeUndefined()
    expect(decideRespond('channel-ops')).toBe('builtin')
    expect(channelAllowsSpeaker('channel-ops', subject())).toBe(true)
    expect(channelAllowsCapability('channel-ops', 'shell')).toBe(true)
    expect(channelStartsThreads('channel-ops')).toBe(true)
    expect(channelPolicyOverrides('channel-ops')).toEqual({})
  })

  test('thread inherits channel, channel overrides category, category overrides "*"', () => {
    write(CONFIG)
    expect(resolveChannelPolicy('thread-1')).toEqual({
      respond: 'always',
      who: ['owner', 'user:42'],
      agent: 'team-bot',
      directory: '/srv/ops',
      capabilities: ['sessions', 'shell', 'admin'],
      permissions: ['bash:ask'],
    })
    expect(resolveChannelPolicy('channel-general')).toMatchObject({
      respond: 'mention',
      who: ['role:team'],
      agent: 'team-bot',
      capabilities: ['sessions'],
    })
    expect(decideRespond('channel-general')).toBe('needs-mention')
    expect(decideRespond('thread-1')).toBe('answer')
  })

  test('unconfigured channels fall to "*"', () => {
    write(CONFIG)
    expect(decideRespond('channel-elsewhere')).toBe('ignore')
  })

  test('a config without "*" ignores channels it does not list', () => {
    write('channels:\n  "channel-ops":\n    respond: always\n')
    expect(decideRespond('channel-ops')).toBe('answer')
    expect(resolveChannelPolicy('channel-random')).toBeNull()
    expect(decideRespond('channel-random')).toBe('ignore')
  })

  test('capabilities without sessions mean the channel is not answered', () => {
    write('channels:\n  "c":\n    capabilities: [shell]\n')
    expect(decideRespond('c')).toBe('ignore')
  })

  test('capability caps and thread mode', () => {
    write(CONFIG)
    expect(channelAllowsCapability('channel-ops', 'shell')).toBe(true)
    expect(channelAllowsCapability('channel-general', 'shell')).toBe(false)
    expect(channelAllowsCapability('channel-general', 'admin')).toBe(false)
    expect(channelStartsThreads('channel-ops')).toBe(true)
    expect(channelStartsThreads('channel-quiet')).toBe(false)
  })

  test('overrides expose directory, agent, model, verbosity and permissions', () => {
    write(CONFIG)
    expect(channelPolicyOverrides('channel-ops')).toEqual({
      directory: '/srv/ops',
      agent: 'team-bot',
      permissions: ['bash:ask'],
    })
  })
})

describe('who', () => {
  test('matches owner, user, role name or id, and person', () => {
    expect(matchesWho('everyone', subject())).toBe(true)
    expect(matchesWho(undefined, subject())).toBe(true)
    expect(matchesWho(['owner'], subject({ isGuildOwner: true }))).toBe(true)
    expect(matchesWho(['owner'], subject())).toBe(false)
    expect(matchesWho(['user:u1'], subject())).toBe(true)
    expect(matchesWho(['role:Team'], subject({ roleNames: ['team'] }))).toBe(true)
    expect(matchesWho(['role:999'], subject({ roleIds: ['999'] }))).toBe(true)
    expect(matchesWho(['person:host:38'], subject({ personId: 'host:38' }))).toBe(true)
    expect(matchesWho(['person:host:38'], subject())).toBe(false)
  })

  test('channel audience applies per channel', () => {
    write(CONFIG)
    expect(channelAllowsSpeaker('channel-ops', subject({ userId: '42' }))).toBe(true)
    expect(channelAllowsSpeaker('channel-ops', subject({ roleNames: ['team'] }))).toBe(false)
    expect(channelAllowsSpeaker('channel-general', subject({ roleNames: ['team'] }))).toBe(true)
    expect(channelAllowsSpeaker('channel-elsewhere', subject({ userId: '42' }))).toBe(true)
  })
})

describe('reload and failure', () => {
  test('picks up edits', () => {
    write('channels:\n  "c":\n    respond: never\n')
    expect(decideRespond('c')).toBe('ignore')
    write('channels:\n  "c":\n    respond: always\n')
    expect(decideRespond('c')).toBe('answer')
  })

  test('an invalid edit keeps the last valid config', () => {
    write('channels:\n  "c":\n    respond: always\n')
    expect(decideRespond('c')).toBe('answer')
    fs.writeFileSync(file, 'channels:\n  "c":\n    respond: maybe\n')
    const t = new Date(Date.now() + 5e6)
    fs.utimesSync(file, t, t)
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 3_000) // past the reload throttle
    try {
      expect(decideRespond('c')).toBe('answer')
    } finally {
      spy.mockRestore()
    }
  })

  test('a missing or never-valid file answers no channel', () => {
    setChannelsConfigPath(path.join(dir, 'missing.yaml'))
    expect(decideRespond('channel-ops')).toBe('ignore')
    expect(channelAllowsSpeaker('channel-ops', subject({ isGuildOwner: true }))).toBe(false)
  })
})

describe('applyChannelPolicyToIngress', () => {
  const base: IngressInput = { prompt: 'hi', userId: 'u1', username: 'U', mode: 'opencode' }

  test('adds the channel permission rules to the turn', () => {
    write(CONFIG)
    expect(
      applyChannelPolicyToIngress({ input: { ...base, permissions: ['edit:deny'] }, channelId: 'channel-ops' })
        .permissions,
    ).toEqual(['edit:deny', 'bash:ask'])
    expect(applyChannelPolicyToIngress({ input: base, channelId: 'channel-general' })).toEqual(base)
  })
})
