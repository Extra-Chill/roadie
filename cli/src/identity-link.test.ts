// Self-serve identity linking (#292): the link prompt is offered only to
// denied human actors when the host names a provider (rate-limited per
// actor), the clicker is always the actor, linked→allowed stores the MCP
// token and welcomes, linked→still denied, rejected→revoked, and without a
// provider nothing changes. Tokens never appear in user-facing text.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { ButtonInteraction, ChatInputCommandInteraction, MessageCreateOptions, User } from 'discord.js'
import { setDataDir } from './config.js'
import { closeDatabase } from './database.js'
import { addFilter, resetHooks } from './hooks.js'
import { clearIdentityCache, IDENTITY_LOOKUP_FAILED_MESSAGE, type Capability, type IdentityActor, type Person } from './identity.js'
import { listPersonMcpCredentials, readPersonMcpToken } from './credentials/person-mcp-store.js'
import { DEVICE_CODE_GRANT, type ConnectFetch, type ConnectFetchResponse } from './credentials/mcp-device-connect.js'
import {
  claimLinkPrompt,
  completeIdentityLink,
  isLinkCandidate,
  LINK_NOT_AVAILABLE_MESSAGE,
  LINK_PROMPT_INTERVAL_MS,
  LINK_STILL_DENIED_MESSAGE,
  matchLinkServer,
  resetLinkPromptRateLimit,
  resolveIdentityLinkProvider,
  setLinkFetchForTests,
  type IdentityLinkContext,
} from './identity-link.js'
import { resetWelcomeCache } from './person-welcome.js'
import { handleConnectCommand } from './commands/connect.js'
import {
  handleLinkButton,
  startDiscordIdentityLink,
  linkButtonCustomId,
  offerDiscordLinkPrompt,
  parseLinkButtonCustomId,
} from './commands/link.js'

const ISSUER = 'https://host.example.com'
const MCP_URL = `${ISSUER}/mcp`
const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`
const ACCESS = 'ACCESS-SECRET-TOKEN'
const REFRESH = 'REFRESH-SECRET-TOKEN'

let dataDir: string

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-link-'))
  setDataDir(dataDir)
})
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})
afterEach(async () => {
  resetHooks()
  clearIdentityCache()
  resetWelcomeCache()
  resetLinkPromptRateLimit()
  setLinkFetchForTests(undefined)
  await closeDatabase()
})

// ── Fixtures ────────────────────────────────────────────────────

function person(overrides: Partial<Person> = {}): Person {
  return {
    allowed: true,
    capabilities: new Set<Capability>(['sessions']),
    permissions: [],
    ...overrides,
  }
}

const denied = (): Person => person({ allowed: false, capabilities: new Set() })

/**
 * A host identity layer: actors in `linked` are allowed (with the given MCP
 * servers), everyone else is denied. `link_identity` adds to `linked`.
 */
function hostIdentity({
  allowAfterLink = true,
  servers = [{ name: 'host', url: MCP_URL, credential: 'host' }],
}: { allowAfterLink?: boolean; servers?: Person['mcpServers'] } = {}) {
  const linked = new Set<string>()
  const personLookups: string[] = []
  addFilter('person', (_value, { actor }) => {
    personLookups.push(actor.id)
    if (linked.has(actor.id) && allowAfterLink) {
      return person({ personId: `person-${actor.id}`, ...(servers ? { mcpServers: servers } : {}) })
    }
    return denied()
  })
  return { linked, personLookups }
}

function withProvider(provider: { url: string; name?: string; credential?: string } | null = { url: MCP_URL, name: 'Host' }) {
  const calls: Array<{ actor: IdentityActor }> = []
  addFilter('identity_link_provider', (_value, context) => {
    calls.push({ actor: context.actor })
    return provider
  })
  return calls
}

function oauthServer() {
  const calls: Array<{ method: string; url: string; body?: string }> = []
  const routes: Record<string, { status?: number; json?: unknown; headers?: Record<string, string> }> = {
    [`POST ${MCP_URL}`]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` } },
    [`GET ${PRM_URL}`]: { json: { resource: MCP_URL, authorization_servers: [ISSUER] } },
    [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: {
      json: {
        issuer: ISSUER,
        token_endpoint: `${ISSUER}/oauth/token`,
        device_authorization_endpoint: `${ISSUER}/oauth/device`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
        grant_types_supported: [DEVICE_CODE_GRANT, 'refresh_token'],
      },
    },
    [`POST ${ISSUER}/oauth/register`]: { status: 201, json: { client_id: 'client-1' } },
    [`POST ${ISSUER}/oauth/device`]: {
      json: {
        device_code: 'DEVICE-SECRET',
        user_code: 'ABCD-EFGH',
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 1,
      },
    },
    [`POST ${ISSUER}/oauth/token`]: { json: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 } },
    [`POST ${ISSUER}/oauth/revoke`]: { status: 200, json: {} },
  }
  const fetchImpl: ConnectFetch = async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}) })
    const reply = routes[`${init.method} ${url}`] ?? { status: 404, json: {} }
    const status = reply.status ?? 200
    const headers = new Map(Object.entries(reply.headers ?? {}))
    const response: ConnectFetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      json: async () => reply.json,
      body: { cancel: async () => undefined },
    }
    return response
  }
  const revocations = () => calls.filter((call) => call.url === `${ISSUER}/oauth/revoke`)
  return { fetchImpl, calls, revocations }
}

function capture<T>() {
  const items: T[] = []
  return { items, push: (item: T) => { items.push(item) } }
}

type Reply = { content?: string; components?: unknown[] }

function fakeUser(id: string, { dmFails = false, bot = false } = {}) {
  const dms: MessageCreateOptions[] = []
  return {
    id,
    bot,
    displayName: `User ${id}`,
    dms,
    send: (async (options: MessageCreateOptions) => {
      if (dmFails) throw new Error('Cannot send messages to this user')
      dms.push(options)
      return {}
    }) as unknown as User['send'],
  }
}

function fakeInteraction({ user, customId, guildId = '123', channelId = 'c1' }: {
  user: ReturnType<typeof fakeUser>
  customId?: string
  guildId?: string | null
  channelId?: string | null
}) {
  const edits: Reply[] = []
  const replies: Reply[] = []
  const interaction = {
    user,
    customId,
    guildId,
    channelId,
    deferred: false,
    deferReply: vi.fn(async () => { interaction.deferred = true }),
    reply: vi.fn(async (payload: Reply) => { replies.push(payload) }),
    editReply: vi.fn(async (payload: Reply) => { edits.push(payload) }),
  }
  return { interaction, edits, replies }
}

function componentCustomIds(components: unknown[] | undefined): string[] {
  return (components ?? []).flatMap((row) =>
    ((row as { toJSON(): { components: Array<{ custom_id?: string; url?: string }> } }).toJSON().components ?? [])
      .map((component) => component.custom_id ?? component.url ?? ''),
  )
}

const actorA: IdentityActor = { platform: 'discord', id: '111' }
const context = { guildId: '123', channelId: 'c1' }

// ── Prompt eligibility ──────────────────────────────────────────

describe('link prompt eligibility', () => {
  test('only denied, platform-authenticated humans are link candidates', () => {
    expect(isLinkCandidate({ person: denied() })).toBe(false) // no identity layer
    addFilter('person', (value) => value)
    expect(isLinkCandidate({ person: denied() })).toBe(true)
    expect(isLinkCandidate({ person: person() })).toBe(false)
    expect(isLinkCandidate({ person: { ...denied(), lookupFailed: true } })).toBe(false)
    expect(isLinkCandidate({ person: denied(), via: 'cli' })).toBe(false)
    expect(isLinkCandidate({ person: denied(), isBot: true })).toBe(false)
    expect(isLinkCandidate({ person: null })).toBe(false)
  })

  test('a denied human with a provider gets a DM with a Link button', async () => {
    hostIdentity()
    const providerCalls = withProvider()
    const user = fakeUser('111')
    const channel = capture<Reply>()
    const offered = await offerDiscordLinkPrompt({ user, person: denied(), context, replyInChannel: async (p) => channel.push(p) })
    expect(offered).toBe(true)
    expect(providerCalls).toEqual([{ actor: { platform: 'discord', id: '111' } }])
    expect(user.dms).toHaveLength(1)
    expect(user.dms[0]!.content).toContain('**Host**')
    expect(componentCustomIds(user.dms[0]!.components as unknown[])).toEqual([linkButtonCustomId({ guildId: '123' })])
    // The channel only hears that a DM was sent.
    expect(channel.items).toHaveLength(1)
    expect(channel.items[0]!.content).toContain('DM')
    expect(channel.items[0]!.components).toEqual([])
  })

  test('closed DMs fall back to a channel prompt whose button only that actor may use', async () => {
    hostIdentity()
    withProvider()
    const user = fakeUser('111', { dmFails: true })
    const channel = capture<Reply>()
    expect(await offerDiscordLinkPrompt({ user, person: denied(), context, replyInChannel: async (p) => channel.push(p) })).toBe(true)
    expect(componentCustomIds(channel.items[0]!.components)).toEqual([linkButtonCustomId({ guildId: '123', restrictTo: '111' })])
  })

  test('no prompt for allowed people, lookup failures, bots, or without a provider', async () => {
    hostIdentity()
    const channel = capture<Reply>()
    const reply = async (p: Reply) => channel.push(p)
    // No provider filter at all: nothing changes.
    expect(await offerDiscordLinkPrompt({ user: fakeUser('1'), person: denied(), context, replyInChannel: reply })).toBe(false)
    const off = addFilter('identity_link_provider', () => null)
    expect(await offerDiscordLinkPrompt({ user: fakeUser('2'), person: denied(), context, replyInChannel: reply })).toBe(false)
    off()
    withProvider()
    expect(await offerDiscordLinkPrompt({ user: fakeUser('3'), person: person(), context, replyInChannel: reply })).toBe(false)
    expect(await offerDiscordLinkPrompt({ user: fakeUser('4'), person: { ...denied(), lookupFailed: true }, context, replyInChannel: reply })).toBe(false)
    expect(await offerDiscordLinkPrompt({ user: fakeUser('5', { bot: true }), person: denied(), context, replyInChannel: reply })).toBe(false)
    expect(channel.items).toEqual([])
  })

  test('the prompt is rate-limited per actor', async () => {
    hostIdentity()
    withProvider()
    const now = 1_000_000
    expect(await claimLinkPrompt({ actor: actorA, context, person: denied(), now })).not.toBeNull()
    expect(await claimLinkPrompt({ actor: actorA, context, person: denied(), now: now + 60_000 })).toBeNull()
    // Another actor is not affected.
    expect(await claimLinkPrompt({ actor: { platform: 'discord', id: '222' }, context, person: denied(), now })).not.toBeNull()
    expect(await claimLinkPrompt({ actor: actorA, context, person: denied(), now: now + LINK_PROMPT_INTERVAL_MS })).not.toBeNull()
  })

  test('a provider whose url is not https is ignored', async () => {
    withProvider({ url: 'http://evil.example.com/mcp' })
    expect(await resolveIdentityLinkProvider({ actor: actorA, context })).toBeNull()
  })
})

// ── Buttons and /connect ───────────────────────────────────────────

describe('link button ids', () => {
  test('round-trip and reject junk', () => {
    expect(parseLinkButtonCustomId(linkButtonCustomId({ guildId: '1', restrictTo: '2' }))).toEqual({ guildId: '1', restrictTo: '2' })
    expect(parseLinkButtonCustomId(linkButtonCustomId({}))).toEqual({})
    expect(parseLinkButtonCustomId('roadie_link:abc:')).toBeNull()
    expect(parseLinkButtonCustomId('roadie_connect:c:x')).toBeNull()
  })
})

async function finalEdit(edits: Reply[], count: number): Promise<Reply> {
  await vi.waitFor(() => expect(edits.length).toBeGreaterThanOrEqual(count), { timeout: 5000 })
  return edits[count - 1]!
}

describe('the link flow', () => {
  test('/connect links first, then lists tools with the stored credential already connected', async () => {
    const { linked } = hostIdentity()
    withProvider()
    addFilter('link_identity', (_value, ctx) => {
      linked.add(ctx.actor.id)
      return { linked: true as const }
    })
    const oauth = oauthServer()
    setLinkFetchForTests(oauth.fetchImpl, async () => undefined)
    const { interaction, edits } = fakeInteraction({ user: fakeUser('112') })
    await handleConnectCommand({ command: interaction as unknown as ChatInputCommandInteraction })
    const done = await finalEdit(edits, 2)
    expect(done.content).toContain('Your connected services:')
    expect(done.content).toContain('**host**: connected')
    expect(componentCustomIds(done.components)).toContain('roadie_connect:d:host')
    expect(listPersonMcpCredentials({ dataDir, personKey: 'person-112' })).toEqual(['host'])
    expect(oauth.revocations()).toEqual([])
  })

  test('the clicker is the actor, even on a button sent to someone else', async () => {
    const { linked } = hostIdentity()
    withProvider()
    const linkCalls: IdentityLinkContext[] = []
    addFilter('link_identity', (_value, ctx) => {
      linkCalls.push(ctx)
      linked.add(ctx.actor.id)
      return { linked: true as const }
    })
    const oauth = oauthServer()
    setLinkFetchForTests(oauth.fetchImpl, async () => undefined)

    // A DM button (no restriction) forwarded to and clicked by user 222.
    const clicker = fakeUser('222')
    const { interaction, edits } = fakeInteraction({ user: clicker, customId: linkButtonCustomId({ guildId: '123' }), guildId: null, channelId: 'dm' })
    await handleLinkButton(interaction as unknown as ButtonInteraction)
    const done = await finalEdit(edits, 2)
    expect(linkCalls.map((call) => call.actor.id)).toEqual(['222'])
    expect(linkCalls[0]!.context).toEqual({ guildId: '123' })
    expect(done.content).toContain('Linked')
    expect(linked.has('111')).toBe(false)
  })

  test('a channel fallback button refuses other clickers', async () => {
    hostIdentity()
    const linkIdentity = vi.fn(() => ({ linked: true as const }))
    addFilter('link_identity', linkIdentity)
    withProvider()
    const { interaction, replies } = fakeInteraction({ user: fakeUser('999'), customId: linkButtonCustomId({ guildId: '123', restrictTo: '111' }) })
    await handleLinkButton(interaction as unknown as ButtonInteraction)
    expect(replies[0]!.content).toContain('someone else')
    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(linkIdentity).not.toHaveBeenCalled()
  })

  test('linked → allowed: the token becomes their MCP credential and they are welcomed', async () => {
    const { linked } = hostIdentity()
    withProvider({ url: `${MCP_URL}/`, name: 'Host' })
    const tokens: IdentityLinkContext['token'][] = []
    addFilter('link_identity', (_value, ctx) => {
      tokens.push(ctx.token)
      linked.add(ctx.actor.id)
      return { linked: true as const }
    })
    const oauth = oauthServer()
    setLinkFetchForTests(oauth.fetchImpl, async () => undefined)

    const user = fakeUser('111')
    const { interaction, edits } = fakeInteraction({ user })
    await startDiscordIdentityLink({ command: interaction as unknown as ChatInputCommandInteraction })
    // First edit: the private sign-in prompt (link + code, no token).
    const prompt = await finalEdit(edits, 1)
    expect(prompt.content).toContain('ABCD-EFGH')
    expect(componentCustomIds(prompt.components)).toEqual([`${ISSUER}/device?user_code=ABCD-EFGH`])
    const done = await finalEdit(edits, 2)
    expect(done.content).toBe('Linked. You have access now, and **host** is connected.')

    // The host saw the token in the contract's shape (no client secret).
    expect(tokens).toHaveLength(1)
    expect(Object.keys(tokens[0]!).sort()).toEqual(['access', 'clientId', 'expires', 'refresh', 'revocationEndpoint', 'tokenEndpoint'])
    expect(tokens[0]!.access).toBe(ACCESS)

    // Stored under the person's own key; not revoked.
    expect(listPersonMcpCredentials({ dataDir, personKey: 'person-111' })).toEqual(['host'])
    expect(readPersonMcpToken({ dataDir, personKey: 'person-111', credential: 'host' })?.access).toBe(ACCESS)
    expect(oauth.revocations()).toEqual([])

    // Welcome DM sent once, now that they are allowed.
    await vi.waitFor(() => expect(user.dms).toHaveLength(1))
    expect(user.dms[0]!.content).toContain('Welcome')

    for (const edit of edits) {
      expect(edit.content).not.toContain(ACCESS)
      expect(edit.content).not.toContain(REFRESH)
    }
  })

  test('linked → still denied: says so, stores nothing, revokes the unused token', async () => {
    const { linked } = hostIdentity({ allowAfterLink: false })
    withProvider()
    addFilter('link_identity', (_value, ctx) => {
      linked.add(ctx.actor.id)
      return { linked: true as const }
    })
    const oauth = oauthServer()
    setLinkFetchForTests(oauth.fetchImpl, async () => undefined)
    const user = fakeUser('333')
    const { interaction, edits } = fakeInteraction({ user })
    await startDiscordIdentityLink({ command: interaction as unknown as ChatInputCommandInteraction })
    const done = await finalEdit(edits, 2)
    expect(done.content).toBe(LINK_STILL_DENIED_MESSAGE)
    expect(listPersonMcpCredentials({ dataDir, personKey: 'person-333' })).toEqual([])
    expect(oauth.revocations()).toHaveLength(1)
    expect(user.dms).toEqual([])
  })

  test('rejected: shows the reason and revokes the token without storing it', async () => {
    hostIdentity()
    withProvider()
    addFilter('link_identity', () => ({ linked: false, reason: 'No account uses that sign-in.' }))
    const oauth = oauthServer()
    setLinkFetchForTests(oauth.fetchImpl, async () => undefined)
    const user = fakeUser('444')
    const { interaction, edits } = fakeInteraction({ user })
    await startDiscordIdentityLink({ command: interaction as unknown as ChatInputCommandInteraction })
    const done = await finalEdit(edits, 2)
    expect(done.content).toBe('Could not link your account: No account uses that sign-in.')
    const revocations = oauth.revocations()
    expect(revocations).toHaveLength(1)
    const body = new URLSearchParams(revocations[0]!.body)
    expect(body.get('token')).toBe(REFRESH)
    expect(body.get('token_type_hint')).toBe('refresh_token')
    expect(listPersonMcpCredentials({ dataDir, personKey: 'discord:444' })).toEqual([])
    expect(user.dms).toEqual([])
  })

  test('without a provider /connect changes nothing', async () => {
    hostIdentity()
    const linkIdentity = vi.fn(() => ({ linked: true as const }))
    addFilter('link_identity', linkIdentity)
    const oauth = oauthServer()
    setLinkFetchForTests(oauth.fetchImpl, async () => undefined)
    const { interaction, edits } = fakeInteraction({ user: fakeUser('555') })
    await handleConnectCommand({ command: interaction as unknown as ChatInputCommandInteraction })
    expect(edits[0]!.content).toBe(LINK_NOT_AVAILABLE_MESSAGE)
    expect(oauth.calls).toEqual([])
    expect(linkIdentity).not.toHaveBeenCalled()
  })

  test('/connect for someone already allowed, or when the lookup fails, does not start a sign-in', async () => {
    addFilter('person', (_value, { actor }) =>
      actor.id === 'ok' ? person({ mcpServers: [{ name: 'host', url: MCP_URL, credential: 'host' }] }) : { ...denied(), lookupFailed: true },
    )
    withProvider()
    const oauth = oauthServer()
    setLinkFetchForTests(oauth.fetchImpl, async () => undefined)
    const allowed = fakeInteraction({ user: fakeUser('ok') })
    await handleConnectCommand({ command: allowed.interaction as unknown as ChatInputCommandInteraction })
    expect(allowed.replies[0]!.content).toContain('Your connected services:')
    expect(componentCustomIds(allowed.replies[0]!.components)).toContain('roadie_connect:c:host')
    const failing = fakeInteraction({ user: fakeUser('broken') })
    await handleConnectCommand({ command: failing.interaction as unknown as ChatInputCommandInteraction })
    expect(failing.replies[0]!.content).toBe(IDENTITY_LOOKUP_FAILED_MESSAGE)
    expect(oauth.calls).toEqual([])
  })
})

// ── completeIdentityLink details ────────────────────────────────

describe('completeIdentityLink', () => {
  const token = {
    access: ACCESS,
    refresh: REFRESH,
    tokenEndpoint: `${ISSUER}/oauth/token`,
    clientId: 'client-1',
    revocationEndpoint: `${ISSUER}/oauth/revoke`,
  }

  test('drops the cached denial and resolves the person again', async () => {
    const { linked, personLookups } = hostIdentity({ servers: [] })
    withProvider()
    addFilter('link_identity', (_value, ctx) => {
      linked.add(ctx.actor.id)
      return { linked: true as const }
    })
    const { resolvePerson } = await import('./identity.js')
    expect((await resolvePerson({ actor: actorA, context }))?.allowed).toBe(false)
    const welcomed: Person[] = []
    const oauth = oauthServer()
    const outcome = await completeIdentityLink({
      actor: actorA,
      context,
      provider: { url: MCP_URL },
      token,
      welcome: async (p) => { welcomed.push(p) },
      dataDir,
      fetchImpl: oauth.fetchImpl,
    })
    expect(outcome.status).toBe('allowed')
    expect(personLookups).toEqual(['111', '111'])
    expect(welcomed).toHaveLength(1)
    // Allowed, but no server for the token: it is revoked, not stored.
    expect(outcome.storedServer).toBeUndefined()
    expect(oauth.revocations()).toHaveLength(1)
  })

  test('a throwing or malformed link_identity counts as not linked', async () => {
    hostIdentity()
    addFilter('link_identity', () => {
      throw new Error(`boom ${ACCESS}`)
    })
    const oauth = oauthServer()
    const outcome = await completeIdentityLink({
      actor: actorA, context, provider: { url: MCP_URL }, token, welcome: async () => undefined, dataDir, fetchImpl: oauth.fetchImpl,
    })
    expect(outcome.status).toBe('rejected')
    expect(outcome.text).not.toContain(ACCESS)
    expect(oauth.revocations()).toHaveLength(1)
  })

  test('matches the provider url to a server, preferring its credential', () => {
    const servers = [
      { name: 'a', url: MCP_URL, credential: 'a' },
      { name: 'b', url: `${MCP_URL}/`, credential: 'b' },
      { name: 'c', url: 'https://other.example.com/mcp', credential: 'c' },
    ]
    expect(matchLinkServer({ servers, provider: { url: MCP_URL } })?.name).toBe('a')
    expect(matchLinkServer({ servers, provider: { url: MCP_URL, credential: 'b' } })?.name).toBe('b')
    expect(matchLinkServer({ servers, provider: { url: 'https://nope.example.com/mcp' } })).toBeUndefined()
  })
})
