// The Connect button and the paste-redirect modal (issue #356): the prompt is
// ephemeral and carries the paste button only for authorization-code flows;
// only the person who started the connect can open the modal or submit a
// redirect; bad pastes get specific ephemeral refusals; the token lands in
// the starter's own store and the connect reply updates when it completes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js'
import { setDataDir } from '../config.js'
import { closeDatabase } from '../database.js'
import { addFilter, resetHooks } from '../hooks.js'
import { clearIdentityCache, type Capability, type Person } from '../identity.js'
import { personKeyFrom } from '../credentials/person-pool.js'
import { readPersonMcpToken } from '../credentials/person-mcp-store.js'
import { AUTHORIZATION_CODE_GRANT, type ConnectFetch, type ConnectFetchResponse } from '../credentials/mcp-device-connect.js'
import {
  CONNECT_PASTE_MODAL_PREFIX,
  CONNECT_PASTE_PREFIX,
  connectButtonCustomId,
  formatAuthorizationCodeConnectPrompt,
  setConnectFetchForTests,
} from '../person-connect.js'
import { handleConnectButton, handleConnectPasteButton, handleConnectPasteModalSubmit } from './connect.js'

const ISSUER = 'https://auth.example.com'
const MCP_URL = `${ISSUER}/mcp`
const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`

let dataDir: string

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-connect-'))
  setDataDir(dataDir)
})
afterEach(async () => {
  resetHooks()
  clearIdentityCache()
  setConnectFetchForTests(undefined)
  await closeDatabase()
})

// ── Fixtures ────────────────────────────────────────────────────

/** Identity layer: each user id maps to their own allowed person with `acme`. */
function identity() {
  addFilter('person', (_value, { actor }) => person(actor.id ?? ''))
}

function person(id: string): Person {
  return {
    allowed: true,
    capabilities: new Set<Capability>(['sessions']),
    permissions: [],
    personId: `person-${id}`,
    mcpServers: [{ name: 'acme', url: MCP_URL, credential: 'acme' }],
  }
}

const personKeyOf = (id: string): string =>
  personKeyFrom({ personId: `person-${id}`, platform: 'discord', actorId: id }) ?? ''

/** An authorization server with no device grant: authorization code + S256 only. */
function authCodeServer() {
  const calls: Array<{ method: string; url: string; body?: string }> = []
  const routes: Record<string, { status?: number; json?: unknown; headers?: Record<string, string> }> = {
    [`POST ${MCP_URL}`]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` } },
    [`GET ${PRM_URL}`]: { json: { resource: MCP_URL, authorization_servers: [ISSUER], scopes_supported: ['mcp'] } },
    [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: {
      json: {
        issuer: ISSUER,
        token_endpoint: `${ISSUER}/oauth/token`,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
        grant_types_supported: [AUTHORIZATION_CODE_GRANT, 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      },
    },
    [`POST ${ISSUER}/oauth/register`]: { status: 201, json: { client_id: 'ac-client' } },
    [`POST ${ISSUER}/oauth/token`]: { json: { access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_in: 3600 } },
  }
  const fetchImpl: ConnectFetch = async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}) })
    const reply = routes[`${init.method} ${url}`] ?? { status: 404, json: {} }
    const status = reply.status ?? 200
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    const response: ConnectFetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      json: async () => reply.json,
      body: { cancel: async () => undefined },
    }
    return response
  }
  return { fetchImpl, calls }
}

type Reply = { content?: string; components?: unknown[] }

function fakeUser(id: string) {
  return { id, displayName: `User ${id}` }
}

function fakeInteraction(options: { user: { id: string; displayName: string }; customId: string; guildId?: string | null; channelId?: string | null; redirectedUrl?: string }) {
  const edits: Reply[] = []
  const replies: Reply[] = []
  const modals: Array<{ customId: string }> = []
  const interaction = {
    user: options.user,
    customId: options.customId,
    guildId: options.guildId === undefined ? '123' : options.guildId,
    channelId: options.channelId === undefined ? 'c1' : options.channelId,
    deferred: false,
    fields: { getTextInputValue: (name: string) => (name === 'redirect_url' ? (options.redirectedUrl ?? '') : '') },
    deferReply: vi.fn(async () => {
      interaction.deferred = true
    }),
    reply: vi.fn(async (payload: Reply) => {
      replies.push(payload)
    }),
    editReply: vi.fn(async (payload: Reply) => {
      edits.push(payload)
    }),
    showModal: vi.fn(async (modal: { customId: string }) => {
      modals.push(modal)
    }),
  }
  return { interaction, edits, replies, modals }
}

function componentCustomIds(components: unknown[] | undefined): string[] {
  return (components ?? []).flatMap((row) =>
    ((row as { toJSON(): { components: Array<{ custom_id?: string; url?: string }> } }).toJSON().components ?? []).map(
      (component) => component.custom_id ?? component.url ?? '',
    ),
  )
}

async function finalEdit(edits: Reply[], count: number): Promise<Reply> {
  await vi.waitFor(() => expect(edits.length).toBeGreaterThanOrEqual(count), { timeout: 5000 })
  return edits[count - 1]!
}

/** Click Connect on the starter's ephemeral list; returns the prompt edit. */
async function clickConnect(starterId: string) {
  identity()
  const oauth = authCodeServer()
  setConnectFetchForTests(oauth.fetchImpl)
  const click = fakeInteraction({ user: fakeUser(starterId), customId: connectButtonCustomId('connect', 'acme') })
  await handleConnectButton(click.interaction as unknown as ButtonInteraction)
  const prompt = click.edits[0]
  expect(prompt?.content).toContain('Sign in to connect **acme**')
  const ids = componentCustomIds(prompt?.components)
  const pasteId = ids.find((id) => id.startsWith('roadie_connect_paste:'))
  expect(pasteId).toBeTruthy()
  const link = ids.find((id) => id.startsWith('http'))
  expect(link).toBeTruthy()
  return { oauth, click, pasteId: pasteId!, link: link! }
}

// ── The paste modal ─────────────────────────────────────────────

describe('authorization-code prompt text', () => {
  const waitUntil = Date.now() + 10 * 60_000

  test('platforms with the paste button point at it', () => {
    const text = formatAuthorizationCodeConnectPrompt({ serverName: 'acme', waitUntil, pasteButton: true })
    expect(text).toContain('Sign in to connect **acme**')
    expect(text).toContain('**Paste redirect URL**')
    expect(text).toMatch(/expires in about 10 minutes/)
  })

  test('platforms without it do not mention the button', () => {
    const text = formatAuthorizationCodeConnectPrompt({ serverName: 'acme', waitUntil })
    expect(text).not.toContain('Paste redirect URL')
    expect(text).toContain('Open the link below and approve the request.')
  })
})

describe('paste redirect modal', () => {
  test('the starter opens the modal, pastes the redirect, and the token is stored', async () => {
    const { oauth, click, pasteId, link } = await clickConnect('111')

    const open = fakeInteraction({ user: fakeUser('111'), customId: pasteId })
    await handleConnectPasteButton(open.interaction as unknown as ButtonInteraction)
    expect(open.interaction.showModal).toHaveBeenCalledTimes(1)
    expect((open.modals[0] as unknown as { toJSON(): { custom_id: string } }).toJSON().custom_id).toBe(
      `${CONNECT_PASTE_MODAL_PREFIX}${pasteId.slice(CONNECT_PASTE_PREFIX.length)}`,
    )

    const state = new URL(link).searchParams.get('state')!
    const submit = fakeInteraction({
      user: fakeUser('111'),
      customId: pasteId,
      redirectedUrl: `http://127.0.0.1:1/callback?code=THE-CODE&state=${state}`,
    })
    await handleConnectPasteModalSubmit(submit.interaction as unknown as ModalSubmitInteraction)
    expect(submit.replies[0]!.content).toContain('finishing sign-in')

    const done = await finalEdit(click.edits, 2)
    expect(done.content).toContain('Connected **acme**')
    expect(readPersonMcpToken({ dataDir, personKey: personKeyOf('111'), credential: 'acme' })).toMatchObject({
      access: 'ACCESS-SECRET',
      refresh: 'REFRESH-SECRET',
      tokenEndpoint: `${ISSUER}/oauth/token`,
      clientId: 'ac-client',
    })
    const exchange = new URLSearchParams(oauth.calls.find((call) => call.url.endsWith('/oauth/token'))!.body!)
    expect(exchange.get('code')).toBe('THE-CODE')
  })

  test('a different person can neither open the modal nor submit the redirect', async () => {
    const { oauth, click, pasteId, link } = await clickConnect('111')
    const state = new URL(link).searchParams.get('state')!

    const otherOpen = fakeInteraction({ user: fakeUser('222'), customId: pasteId })
    await handleConnectPasteButton(otherOpen.interaction as unknown as ButtonInteraction)
    expect(otherOpen.interaction.showModal).not.toHaveBeenCalled()
    expect(otherOpen.replies[0]!.content).toMatch(/Only the person who started/)

    const otherSubmit = fakeInteraction({
      user: fakeUser('222'),
      customId: pasteId,
      redirectedUrl: `http://127.0.0.1:1/callback?code=THE-CODE&state=${state}`,
    })
    await handleConnectPasteModalSubmit(otherSubmit.interaction as unknown as ModalSubmitInteraction)
    expect(otherSubmit.replies[0]!.content).toMatch(/Only the person who started/)

    // Nothing was exchanged, and the clicker stored nothing under their own key.
    expect(oauth.calls.some((call) => call.url.endsWith('/oauth/token'))).toBe(false)
    expect(readPersonMcpToken({ dataDir, personKey: personKeyOf('222'), credential: 'acme' })).toBeNull()
  })

  test('bad pastes get specific refusals and the flow stays open', async () => {
    const { oauth, pasteId, link } = await clickConnect('111')

    const notUrl = fakeInteraction({ user: fakeUser('111'), customId: pasteId, redirectedUrl: 'not a url at all' })
    await handleConnectPasteModalSubmit(notUrl.interaction as unknown as ModalSubmitInteraction)
    expect(notUrl.replies[0]!.content).toMatch(/does not look like a sign-in redirect/)

    const wrongState = fakeInteraction({
      user: fakeUser('111'),
      customId: pasteId,
      redirectedUrl: 'http://127.0.0.1:1/callback?code=THE-CODE&state=from-another-attempt',
    })
    await handleConnectPasteModalSubmit(wrongState.interaction as unknown as ModalSubmitInteraction)
    expect(wrongState.replies[0]!.content).toMatch(/not started by this connect attempt/)

    // Still no exchange: the refusals did not consume the attempt.
    expect(oauth.calls.some((call) => call.url.endsWith('/oauth/token'))).toBe(false)
  })

  test('an unknown paste button is stale', async () => {
    identity()
    const stale = fakeInteraction({ user: fakeUser('111'), customId: 'roadie_connect_paste:deadbeef' })
    await handleConnectPasteButton(stale.interaction as unknown as ButtonInteraction)
    expect(stale.replies[0]!.content).toMatch(/no longer available/)
  })
})
