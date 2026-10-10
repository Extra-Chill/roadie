// Per-person MCP servers: identity hook config, per-person token store,
// backend registration and per-turn permission scoping.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { AgentBackend } from './agent-backend/types.js'
import { evaluatePermission, parsePermissionRules } from './permission-policy.js'
import { buildOpencodeServerConfig } from './opencode.js'
import { getIdentityHookCommand, resolvePerson, setIdentityHookCommand } from './identity.js'
import {
  getPersonMcpAccessToken,
  listPersonMcpCredentials,
  personMcpDir,
  removePersonMcpToken,
  setPersonMcpToken,
} from './credentials/person-mcp-store.js'
import {
  PERSON_MCP_TOOL_GLOB,
  personMcpScope,
  personMcpServerName,
  registerPersonMcpServers,
} from './person-mcp.js'
import { applyPersonToIngress, type IngressInput } from './session-handler/thread-session-runtime.js'

let dir: string
let dataDir: string

const MCP_URL = 'https://auth.example.com/wp-json/mcp'

const hook = `input=$(cat)
case "$input" in
  *'"id":"alice"'*) echo '{"allowed":true,"person_id":"wp:1","mcp_servers":[{"name":"extrachill","url":"${MCP_URL}"}]}' ;;
  *'"id":"bob"'*) echo '{"allowed":true,"person_id":"wp:2","mcp_servers":[{"name":"extrachill","url":"${MCP_URL}"}]}' ;;
  *'"id":"carol"'*) echo '{"allowed":true,"person_id":"wp:3"}' ;;
  *'"id":"mallory"'*) echo '{"allowed":false,"person_id":"wp:4","mcp_servers":[{"name":"extrachill","url":"${MCP_URL}"}]}' ;;
  *'"id":"sloppy"'*) echo '{"allowed":true,"person_id":"wp:5","mcp_servers":[{"name":"Bad Name","url":"${MCP_URL}"},{"name":"plain","url":"http://evil.example.com/mcp"},{"name":"ok","url":"${MCP_URL}","credential":"shared-ref"},{"name":"ok","url":"${MCP_URL}"}]}' ;;
  *) echo '{"allowed":false}' ;;
esac`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-person-mcp-'))
  dataDir = path.join(dir, 'data')
  const file = path.join(dir, 'hook.sh')
  fs.writeFileSync(file, `#!/bin/sh\n${hook}\n`, { mode: 0o755 })
  hookFile = file
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  setIdentityHookCommand(undefined)
})

let hookFile: string

type AddCall = { directory: string; name: string; url: string; headers: Record<string, string> }

function fakeBackend() {
  const calls: AddCall[] = []
  const backend = {
    mcp: {
      async addRemote(input: AddCall) {
        calls.push(input)
      },
    },
  } as unknown as AgentBackend
  return { backend, calls }
}

async function actorPerson(id: string) {
  // Do not reset the hook here: setIdentityHookCommand clears the person cache.
  if (getIdentityHookCommand() !== hookFile) setIdentityHookCommand(hookFile)
  const person = await resolvePerson({ actor: { platform: 'discord', id } })
  if (!person) throw new Error('hook not configured')
  return person
}

/** Run one person's turn the way the runtime does and return the visible server names. */
async function registerFor(id: string, backend: AgentBackend) {
  const person = await actorPerson(id)
  const personKey = person.personId ?? `discord:${id}`
  return registerPersonMcpServers({
    backend,
    directory: '/proj',
    dataDir,
    personKey,
    servers: person.mcpServers ?? [],
  })
}

describe('identity hook mcp_servers', () => {
  test('allowed people get their servers, denied and plain people get none', async () => {
    expect((await actorPerson('alice')).mcpServers).toEqual([
      { name: 'extrachill', url: MCP_URL, credential: 'extrachill' },
    ])
    expect((await actorPerson('carol')).mcpServers).toBeUndefined()
    const mallory = await actorPerson('mallory')
    expect(mallory.allowed).toBe(false)
    expect(mallory.mcpServers).toBeUndefined()
  })

  test('invalid names, non-https urls and duplicates are dropped individually', async () => {
    const sloppy = await actorPerson('sloppy')
    expect(sloppy.allowed).toBe(true)
    expect(sloppy.mcpServers).toEqual([{ name: 'ok', url: MCP_URL, credential: 'shared-ref' }])
  })
})

describe('per-person token store', () => {
  test('files are 0600 in 0700 dirs, separate per person, and never listed with contents', async () => {
    await setPersonMcpToken({ dataDir, personKey: 'wp:10', credential: 'store-a', token: { access: 'secret-ten' } })
    await setPersonMcpToken({ dataDir, personKey: 'wp:11', credential: 'store-a', token: { access: 'secret-eleven' } })
    const dirTen = personMcpDir({ dataDir, personKey: 'wp:10' })
    expect(dirTen).not.toBe(personMcpDir({ dataDir, personKey: 'wp:11' }))
    expect(fs.statSync(path.join(dirTen, 'store-a.json')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dirTen).mode & 0o777).toBe(0o700)
    expect(listPersonMcpCredentials({ dataDir, personKey: 'wp:10' })).toEqual(['store-a'])
    expect(await getPersonMcpAccessToken({ dataDir, personKey: 'wp:10', credential: 'store-a' })).toBe('secret-ten')
    expect(await getPersonMcpAccessToken({ dataDir, personKey: 'wp:11', credential: 'store-a' })).toBe('secret-eleven')
    expect(await getPersonMcpAccessToken({ dataDir, personKey: 'wp:12', credential: 'store-a' })).toBeNull()
    expect(await removePersonMcpToken({ dataDir, personKey: 'wp:10', credential: 'store-a' })).toBe(true)
    expect(await getPersonMcpAccessToken({ dataDir, personKey: 'wp:10', credential: 'store-a' })).toBeNull()
  })

  test('rejects path-like credential names and non-https token endpoints', async () => {
    expect(await setPersonMcpToken({ dataDir, personKey: 'wp:10', credential: '../x', token: { access: 'a' } })).toBeInstanceOf(Error)
    expect(
      await setPersonMcpToken({
        dataDir,
        personKey: 'wp:10',
        credential: 'ok',
        token: { access: 'a', tokenEndpoint: 'http://evil.example.com/token' },
      }),
    ).toBeInstanceOf(Error)
  })

  test('refreshes an expired token under lock and persists the rotated refresh token', async () => {
    const personKey = 'wp:refresh'
    await setPersonMcpToken({
      dataDir,
      personKey,
      credential: 'rot',
      token: {
        access: 'old-access',
        expires: 1_000,
        refresh: 'refresh-1',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
      },
    })
    const bodies: string[] = []
    const fetchImpl = async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'new-access', refresh_token: 'refresh-2', expires_in: 3600 }),
      }
    }
    const now = 5_000_000
    const [a, b] = await Promise.all([
      getPersonMcpAccessToken({ dataDir, personKey, credential: 'rot', now, fetchImpl }),
      getPersonMcpAccessToken({ dataDir, personKey, credential: 'rot', now, fetchImpl }),
    ])
    expect([a, b]).toEqual(['new-access', 'new-access'])
    // The second caller re-read the refreshed record instead of refreshing again.
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('refresh_token=refresh-1')
    const stored = JSON.parse(fs.readFileSync(path.join(personMcpDir({ dataDir, personKey }), 'rot.json'), 'utf8'))
    expect(stored).toMatchObject({ access: 'new-access', refresh: 'refresh-2', expires: now + 3_600_000 })
  })

  test('an expired token without a refresh path is an error, not a stale token', async () => {
    await setPersonMcpToken({ dataDir, personKey: 'wp:stale', credential: 'dead', token: { access: 'x', expires: 1 } })
    expect(await getPersonMcpAccessToken({ dataDir, personKey: 'wp:stale', credential: 'dead', now: 10_000_000 })).toBeInstanceOf(Error)
  })
})

describe('two people in one channel', () => {
  test('each person is registered with their own token under their own scoped server', async () => {
    await setPersonMcpToken({ dataDir, personKey: 'wp:1', credential: 'extrachill', token: { access: 'alice-token' } })
    await setPersonMcpToken({ dataDir, personKey: 'wp:2', credential: 'extrachill', token: { access: 'bob-token' } })
    const { backend, calls } = fakeBackend()

    const aliceNames = await registerFor('alice', backend)
    const bobNames = await registerFor('bob', backend)

    const aliceName = personMcpServerName({ personKey: 'wp:1', name: 'extrachill' })
    const bobName = personMcpServerName({ personKey: 'wp:2', name: 'extrachill' })
    expect(aliceName).not.toBe(bobName)
    expect(aliceNames).toEqual([aliceName])
    expect(bobNames).toEqual([bobName])
    expect(calls.map((call) => [call.name, call.headers.Authorization])).toEqual([
      [aliceName, 'Bearer alice-token'],
      [bobName, 'Bearer bob-token'],
    ])

    // Same token again: no reconnect. A rotated token: re-registered.
    await registerFor('alice', backend)
    expect(calls).toHaveLength(2)
    await setPersonMcpToken({ dataDir, personKey: 'wp:1', credential: 'extrachill', token: { access: 'alice-token-2' } })
    await registerFor('alice', backend)
    expect(calls).toHaveLength(3)
    expect(calls[2]?.headers.Authorization).toBe('Bearer alice-token-2')
  })

  test('turn permissions allow only the speaker scope; the server config denies the rest', async () => {
    const serverPermission = buildOpencodeServerConfig({
      externalDirectoryPermissions: {},
      skillPermission: undefined,
      pluginList: [],
      roadiePoolProvider: null,
    }).permission
    expect(serverPermission[PERSON_MCP_TOOL_GLOB]).toBe('deny')

    const base: IngressInput = { prompt: 'hi', userId: 'alice', username: 'Alice', mode: 'opencode' }
    await actorPerson('alice')
    await actorPerson('bob')
    await actorPerson('carol')
    const rulesFor = (userId: string) =>
      parsePermissionRules(applyPersonToIngress({ ...base, userId }).permissions)
    const aliceTool = `${personMcpServerName({ personKey: 'wp:1', name: 'extrachill' })}_ability-call`
    const bobTool = `${personMcpServerName({ personKey: 'wp:2', name: 'extrachill' })}_ability-call`
    const decide = (userId: string, tool: string) =>
      evaluatePermission({
        // Server config first, then the speaker's session rules.
        rules: [{ permission: PERSON_MCP_TOOL_GLOB, pattern: '*', action: 'deny' }, ...rulesFor(userId)],
        permission: tool,
        targets: ['*'],
        fallback: 'allow',
      })

    expect(decide('alice', aliceTool)).toBe('allow')
    expect(decide('alice', bobTool)).toBe('deny')
    expect(decide('bob', bobTool)).toBe('allow')
    expect(decide('bob', aliceTool)).toBe('deny')
    // A person without config gets no person-scoped tools at all.
    expect(decide('carol', aliceTool)).toBe('deny')
    expect(decide('carol', bobTool)).toBe('deny')
    // Bob speaking later in Alice's thread: the session still carries Alice's
    // earlier allow, but Bob's turn appends a reset that comes later.
    const sessionRules = [
      { permission: PERSON_MCP_TOOL_GLOB, pattern: '*', action: 'deny' as const },
      ...rulesFor('alice'),
      ...rulesFor('bob'),
    ]
    const afterBob = (tool: string) =>
      evaluatePermission({ rules: sessionRules, permission: tool, targets: ['*'], fallback: 'allow' })
    expect(afterBob(aliceTool)).toBe('deny')
    expect(afterBob(bobTool)).toBe('allow')
  })

  test('scopes are unique per person key', () => {
    expect(personMcpScope('wp:1')).not.toBe(personMcpScope('wp:2'))
    expect(personMcpScope('wp:1')).toBe(personMcpScope('wp:1'))
  })
})

describe('people without config or access', () => {
  test('a person without mcp_servers registers nothing, even with a token on disk', async () => {
    await setPersonMcpToken({ dataDir, personKey: 'wp:3', credential: 'extrachill', token: { access: 'carol-token' } })
    const { backend, calls } = fakeBackend()
    expect(await registerFor('carol', backend)).toEqual([])
    expect(calls).toEqual([])
  })

  test('a denied person registers nothing and gets no allow rule', async () => {
    await setPersonMcpToken({ dataDir, personKey: 'wp:4', credential: 'extrachill', token: { access: 'mallory-token' } })
    const { backend, calls } = fakeBackend()
    expect(await registerFor('mallory', backend)).toEqual([])
    expect(calls).toEqual([])
    const base: IngressInput = { prompt: 'hi', userId: 'mallory', username: 'Mallory', mode: 'opencode' }
    expect(applyPersonToIngress(base)).toEqual(base)
  })

  test('a configured server without a stored token for that person is skipped', async () => {
    const { backend, calls } = fakeBackend()
    // wp:2 only has a token for extrachill in the previous tests; use a fresh key.
    const names = await registerPersonMcpServers({
      backend,
      directory: '/proj',
      dataDir,
      personKey: 'wp:no-token',
      servers: [{ name: 'extrachill', url: MCP_URL, credential: 'extrachill' }],
    })
    expect(names).toEqual([])
    expect(calls).toEqual([])
  })

  test('a backend without MCP support registers nothing', async () => {
    const names = await registerPersonMcpServers({
      backend: {} as AgentBackend,
      directory: '/proj',
      dataDir,
      personKey: 'wp:1',
      servers: [{ name: 'extrachill', url: MCP_URL, credential: 'extrachill' }],
    })
    expect(names).toEqual([])
  })
})
