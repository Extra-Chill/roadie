// Welcome for newly admitted people (#272) and the /connect helpers it shares
// with #271: once per person, only for allowed chat people, filter override
// and disable, Connect buttons only for servers lacking a token, and person
// isolation for connect targets.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { APIButtonComponentWithCustomId } from 'discord.js'
import { setDataDir } from './config.js'
import { closeDatabase } from './database.js'
import { addFilter, resetHooks } from './hooks.js'
import { clearIdentityCache, type Capability, type Person } from './identity.js'
import { setPersonMcpToken } from './credentials/person-mcp-store.js'
import {
  maybeWelcomePerson,
  resetWelcomeCache,
  welcomePersonKey,
  type PersonWelcome,
} from './person-welcome.js'
import {
  buildConnectButtonRows,
  buildPersonConnectButtons,
  connectButtonCustomId,
  parseConnectButtonCustomId,
  personMcpConnectionStates,
  resolveConnectSpeaker,
  resolveConnectTarget,
} from './commands/connect.js'
import { welcomeDiscordUser } from './commands/start.js'

const MCP_URL = 'https://auth.example.com/mcp'
let dataDir: string

function person(overrides: Partial<Person> = {}): Person {
  return {
    allowed: true,
    capabilities: new Set<Capability>(['sessions']),
    permissions: [],
    ...overrides,
  }
}

const servers = [
  { name: 'acme', url: MCP_URL, credential: 'acme' },
  { name: 'docs', url: MCP_URL, credential: 'docs' },
]

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-welcome-'))
  setDataDir(dataDir)
})
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})
afterEach(async () => {
  resetHooks()
  clearIdentityCache()
  resetWelcomeCache()
  await closeDatabase()
})

/** An identity layer is "configured" when a person filter exists. */
function enableIdentityLayer() {
  addFilter('person', (value) => value)
}

function recorder() {
  const sent: PersonWelcome[] = []
  return {
    sent,
    deliver: async (welcome: PersonWelcome) => {
      sent.push(welcome)
    },
  }
}

describe('welcome', () => {
  test('is sent once per person key, across process caches', async () => {
    enableIdentityLayer()
    const { sent, deliver } = recorder()
    const actor = { platform: 'discord', id: 'u1', name: 'Ada' }
    const p = person({ personId: 'wp:welcome-once' })
    expect(await maybeWelcomePerson({ actor, person: p, deliver, dataDir })).toBe('sent')
    expect(await maybeWelcomePerson({ actor, person: p, deliver, dataDir })).toBe('skipped')
    // A fresh process (cache cleared) still sees the persisted claim.
    resetWelcomeCache()
    expect(await maybeWelcomePerson({ actor, person: p, deliver, dataDir })).toBe('skipped')
    // Same person from another platform account: same person key, no second welcome.
    expect(await maybeWelcomePerson({ actor: { platform: 'slack', id: 'U9' }, person: p, deliver, dataDir })).toBe('skipped')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Welcome, Ada!')
    expect(sent[0]!.text).toContain('/start')
    expect(sent[0]!.text).not.toContain('/connect')
  })

  test('is not sent to denied, unmapped, CLI-asserted or bot actors, or without an identity layer', async () => {
    const { sent, deliver } = recorder()
    const actor = { platform: 'discord', id: 'u2' }
    // No identity layer: nobody is "admitted".
    expect(await maybeWelcomePerson({ actor, person: person({ personId: 'wp:none' }), deliver, dataDir })).toBe('skipped')
    enableIdentityLayer()
    expect(await maybeWelcomePerson({ actor, person: person({ allowed: false, personId: 'wp:denied' }), deliver, dataDir })).toBe('skipped')
    expect(await maybeWelcomePerson({ actor, person: null, deliver, dataDir })).toBe('skipped')
    expect(await maybeWelcomePerson({ actor, person: undefined, deliver, dataDir })).toBe('skipped')
    expect(await maybeWelcomePerson({ actor, person: person({ personId: 'wp:cli' }), via: 'cli', deliver, dataDir })).toBe('skipped')
    expect(await maybeWelcomePerson({ actor, person: person({ personId: 'wp:bot' }), isBot: true, deliver, dataDir })).toBe('skipped')
    expect(sent).toHaveLength(0)
    // The skipped ones were never claimed: a later allowed chat turn welcomes them.
    expect(await maybeWelcomePerson({ actor, person: person({ personId: 'wp:cli' }), deliver, dataDir })).toBe('sent')
  })

  test('the welcome_message filter overrides the text, and null or empty disables it', async () => {
    enableIdentityLayer()
    const { sent, deliver } = recorder()
    const actor = { platform: 'discord', id: 'u3' }
    const seen: unknown[] = []
    const remove = addFilter('welcome_message', (_value, context) => {
      seen.push(context)
      return `Hello from the host, ${context.personKey}`
    })
    expect(await maybeWelcomePerson({ actor, person: person({ personId: 'wp:custom' }), channelId: 'c1', deliver, dataDir })).toBe('sent')
    expect(sent[0]!.text).toBe('Hello from the host, wp:custom')
    expect(seen[0]).toMatchObject({ personKey: 'wp:custom', channelId: 'c1', trigger: 'first_contact', pendingMcpServers: [] })
    remove()

    for (const disabled of [null, '', '   ']) {
      const off = addFilter('welcome_message', () => disabled)
      expect(await maybeWelcomePerson({ actor, person: person({ personId: 'wp:off' }), deliver, dataDir })).toBe('disabled')
      off()
      resetWelcomeCache()
    }
    expect(sent).toHaveLength(1)
    // Disabled welcomes are not consumed: enabling it later still welcomes them.
    expect(await maybeWelcomePerson({ actor, person: person({ personId: 'wp:off' }), deliver, dataDir })).toBe('sent')
  })

  test('mentions /connect and lists only servers lacking a token', async () => {
    enableIdentityLayer()
    await setPersonMcpToken({ dataDir, personKey: 'wp:partial', credential: 'acme', token: { access: 'tok' } })
    const { sent, deliver } = recorder()
    await maybeWelcomePerson({
      actor: { platform: 'discord', id: 'u4' },
      person: person({ personId: 'wp:partial', mcpServers: servers }),
      deliver,
      dataDir,
    })
    expect(sent[0]!.text).toContain('/connect')
    expect(sent[0]!.text).toContain('(docs)')
    expect(sent[0]!.pendingMcpServers.map((server) => server.name)).toEqual(['docs'])
  })

  test('a failed DM is logged, not retried and never thrown', async () => {
    enableIdentityLayer()
    let attempts = 0
    const deliver = async () => {
      attempts += 1
      return new Error('Cannot send messages to this user')
    }
    const actor = { platform: 'discord', id: 'u5' }
    const p = person({ personId: 'wp:closed-dms' })
    expect(await maybeWelcomePerson({ actor, person: p, deliver, dataDir })).toBe('failed')
    resetWelcomeCache()
    expect(await maybeWelcomePerson({ actor, person: p, deliver, dataDir })).toBe('skipped')
    expect(attempts).toBe(1)
  })

  test('Discord delivery sends a DM with Connect buttons only for missing tokens', async () => {
    enableIdentityLayer()
    await setPersonMcpToken({ dataDir, personKey: 'wp:dm', credential: 'acme', token: { access: 'tok' } })
    const messages: Array<{ content: string; components: Array<{ toJSON(): unknown }> }> = []
    const user = {
      id: 'u6',
      bot: false,
      send: async (message: { content: string; components: Array<{ toJSON(): unknown }> }) => {
        messages.push(message)
        return {} as never
      },
    }
    const outcome = await welcomeDiscordUser({
      user: user as never,
      person: person({ personId: 'wp:dm', mcpServers: servers }),
      channelId: 'chan',
    })
    expect(outcome).toBe('sent')
    const rows = messages[0]!.components.map((row) => row.toJSON() as { components: APIButtonComponentWithCustomId[] })
    expect(rows.flatMap((row) => row.components.map((button) => button.custom_id))).toEqual([connectButtonCustomId('connect', 'docs')])
    expect(messages[0]!.content).toContain('<#chan>')

    // Bots are never welcomed.
    const botOutcome = await welcomeDiscordUser({
      user: { ...user, id: 'b1', bot: true } as never,
      person: person({ personId: 'wp:dm-bot' }),
    })
    expect(botOutcome).toBe('skipped')
  })

  test('welcomePersonKey derives the same key as turns do', () => {
    enableIdentityLayer()
    expect(welcomePersonKey({ actor: { platform: 'discord', id: '42' }, person: person({ personId: 'wp:7' }) })).toBe('wp:7')
    expect(welcomePersonKey({ actor: { platform: 'discord', id: '42' }, person: person() })).toBe('discord:42')
  })
})

describe('connect helpers', () => {
  const alice = { platform: 'discord', id: 'alice' }
  const bob = { platform: 'discord', id: 'bob' }

  test('a person can only target their own key and their own servers', () => {
    const alicePerson = person({ personId: 'wp:1', mcpServers: servers })
    const bobPerson = person({ personId: 'wp:2', mcpServers: [servers[1]!] })
    expect(resolveConnectTarget({ person: alicePerson, actor: alice, serverName: 'acme' })).toEqual({ personKey: 'wp:1', server: servers[0] })
    // Bob clicking Alice's "Connect acme" button: acme is not his, refused.
    expect(resolveConnectTarget({ person: bobPerson, actor: bob, serverName: 'acme' })).toBeInstanceOf(Error)
    // Bob clicking a server they share resolves to Bob's key, never Alice's.
    expect(resolveConnectTarget({ person: bobPerson, actor: bob, serverName: 'docs' })).toEqual({ personKey: 'wp:2', server: servers[1] })
    // Without a person_id the key is the platform actor, like turns.
    expect(resolveConnectTarget({ person: person({ mcpServers: servers }), actor: bob, serverName: 'docs' })).toMatchObject({ personKey: 'discord:bob' })
    // Denied, unmapped or server-less people get nothing.
    expect(resolveConnectSpeaker({ person: person({ allowed: false, mcpServers: servers }), actor: alice })).toBeInstanceOf(Error)
    expect(resolveConnectSpeaker({ person: null, actor: alice })).toBeInstanceOf(Error)
    expect(resolveConnectSpeaker({ person: person(), actor: alice })).toBeInstanceOf(Error)
  })

  test('custom ids round-trip and carry no person', () => {
    const id = connectButtonCustomId('connect', 'acme')
    expect(id).toBe('roadie_connect:c:acme')
    expect(parseConnectButtonCustomId(id)).toEqual({ action: 'connect', serverName: 'acme' })
    expect(parseConnectButtonCustomId(connectButtonCustomId('disconnect', 'docs'))).toEqual({ action: 'disconnect', serverName: 'docs' })
    expect(parseConnectButtonCustomId('roadie_connect:x:acme')).toBeNull()
    expect(parseConnectButtonCustomId('other:c:acme')).toBeNull()
  })

  test('connection states and buttons reflect stored tokens per person', async () => {
    await setPersonMcpToken({ dataDir, personKey: 'wp:states', credential: 'docs', token: { access: 'tok' } })
    const states = personMcpConnectionStates({ dataDir, personKey: 'wp:states', servers })
    expect(states.map((state) => [state.server.name, state.connected])).toEqual([['acme', false], ['docs', true]])
    const all = buildConnectButtonRows({ states }).flatMap((row) => (row.toJSON().components as APIButtonComponentWithCustomId[]).map((b) => b.custom_id))
    expect(all).toEqual(['roadie_connect:c:acme', 'roadie_connect:d:docs'])

    const missingOnly = buildPersonConnectButtons({ dataDir, person: person({ personId: 'wp:states', mcpServers: servers }), actor: alice })
      .flatMap((row) => (row.toJSON().components as APIButtonComponentWithCustomId[]).map((b) => b.custom_id))
    expect(missingOnly).toEqual(['roadie_connect:c:acme'])
    // Everything connected, or no servers: no buttons.
    await setPersonMcpToken({ dataDir, personKey: 'wp:states', credential: 'acme', token: { access: 'tok' } })
    expect(buildPersonConnectButtons({ dataDir, person: person({ personId: 'wp:states', mcpServers: servers }), actor: alice })).toEqual([])
    expect(buildPersonConnectButtons({ dataDir, person: person({ personId: 'wp:states' }), actor: alice })).toEqual([])
  })
})
