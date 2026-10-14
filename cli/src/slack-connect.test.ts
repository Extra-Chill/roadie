// Slack connect and welcome (#284), mirroring the Discord tests in
// person-welcome.test.ts: listing state, connect/disconnect actions, person
// isolation, private sign-in prompts, welcome once, not shown to denied
// actors, filter disable, Connect buttons only for missing tokens, and the
// NativeSlackBot routing of `/roadie connect|start` and connect buttons.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { setDataDir } from './config.js'
import { closeDatabase } from './database.js'
import { addFilter, resetHooks } from './hooks.js'
import { clearIdentityCache, type Capability, type Person } from './identity.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { listPersonMcpCredentials, readPersonMcpToken, setPersonMcpToken } from './credentials/person-mcp-store.js'
import {
  DEVICE_CODE_GRANT,
  type ConnectFetch,
  type ConnectFetchResponse,
} from './credentials/mcp-device-connect.js'
import { connectButtonCustomId, setConnectFetchForTests } from './person-connect.js'
import { resetWelcomeCache } from './person-welcome.js'
import { isTrustedResponseUrl } from './chat-platform/slack-api.js'
import {
  CONNECT_LINK_ACTION_ID,
  buildSlackConnectButtons,
  handleSlackConnectAction,
  handleSlackConnectCommand,
  handleSlackStartCommand,
  welcomeSlackUser,
  type SlackConnectApi,
} from './slack-connect.js'
import { NativeSlackBot } from './slack-bot.js'

const ISSUER = 'https://auth.example.com'
const MCP_URL = `${ISSUER}/mcp`
const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`
const RESPONSE_URL = 'https://hooks.slack.com/actions/T1/123/abc'
const WORKSPACE = 'T1'
const CHANNEL = 'C1'

const servers = [
  { name: 'acme', url: MCP_URL, credential: 'acme' },
  { name: 'docs', url: MCP_URL, credential: 'docs' },
]

let dataDir: string

function person(overrides: Partial<Person> = {}): Person {
  return { allowed: true, capabilities: new Set<Capability>(['sessions']), permissions: [], ...overrides }
}

/** Identity layer: Slack user id → person. Unknown users are denied. */
function people(map: Record<string, Person>) {
  addFilter('person', (_value, context) => map[context.actor.id] ?? null)
}

type Sent =
  | { kind: 'respond'; responseUrl: string; text: string; blocks?: unknown[]; replaceOriginal?: boolean }
  | { kind: 'ephemeral'; channel: string; user: string; text: string; blocks?: unknown[] }
  | { kind: 'post'; channel: string; text: string; blocks?: unknown[] }
  | { kind: 'edit'; channel: string; ts: string; text: string; blocks?: unknown[] }
  | { kind: 'openDm'; user: string }

function fakeSlack() {
  const sent: Sent[] = []
  let ts = 0
  const api: SlackConnectApi = {
    respond: async (input) => {
      sent.push({ kind: 'respond', ...input })
    },
    postEphemeral: async (input) => {
      sent.push({ kind: 'ephemeral', ...input })
      return undefined
    },
    post: async (input) => {
      sent.push({ kind: 'post', channel: input.channel, text: input.text, ...(input.blocks ? { blocks: input.blocks } : {}) })
      ts += 1
      return { id: `1000.${ts}` }
    },
    edit: async (input) => {
      sent.push({ kind: 'edit', ...input })
      return undefined
    },
    openDm: async (user) => {
      sent.push({ kind: 'openDm', user })
      return `D-${user}`
    },
  }
  return { api, sent }
}

function textOf(entry: Sent | undefined): string {
  return entry && 'text' in entry ? entry.text : ''
}

/** Action ids of every button in a message's blocks. */
function actionIds(blocks: unknown[] | undefined): string[] {
  return (blocks ?? []).flatMap((block) => {
    const elements = (block as { elements?: Array<{ action_id: string }> }).elements ?? []
    return elements.map((element) => element.action_id)
  })
}

/** An OAuth server that supports the device grant and approves on first poll. */
function oauthServer() {
  const calls: string[] = []
  const reply = (status: number, json: unknown, headers: Record<string, string> = {}): ConnectFetchResponse => {
    const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
      json: async () => json,
      body: { cancel: async () => undefined },
    }
  }
  const fetchImpl: ConnectFetch = async (url, init) => {
    calls.push(`${init.method} ${url}`)
    switch (`${init.method} ${url}`) {
      case `POST ${MCP_URL}`:
        return reply(401, {}, { 'WWW-Authenticate': `Bearer resource_metadata="${PRM_URL}"` })
      case `GET ${PRM_URL}`:
        return reply(200, { resource: MCP_URL, authorization_servers: [ISSUER] })
      case `GET ${ISSUER}/.well-known/oauth-authorization-server`:
        return reply(200, {
          issuer: ISSUER,
          token_endpoint: `${ISSUER}/oauth/token`,
          device_authorization_endpoint: `${ISSUER}/oauth/device`,
          registration_endpoint: `${ISSUER}/oauth/register`,
          grant_types_supported: [DEVICE_CODE_GRANT, 'refresh_token'],
        })
      case `POST ${ISSUER}/oauth/register`:
        return reply(201, { client_id: 'client-1' })
      case `POST ${ISSUER}/oauth/device`:
        return reply(200, {
          device_code: 'DEVICE-SECRET',
          user_code: 'ABCD-EFGH',
          verification_uri: `${ISSUER}/device`,
          verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        })
      case `POST ${ISSUER}/oauth/token`:
        return reply(200, { access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_in: 3600 })
      default:
        return reply(404, { error: 'not_found' })
    }
  }
  return { fetchImpl, calls }
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-slack-connect-'))
  setDataDir(dataDir)
  // No channels config from the environment: only tests that set one get one.
  setChannelsConfigPath(null)
})
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})
afterEach(async () => {
  resetHooks()
  clearIdentityCache()
  resetWelcomeCache()
  setConnectFetchForTests(undefined)
  setChannelsConfigPath(null)
  await closeDatabase()
})

describe('/roadie connect', () => {
  test('lists the speaker’s own servers ephemerally with Connect and Disconnect buttons', async () => {
    people({ UALICE: person({ personId: 'wp:list', mcpServers: servers }) })
    await setPersonMcpToken({ dataDir, personKey: 'wp:list', credential: 'docs', token: { access: 'tok' } })
    const { api, sent } = fakeSlack()
    await handleSlackConnectCommand({ api, workspaceId: WORKSPACE, channelId: CHANNEL, userId: 'UALICE', responseUrl: RESPONSE_URL, dataDir })
    const reply = sent.find((entry) => entry.kind === 'respond')
    expect(reply).toMatchObject({ kind: 'respond', responseUrl: RESPONSE_URL })
    expect(reply!.text).toContain('**acme**: not connected')
    expect(reply!.text).toContain('**docs**: connected')
    expect(actionIds(reply!.blocks)).toEqual([connectButtonCustomId('connect', 'acme'), connectButtonCustomId('disconnect', 'docs')])
    // Nothing went to a shared channel.
    expect(sent.some((entry) => entry.kind === 'post' && !entry.channel.startsWith('D-'))).toBe(false)
  })

  test('falls back to chat.postEphemeral without a response URL', async () => {
    people({ UALICE: person({ personId: 'wp:list2', mcpServers: servers }) })
    const { api, sent } = fakeSlack()
    await handleSlackConnectCommand({ api, workspaceId: WORKSPACE, channelId: CHANNEL, userId: 'UALICE', dataDir })
    const reply = sent.find((entry) => entry.kind === 'ephemeral')
    expect(reply).toMatchObject({ kind: 'ephemeral', channel: CHANNEL, user: 'UALICE' })
  })

  test('denied, unmapped and server-less speakers, and no identity layer, get a private refusal', async () => {
    const { api, sent } = fakeSlack()
    await handleSlackConnectCommand({ api, workspaceId: WORKSPACE, channelId: CHANNEL, userId: 'UX', responseUrl: RESPONSE_URL, dataDir })
    expect(sent.at(-1)).toMatchObject({ kind: 'respond', text: 'Per-person services are not configured on this workspace.' })
    people({ UDENIED: person({ allowed: false, mcpServers: servers }), UNONE: person({ personId: 'wp:none' }) })
    for (const [userId, text] of [
      ['UDENIED', 'Your account is not linked to Roadie.'],
      ['UNKNOWN', 'Your account is not linked to Roadie.'],
      ['UNONE', 'There are no services for you to connect.'],
    ] as const) {
      await handleSlackConnectCommand({ api, workspaceId: WORKSPACE, channelId: CHANNEL, userId, responseUrl: RESPONSE_URL, dataDir })
      expect(sent.at(-1)).toMatchObject({ kind: 'respond', text })
    }
    expect(sent.every((entry) => entry.kind === 'respond' || entry.kind === 'openDm')).toBe(true)
  })

  test('respects channel policy: refused outside the audience, allowed in DMs', async () => {
    const config = path.join(dataDir, 'channels.json')
    fs.writeFileSync(config, JSON.stringify({ channels: { [CHANNEL]: { directory: dataDir, who: ['user:USOMEONE'] } } }))
    setChannelsConfigPath(config)
    people({ UALICE: person({ personId: 'wp:policy', mcpServers: servers }) })
    const { api, sent } = fakeSlack()
    await handleSlackConnectCommand({ api, workspaceId: WORKSPACE, channelId: CHANNEL, userId: 'UALICE', responseUrl: RESPONSE_URL, dataDir })
    expect(sent.at(-1)).toMatchObject({ text: 'Roadie is not available to you in this channel.' })
    await handleSlackConnectCommand({ api, workspaceId: WORKSPACE, channelId: 'D123', userId: 'UALICE', responseUrl: RESPONSE_URL, dataDir })
    expect(textOf(sent.at(-1))).toContain('Your connected services:')
  })
})

describe('connect buttons', () => {
  test('Connect shows the link and code only in the clicked ephemeral message, then updates it', async () => {
    people({ UALICE: person({ personId: 'wp:alice', mcpServers: servers }) })
    const oauth = oauthServer()
    setConnectFetchForTests(oauth.fetchImpl, async () => undefined)
    const { api, sent } = fakeSlack()
    await handleSlackConnectAction({
      api,
      workspaceId: WORKSPACE,
      user: { id: 'UALICE' },
      actionId: connectButtonCustomId('connect', 'acme'),
      channelId: CHANNEL,
      responseUrl: RESPONSE_URL,
      isEphemeral: true,
      dataDir,
    })
    const prompt = sent[0]!
    expect(prompt).toMatchObject({ kind: 'respond', responseUrl: RESPONSE_URL, replaceOriginal: true })
    expect(prompt.kind === 'respond' && prompt.text).toContain('`ABCD-EFGH`')
    expect(JSON.stringify(prompt.kind === 'respond' && prompt.blocks)).toContain(`${ISSUER}/device?user_code=ABCD-EFGH`)
    expect(actionIds(prompt.kind === 'respond' ? prompt.blocks : [])).toEqual([CONNECT_LINK_ACTION_ID])

    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const done = sent[1]!
    expect(done).toMatchObject({ kind: 'respond', responseUrl: RESPONSE_URL, replaceOriginal: true })
    expect(done.kind === 'respond' && done.text).toContain('Connected **acme**')
    // The refreshed list now offers Disconnect for acme.
    expect(actionIds(done.kind === 'respond' ? done.blocks : [])).toEqual([
      connectButtonCustomId('disconnect', 'acme'),
      connectButtonCustomId('connect', 'docs'),
    ])
    expect(readPersonMcpToken({ dataDir, personKey: 'wp:alice', credential: 'acme' })?.access).toBe('ACCESS-SECRET')
    // No token, refresh token or device code was ever shown.
    expect(JSON.stringify(sent)).not.toMatch(/ACCESS-SECRET|REFRESH-SECRET|DEVICE-SECRET/)
    // Nothing reached a shared channel.
    expect(sent.some((entry) => entry.kind === 'post' || entry.kind === 'ephemeral')).toBe(false)
  })

  test('a click on a non-ephemeral message (the welcome DM) answers in the clicker’s own DM', async () => {
    people({ UALICE: person({ personId: 'wp:dm-click', mcpServers: servers }) })
    setConnectFetchForTests(oauthServer().fetchImpl, async () => undefined)
    const { api, sent } = fakeSlack()
    await handleSlackConnectAction({
      api,
      workspaceId: WORKSPACE,
      user: { id: 'UALICE' },
      actionId: connectButtonCustomId('connect', 'docs'),
      channelId: 'DALICE',
      responseUrl: RESPONSE_URL,
      isEphemeral: false,
      dataDir,
    })
    await vi.waitFor(() => expect(sent.filter((entry) => entry.kind === 'edit')).toHaveLength(1))
    expect(sent[0]).toEqual({ kind: 'openDm', user: 'UALICE' })
    expect(sent[1]).toMatchObject({ kind: 'post', channel: 'D-UALICE' })
    expect(sent[2]).toMatchObject({ kind: 'edit', channel: 'D-UALICE', ts: '1000.1' })
    expect(sent.some((entry) => entry.kind === 'respond')).toBe(false)
  })

  test('the person key comes from the clicker: a foreign server is refused, a shared one uses the clicker’s key', async () => {
    people({
      UALICE: person({ personId: 'wp:alice-iso', mcpServers: servers }),
      UBOB: person({ personId: 'wp:bob-iso', mcpServers: [servers[1]!] }),
    })
    const oauth = oauthServer()
    setConnectFetchForTests(oauth.fetchImpl, async () => undefined)
    const { api, sent } = fakeSlack()
    const click = (userId: string, serverName: string) =>
      handleSlackConnectAction({
        api,
        workspaceId: WORKSPACE,
        user: { id: userId },
        actionId: connectButtonCustomId('connect', serverName),
        channelId: CHANNEL,
        responseUrl: RESPONSE_URL,
        isEphemeral: true,
        dataDir,
      })
    // Bob clicking Alice's "Connect acme": acme is not his.
    await click('UBOB', 'acme')
    expect(sent.at(-1)).toMatchObject({ text: 'That service is not available for your account.' })
    expect(oauth.calls).toHaveLength(0)
    // Bob clicking a server they share connects Bob, never Alice.
    await click('UBOB', 'docs')
    await vi.waitFor(() => expect(listPersonMcpCredentials({ dataDir, personKey: 'wp:bob-iso' })).toEqual(['docs']))
    expect(listPersonMcpCredentials({ dataDir, personKey: 'wp:alice-iso' })).toEqual([])
    // A denied clicker gets nothing.
    await click('UNKNOWN', 'docs')
    expect(sent.at(-1)).toMatchObject({ text: 'Your account is not linked to Roadie.' })
  })

  test('Disconnect removes only the clicker’s token and refreshes the list', async () => {
    people({
      UALICE: person({ personId: 'wp:alice-dc', mcpServers: servers }),
      UBOB: person({ personId: 'wp:bob-dc', mcpServers: servers }),
    })
    for (const key of ['wp:alice-dc', 'wp:bob-dc'])
      await setPersonMcpToken({ dataDir, personKey: key, credential: 'acme', token: { access: 'tok' } })
    const { api, sent } = fakeSlack()
    await handleSlackConnectAction({
      api,
      workspaceId: WORKSPACE,
      user: { id: 'UALICE' },
      actionId: connectButtonCustomId('disconnect', 'acme'),
      channelId: CHANNEL,
      responseUrl: RESPONSE_URL,
      isEphemeral: true,
      dataDir,
    })
    expect(sent[0]).toMatchObject({ kind: 'respond', replaceOriginal: true })
    expect(sent[0]!.kind === 'respond' && sent[0]!.text).toContain('Disconnected **acme**.')
    expect(actionIds(sent[0]!.kind === 'respond' ? sent[0]!.blocks : [])).toEqual([
      connectButtonCustomId('connect', 'acme'),
      connectButtonCustomId('connect', 'docs'),
    ])
    expect(listPersonMcpCredentials({ dataDir, personKey: 'wp:alice-dc' })).toEqual([])
    expect(listPersonMcpCredentials({ dataDir, personKey: 'wp:bob-dc' })).toEqual(['acme'])
  })

  test('the sign-in link button and unknown ids are ignored', async () => {
    people({ UALICE: person({ personId: 'wp:link', mcpServers: servers }) })
    const { api, sent } = fakeSlack()
    for (const actionId of [CONNECT_LINK_ACTION_ID, 'roadie_connect:x:acme'])
      await handleSlackConnectAction({ api, workspaceId: WORKSPACE, user: { id: 'UALICE' }, actionId, responseUrl: RESPONSE_URL, isEphemeral: true, dataDir })
    expect(sent).toEqual([])
  })

  test('buttons: Connect only for missing tokens when Disconnect is excluded', () => {
    const states = [
      { server: servers[0]!, connected: true },
      { server: servers[1]!, connected: false },
    ]
    expect(actionIds(buildSlackConnectButtons({ states }))).toEqual(['roadie_connect:d:acme', 'roadie_connect:c:docs'])
    expect(actionIds(buildSlackConnectButtons({ states, includeDisconnect: false }))).toEqual(['roadie_connect:c:docs'])
  })

  test('response URLs must be Slack hooks (or the local API in tests)', () => {
    expect(isTrustedResponseUrl(RESPONSE_URL)).toBe(true)
    expect(isTrustedResponseUrl('http://hooks.slack.com/x')).toBe(false)
    expect(isTrustedResponseUrl('https://evil.example.com/x')).toBe(false)
    expect(isTrustedResponseUrl('http://127.0.0.1:9/response', 'http://127.0.0.1:9/api/')).toBe(true)
    expect(isTrustedResponseUrl('not a url')).toBe(false)
  })
})

describe('Slack welcome', () => {
  test('is a DM, sent once, with Connect buttons only for servers lacking a token', async () => {
    people({})
    await setPersonMcpToken({ dataDir, personKey: 'wp:welcome', credential: 'acme', token: { access: 'tok' } })
    const { api, sent } = fakeSlack()
    const p = person({ personId: 'wp:welcome', mcpServers: servers })
    expect(await welcomeSlackUser({ api, userId: 'UW1', displayName: 'Ada', person: p, channelId: CHANNEL, dataDir })).toBe('sent')
    expect(await welcomeSlackUser({ api, userId: 'UW1', person: p, channelId: CHANNEL, dataDir })).toBe('skipped')
    resetWelcomeCache()
    expect(await welcomeSlackUser({ api, userId: 'UW1', person: p, dataDir })).toBe('skipped')
    const posts = sent.filter((entry) => entry.kind === 'post')
    expect(posts).toHaveLength(1)
    expect(sent[0]).toEqual({ kind: 'openDm', user: 'UW1' })
    expect(posts[0]).toMatchObject({ channel: 'D-UW1' })
    expect(posts[0]!.text).toContain('Welcome, Ada!')
    expect(posts[0]!.text).toContain(`<#${CHANNEL}>`)
    expect(posts[0]!.text).toContain('/roadie connect')
    expect(posts[0]!.text).toContain('/roadie start')
    expect(actionIds(posts[0]!.blocks)).toEqual([connectButtonCustomId('connect', 'docs')])
  })

  test('is not sent to denied, unmapped, CLI-asserted or bot actors, or without an identity layer', async () => {
    const { api, sent } = fakeSlack()
    expect(await welcomeSlackUser({ api, userId: 'UW2', person: person({ personId: 'wp:w-none' }), dataDir })).toBe('skipped')
    people({})
    expect(await welcomeSlackUser({ api, userId: 'UW2', person: person({ allowed: false, personId: 'wp:w-denied' }), dataDir })).toBe('skipped')
    expect(await welcomeSlackUser({ api, userId: 'UW2', person: null, dataDir })).toBe('skipped')
    expect(await welcomeSlackUser({ api, userId: 'UW2', person: person({ personId: 'wp:w-cli' }), via: 'cli', dataDir })).toBe('skipped')
    expect(await welcomeSlackUser({ api, userId: 'UW2', person: person({ personId: 'wp:w-bot' }), isBot: true, dataDir })).toBe('skipped')
    expect(await welcomeSlackUser({ api, userId: 'BHOSTBOT', person: person({ personId: 'wp:w-bid' }), dataDir })).toBe('skipped')
    expect(sent).toEqual([])
  })

  test('the welcome_message filter disables it, and enabling it later still welcomes', async () => {
    people({})
    const { api, sent } = fakeSlack()
    const p = person({ personId: 'wp:w-off' })
    const off = addFilter('welcome_message', () => null)
    expect(await welcomeSlackUser({ api, userId: 'UW3', person: p, dataDir })).toBe('disabled')
    off()
    resetWelcomeCache()
    addFilter('welcome_message', (_value, context) => `Hi ${context.actor.platform}`)
    expect(await welcomeSlackUser({ api, userId: 'UW3', person: p, dataDir })).toBe('sent')
    expect(sent.filter((entry) => entry.kind === 'post').map((entry) => entry.kind === 'post' && entry.text)).toEqual(['Hi slack'])
  })

  test('a failed DM is not retried', async () => {
    people({})
    let opens = 0
    const api = { ...fakeSlack().api, openDm: async () => { opens += 1; return new Error('cannot_dm_bot') as never } }
    const p = person({ personId: 'wp:w-fail' })
    expect(await welcomeSlackUser({ api, userId: 'UW4', person: p, dataDir })).toBe('failed')
    resetWelcomeCache()
    expect(await welcomeSlackUser({ api, userId: 'UW4', person: p, dataDir })).toBe('skipped')
    expect(opens).toBe(1)
  })

  test('/roadie start shows the welcome ephemerally, every time, without consuming the first-contact welcome', async () => {
    people({ UALICE: person({ personId: 'wp:start', mcpServers: servers }) })
    const { api, sent } = fakeSlack()
    const run = () => handleSlackStartCommand({ api, workspaceId: WORKSPACE, channelId: CHANNEL, userId: 'UALICE', userName: 'alice', responseUrl: RESPONSE_URL, dataDir })
    await run()
    await run()
    const replies = sent.filter((entry) => entry.kind === 'respond')
    expect(replies).toHaveLength(2)
    expect(replies[0]!.text).toContain('Welcome, alice!')
    expect(actionIds(replies[0]!.blocks)).toEqual([connectButtonCustomId('connect', 'acme'), connectButtonCustomId('connect', 'docs')])
    expect(sent.some((entry) => entry.kind === 'post')).toBe(false)
    // The first-contact welcome is still due.
    expect(await welcomeSlackUser({ api, userId: 'UALICE', person: person({ personId: 'wp:start' }), dataDir })).toBe('sent')

    // Disabled, or an unmapped speaker: a short private note.
    addFilter('welcome_message', () => '')
    await run()
    expect(sent.at(-1)).toMatchObject({ kind: 'respond', text: 'There is no welcome message on this workspace.' })
    await handleSlackStartCommand({ api, workspaceId: WORKSPACE, channelId: CHANNEL, userId: 'UNKNOWN', responseUrl: RESPONSE_URL, dataDir })
    expect(textOf(sent.at(-1))).toContain("I'm Roadie")
  })
})

describe('NativeSlackBot routing', () => {
  function bot() {
    const instance = new NativeSlackBot({ token: 'xoxb-test', signingSecret: 'secret' })
    instance.workspaceId = WORKSPACE
    const { api, sent } = fakeSlack()
    Object.assign(instance.api, api)
    const dispatch = (delivery: unknown) =>
      (instance as unknown as { dispatch(delivery: unknown): Promise<void | Error> }).dispatch(delivery)
    return { instance, sent, dispatch }
  }
  const command = (text: string, userId = 'UALICE') => ({
    kind: 'command',
    event: { team_id: WORKSPACE, channel_id: 'D9', user_id: userId, user_name: 'alice', command: '/roadie', text, trigger_id: 't1', response_url: RESPONSE_URL },
  })

  test('/roadie connect and /roadie start answer privately through the response URL', async () => {
    people({ UALICE: person({ personId: 'wp:route', mcpServers: servers }) })
    const { sent, dispatch } = bot()
    await dispatch(command('connect'))
    expect(sent.find((entry) => entry.kind === 'respond')!.text).toContain('Your connected services:')
    await dispatch(command('start'))
    expect(sent.filter((entry) => entry.kind === 'respond').at(-1)!.text).toContain('/roadie connect')
  })

  test('connect buttons route by action id and act for the clicking user', async () => {
    people({ UBOB: person({ personId: 'wp:route-bob', mcpServers: [servers[1]!] }) })
    const { sent, dispatch } = bot()
    await dispatch({
      kind: 'interaction',
      event: {
        type: 'block_actions',
        team: { id: WORKSPACE },
        user: { id: 'UBOB' },
        channel: { id: CHANNEL },
        response_url: RESPONSE_URL,
        container: { is_ephemeral: true },
        actions: [{ action_id: connectButtonCustomId('disconnect', 'acme') }],
      },
    })
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ kind: 'respond', text: 'That service is not available for your account.' }))
  })

  test('an admitted person’s first message triggers one welcome DM; denied speakers get none', async () => {
    people({ UALICE: person({ personId: 'wp:route-welcome', mcpServers: servers }) })
    const { instance, sent, dispatch } = bot()
    Object.assign(instance.api, {
      call: async (_operation: string, body: { user: string }) => ({ user: { id: body.user, name: body.user.toLowerCase() } }),
    })
    const message = (user: string, ts: string) => ({
      kind: 'message',
      event: { type: 'message', channel: CHANNEL, ts, user, text: 'hello' },
    })
    // No project is bound, so the turn itself fails after the welcome fires.
    await dispatch(message('UALICE', '1.1'))
    await dispatch(message('UALICE', '1.2'))
    await dispatch(message('UNKNOWN', '1.3'))
    await vi.waitFor(() => expect(sent.filter((entry) => entry.kind === 'post')).toHaveLength(1))
    const post = sent.find((entry) => entry.kind === 'post')!
    expect(post).toMatchObject({ channel: 'D-UALICE' })
    expect(post.kind === 'post' && post.text).toContain('Welcome, ualice!')
    expect(sent.filter((entry) => entry.kind === 'openDm')).toEqual([{ kind: 'openDm', user: 'UALICE' }])
  })
})
