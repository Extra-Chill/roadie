// Identity hook: contract, caching, fail-closed behavior, permission gates and
// per-person ingress overrides.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import {
  clearIdentityCache,
  getCachedPerson,
  isIdentityHookConfigured,
  personHas,
  resolvePerson,
  setIdentityHookCommand,
} from './identity.js'
import {
  hasRoadieAdminPermission,
  hasRoadieBotPermission,
  hasRoadieShellPermission,
} from './discord-utils.js'
import {
  applyPersonToIngress,
  type IngressInput,
} from './session-handler/thread-session-runtime.js'

let dir: string
const writeHook = (name: string, body: string) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

// A hook that reads the actor from stdin and answers per user id, counting
// invocations in a file so caching can be asserted.
let mappingHook: string
let countFile: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-identity-'))
  countFile = path.join(dir, 'count')
  fs.writeFileSync(countFile, '')
  mappingHook = writeHook(
    'map.sh',
    `input=$(cat)
echo x >> ${countFile}
case "$input" in
  *'"id":"owner"'*) echo '{"allowed":true,"person_id":"wp:1","capabilities":["sessions","shell","admin"]}' ;;
  *'"id":"team"'*) echo '{"allowed":true,"person_id":"host:38","capabilities":["sessions"],"agent":"team-bot","model":"anthropic/claude-sonnet-5-5","permissions":["bash:deny"]}' ;;
  *) echo '{"allowed":false}' ;;
esac`,
  )
})

afterEach(() => {
  setIdentityHookCommand(undefined)
  fs.writeFileSync(countFile, '')
})

const invocations = () => fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length

// Minimal API-shaped guild member; no roles, no admin bits.
const member = (id: string) =>
  ({
    user: { id },
    roles: [],
    permissions: '0',
  }) as unknown as Parameters<typeof hasRoadieBotPermission>[0]

describe('identity hook', () => {
  test('no hook configured: resolvePerson returns null', async () => {
    setIdentityHookCommand(null)
    expect(isIdentityHookConfigured()).toBe(false)
    expect(await resolvePerson({ actor: { platform: 'discord', id: 'owner' } })).toBeNull()
  })

  test('maps actors to people with capabilities and overrides', async () => {
    setIdentityHookCommand(mappingHook)
    const owner = await resolvePerson({ actor: { platform: 'discord', id: 'owner' } })
    const team = await resolvePerson({ actor: { platform: 'discord', id: 'team', name: 'Team Member' } })
    const stranger = await resolvePerson({ actor: { platform: 'discord', id: 'nobody' } })

    expect(owner && personHas(owner, 'shell')).toBe(true)
    expect(owner && personHas(owner, 'admin')).toBe(true)
    expect(team).toMatchObject({
      allowed: true,
      personId: 'host:38',
      agent: 'team-bot',
      model: 'anthropic/claude-sonnet-5-5',
      permissions: ['bash:deny'],
    })
    expect(team && personHas(team, 'sessions')).toBe(true)
    expect(team && personHas(team, 'shell')).toBe(false)
    expect(stranger?.allowed).toBe(false)
    expect(stranger && personHas(stranger, 'sessions')).toBe(false)
  })

  test('caches per actor and dedupes concurrent lookups', async () => {
    setIdentityHookCommand(mappingHook)
    const actor = { platform: 'discord', id: 'team' }
    await Promise.all([resolvePerson({ actor }), resolvePerson({ actor }), resolvePerson({ actor })])
    await resolvePerson({ actor })
    expect(invocations()).toBe(1)
    clearIdentityCache(actor)
    await resolvePerson({ actor })
    expect(invocations()).toBe(2)
  })

  test('ttl_seconds 0 disables caching', async () => {
    setIdentityHookCommand(writeHook('nocache.sh', `cat >/dev/null; echo x >> ${countFile}; echo '{"allowed":true,"ttl_seconds":0}'`))
    const actor = { platform: 'discord', id: 'a' }
    await resolvePerson({ actor })
    await resolvePerson({ actor })
    expect(invocations()).toBe(2)
    expect(getCachedPerson(actor)).toBeUndefined()
  })

  test('allowed without capabilities defaults to sessions only', async () => {
    setIdentityHookCommand(writeHook('default.sh', `cat >/dev/null; echo '{"allowed":true}'`))
    const person = await resolvePerson({ actor: { platform: 'discord', id: 'b' } })
    expect(person && [...person.capabilities]).toEqual(['sessions'])
  })

  test.each([
    ['non-zero exit', 'cat >/dev/null; exit 3'],
    ['invalid JSON', 'cat >/dev/null; echo not-json'],
    ['schema mismatch', `cat >/dev/null; echo '{"allowed":"yes"}'`],
  ])('fails closed on %s', async (_label, body) => {
    setIdentityHookCommand(writeHook(`bad-${_label.replace(/\W/g, '')}.sh`, body))
    const person = await resolvePerson({ actor: { platform: 'discord', id: 'c' } })
    expect(person?.allowed).toBe(false)
  })

  test('sends the versioned contract on stdin', async () => {
    const out = path.join(dir, 'stdin.json')
    setIdentityHookCommand(writeHook('echo.sh', `cat > ${out}; echo '{"allowed":false}'`))
    await resolvePerson({
      actor: { platform: 'discord', id: 'd', name: 'Dee' },
      context: { guildId: 'g1', channelId: 'c1' },
    })
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({
      version: 1,
      actor: { platform: 'discord', id: 'd', name: 'Dee' },
      context: { guild_id: 'g1', channel_id: 'c1' },
    })
  })
})

describe('permission gates with a hook', () => {
  test('hook replaces role checks; shell and admin are separate capabilities', async () => {
    setIdentityHookCommand(mappingHook)
    await resolvePerson({ actor: { platform: 'discord', id: 'owner' } })
    await resolvePerson({ actor: { platform: 'discord', id: 'team' } })
    await resolvePerson({ actor: { platform: 'discord', id: 'nobody' } })

    // Members have no Discord roles or admin bits: only the hook can allow.
    expect(hasRoadieBotPermission(member('owner'))).toBe(true)
    expect(hasRoadieShellPermission(member('owner'))).toBe(true)
    expect(hasRoadieAdminPermission(member('owner'))).toBe(true)

    expect(hasRoadieBotPermission(member('team'))).toBe(true)
    expect(hasRoadieShellPermission(member('team'))).toBe(false)
    expect(hasRoadieAdminPermission(member('team'))).toBe(false)

    expect(hasRoadieBotPermission(member('nobody'))).toBe(false)
  })

  test('an actor that was never resolved is denied (fail closed)', () => {
    setIdentityHookCommand(mappingHook)
    expect(hasRoadieBotPermission(member('owner'))).toBe(false)
  })

  test('without a hook, shell follows bot permission as before', () => {
    setIdentityHookCommand(null)
    expect(hasRoadieShellPermission(member('nobody'))).toBe(
      hasRoadieBotPermission(member('nobody')),
    )
  })
})

describe('applyPersonToIngress', () => {
  const base: IngressInput = {
    prompt: 'hi',
    userId: 'team',
    username: 'Team Member',
    mode: 'opencode',
  }

  test('adds person id, agent, model and permission rules for chat speakers', async () => {
    setIdentityHookCommand(mappingHook)
    await resolvePerson({ actor: { platform: 'discord', id: 'team' } })
    expect(applyPersonToIngress({ ...base, permissions: ['edit:deny'] })).toMatchObject({
      personId: 'host:38',
      agent: 'team-bot',
      model: 'anthropic/claude-sonnet-5-5',
      permissions: ['edit:deny', 'bash:deny'],
    })
  })

  test('explicit agent and model win', async () => {
    setIdentityHookCommand(mappingHook)
    await resolvePerson({ actor: { platform: 'discord', id: 'team' } })
    const out = applyPersonToIngress({ ...base, agent: 'plan', model: 'x/y' })
    expect(out.agent).toBe('plan')
    expect(out.model).toBe('x/y')
  })

  test('CLI-asserted actors and hookless installs are untouched', async () => {
    setIdentityHookCommand(mappingHook)
    await resolvePerson({ actor: { platform: 'discord', id: 'team' } })
    expect(applyPersonToIngress({ ...base, actorVia: 'cli' })).toEqual({ ...base, actorVia: 'cli' })
    setIdentityHookCommand(null)
    expect(applyPersonToIngress(base)).toEqual(base)
  })
})
