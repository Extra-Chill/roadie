// Identity hook: contract, caching, fail-closed behavior, permission gates and
// per-person ingress overrides.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import {
  clearIdentityCache,
  getCachedPerson,
  isIdentityHookConfigured,
  personHas,
  resolvePerson,
  setIdentityHookCommand,
  type Person,
} from './identity.js'
import { addFilter } from './hooks.js'
import {
  hasRoadieAdminPermission,
  hasRoadieBotPermission,
  hasRoadieShellPermission,
} from './discord-utils.js'
import {
  applyPersonToIngress,
  type IngressInput,
} from './session-handler/ingress-input.js'

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
  test('speaker MCP lookup uses the context-resolved cached person', async () => {
    const actor = { platform: 'discord', id: 'space-member' }
    const invocations: Array<{ guildId?: string }> = []
    const removeFilter = addFilter('person', (_person, { context }) => {
      invocations.push(context)
      return context.guildId
        ? { allowed: true, capabilities: new Set(['sessions'] as const), permissions: [] }
        : { allowed: false, capabilities: new Set<never>(), permissions: [] }
    })
    try {
      const resolved = await resolvePerson({ actor, context: { guildId: 'guild-1', channelId: 'channel-1' } })
      expect(resolved?.allowed).toBe(true)

      // registerSpeakerMcpServers performs this cached-only lookup.
      expect(getCachedPerson(actor)?.allowed).toBe(true)
      expect(invocations).toEqual([{ guildId: 'guild-1', channelId: 'channel-1' }])
    } finally {
      removeFilter()
      clearIdentityCache(actor)
    }
  })

  test('a throwing person filter is a short-lived lookup failure, not a cached denial', async () => {
    const actor = { platform: 'discord', id: 'flaky-lookup' }
    let fail = true
    const removeFilter = addFilter('person', () => {
      if (fail) throw new Error('WordPress context lookup failed')
      return { allowed: true, capabilities: new Set(['sessions'] as const), permissions: [] }
    })
    try {
      const failed = await resolvePerson({ actor, context: { guildId: 'guild-1' } })
      expect(failed?.allowed).toBe(false)
      expect(failed?.lookupFailed).toBe(true)

      // Expire the short failure entry; the next lookup must run again and
      // admit the person instead of replaying a cached denial.
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11_000)
      try {
        fail = false
        const recovered = await resolvePerson({ actor, context: { guildId: 'guild-1' } })
        expect(recovered?.allowed).toBe(true)
        expect(recovered?.lookupFailed).toBeUndefined()
      } finally {
        clock.mockRestore()
      }
    } finally {
      removeFilter()
      clearIdentityCache(actor)
    }
  })

  test('dropping one actor discards an in-flight lookup so it cannot cache a stale answer', async () => {
    const actor = { platform: 'discord', id: 'relinked' }
    const other = { platform: 'discord', id: 'unrelated' }
    let allowed = false
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const removeFilter = addFilter('person', async (_value, { actor: who }) => {
      const answer = allowed
      if (who.id === actor.id && !answer) {
        entered()
        await gate
      }
      return { allowed: answer, capabilities: new Set(answer ? (['sessions'] as const) : []), permissions: [] }
    })
    try {
      expect((await resolvePerson({ actor: other }))?.allowed).toBe(false)
      const stale = resolvePerson({ actor })
      await inside
      // The host links the actor while the old lookup is still running.
      allowed = true
      clearIdentityCache(actor)
      const fresh = await resolvePerson({ actor })
      expect(fresh?.allowed).toBe(true)
      release()
      expect((await stale)?.allowed).toBe(false)
      // The stale answer did not overwrite the fresh one.
      expect(getCachedPerson(actor)?.allowed).toBe(true)
      // Other actors keep their cache entry.
      expect(getCachedPerson(other)?.allowed).toBe(false)
    } finally {
      removeFilter()
      clearIdentityCache(actor)
      clearIdentityCache(other)
    }
  })

  test('a failed lookup falls back to the last successful lookup', async () => {
    const actor = { platform: 'discord', id: 'known-then-flaky' }
    let fail = false
    const removeFilter = addFilter('person', () => {
      if (fail) throw new Error('WordPress context lookup failed')
      return { allowed: true, personId: 'wp:1', capabilities: new Set(['sessions'] as const), permissions: [] }
    })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      expect((await resolvePerson({ actor, context: { guildId: 'guild-1' } }))?.allowed).toBe(true)

      // The fresh entry expires; the refresh fails, the verified person stands.
      fail = true
      clock.mockReturnValue(now + 301_000)
      const stale = await resolvePerson({ actor, context: { guildId: 'guild-1' } })
      expect(stale?.allowed).toBe(true)
      expect(stale?.personId).toBe('wp:1')

      // Past the stale window, a failure is a lookup failure again.
      clock.mockReturnValue(now + 3_700_000)
      const failed = await resolvePerson({ actor, context: { guildId: 'guild-1' } })
      expect(failed?.allowed).toBe(false)
      expect(failed?.lookupFailed).toBe(true)
    } finally {
      clock.mockRestore()
      removeFilter()
      clearIdentityCache(actor)
    }
  })

  describe('stale-while-revalidate', () => {
    const allowed = (personId: string): Person => ({ allowed: true, personId, capabilities: new Set(['sessions'] as const), permissions: [] })
    const denied: Person = { allowed: false, capabilities: new Set(), permissions: [] }

    // A `person` filter whose answer the test sets and whose lookups block
    // until released.
    function gatedFilter(initial: Person) {
      const state = { answer: initial, gated: false, started: 0, release: () => {} }
      const removeFilter = addFilter('person', async () => {
        state.started++
        if (state.gated) await new Promise<void>((resolve) => { state.release = resolve })
        return state.answer
      })
      return { state, removeFilter }
    }

    const isPending = async (promise: Promise<unknown>) => {
      // Give the call a few microtasks to settle; a gated lookup never does.
      let settled = false
      void promise.then(() => { settled = true })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      return !settled
    }

    let clock: MockInstance<() => number>
    let now: number
    beforeEach(() => {
      now = Date.now()
      clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    })
    afterEach(() => clock.mockRestore())
    const expire = () => clock.mockReturnValue(now + 301_000)

    test('an expired, allowed actor is answered at once and the refresh replaces it', async () => {
      const actor = { platform: 'discord', id: 'swr-allowed' }
      const { state, removeFilter } = gatedFilter(allowed('wp:1'))
      try {
        expect((await resolvePerson({ actor }))?.personId).toBe('wp:1')

        expire()
        state.gated = true
        state.answer = allowed('wp:2')
        const stale = resolvePerson({ actor })
        expect(await isPending(stale)).toBe(false)
        expect((await stale)?.personId).toBe('wp:1')
        expect(getCachedPerson(actor)?.personId).toBe('wp:1')
        expect(state.started).toBe(2)

        state.release()
        await vi.waitFor(() => expect(getCachedPerson(actor)?.personId).toBe('wp:2'))
        expect((await resolvePerson({ actor }))?.personId).toBe('wp:2')
      } finally {
        state.release()
        removeFilter()
        clearIdentityCache(actor)
      }
    })

    test('a refresh that denies the person applies from the next call', async () => {
      const actor = { platform: 'discord', id: 'swr-revoked' }
      const { state, removeFilter } = gatedFilter(allowed('wp:1'))
      try {
        await resolvePerson({ actor })
        expire()
        state.gated = true
        state.answer = denied
        const stale = resolvePerson({ actor })
        expect(await isPending(stale)).toBe(false)
        expect((await stale)?.allowed).toBe(true)
        state.release()
        await vi.waitFor(() => expect(getCachedPerson(actor)?.allowed).toBe(false))
        expect((await resolvePerson({ actor }))?.allowed).toBe(false)
      } finally {
        state.release()
        removeFilter()
        clearIdentityCache(actor)
      }
    })

    test('concurrent stale hits share one refresh', async () => {
      const actor = { platform: 'discord', id: 'swr-concurrent' }
      const { state, removeFilter } = gatedFilter(allowed('wp:1'))
      try {
        await resolvePerson({ actor })
        expire()
        state.gated = true
        const stale = Promise.all([resolvePerson({ actor }), resolvePerson({ actor }), resolvePerson({ actor })])
        expect(await isPending(stale)).toBe(false)
        const people = await stale
        expect(people.map((person) => person?.personId)).toEqual(['wp:1', 'wp:1', 'wp:1'])
        // The seeded entry outlives its failure TTL while the refresh still runs.
        clock.mockReturnValue(now + 312_000)
        expect((await resolvePerson({ actor }))?.personId).toBe('wp:1')
        expect(state.started).toBe(2)
      } finally {
        state.release()
        removeFilter()
        clearIdentityCache(actor)
      }
    })

    test('a never-resolved actor waits for the lookup', async () => {
      const actor = { platform: 'discord', id: 'swr-new' }
      const { state, removeFilter } = gatedFilter(allowed('wp:1'))
      try {
        state.gated = true
        const person = resolvePerson({ actor })
        expect(await isPending(person)).toBe(true)
        state.release()
        expect((await person)?.personId).toBe('wp:1')
      } finally {
        state.release()
        removeFilter()
        clearIdentityCache(actor)
      }
    })

    test('an expired denial waits, so a new grant applies at once', async () => {
      const actor = { platform: 'discord', id: 'swr-denied' }
      const { state, removeFilter } = gatedFilter(denied)
      try {
        expect((await resolvePerson({ actor }))?.allowed).toBe(false)
        expire()
        state.gated = true
        state.answer = allowed('wp:1')
        const person = resolvePerson({ actor })
        expect(await isPending(person)).toBe(true)
        state.release()
        expect((await person)?.allowed).toBe(true)
      } finally {
        state.release()
        removeFilter()
        clearIdentityCache(actor)
      }
    })

    test('a cleared actor waits for the lookup', async () => {
      const actor = { platform: 'discord', id: 'swr-cleared' }
      const { state, removeFilter } = gatedFilter(allowed('wp:1'))
      try {
        await resolvePerson({ actor })
        clearIdentityCache(actor)
        state.gated = true
        state.answer = allowed('wp:2')
        const person = resolvePerson({ actor })
        expect(await isPending(person)).toBe(true)
        state.release()
        expect((await person)?.personId).toBe('wp:2')
      } finally {
        state.release()
        removeFilter()
        clearIdentityCache(actor)
      }
    })

    test('a hook with ttl_seconds 0 always waits for the lookup', async () => {
      setIdentityHookCommand(writeHook('swr-nocache.sh', `cat >/dev/null; echo '{"allowed":true,"person_id":"wp:1","ttl_seconds":0}'`))
      const actor = { platform: 'discord', id: 'swr-uncached' }
      // The filter keeps the hook's ttl_seconds 0 and gates the lookup.
      const { state, removeFilter } = gatedFilter(allowed('wp:1'))
      try {
        expect((await resolvePerson({ actor }))?.personId).toBe('wp:1')
        state.gated = true
        const person = resolvePerson({ actor })
        await vi.waitFor(() => expect(state.started).toBe(2))
        expect(await isPending(person)).toBe(true)
        state.release()
        expect((await person)?.personId).toBe('wp:1')
      } finally {
        state.release()
        removeFilter()
        clearIdentityCache(actor)
      }
    })
  })

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

  test('credential_pool: a valid override lands on the person, legacy output is untouched', async () => {
    setIdentityHookCommand(
      writeHook(
        'pool.sh',
        `input=$(cat)
case "$input" in
  *'"id":"pooled"'*) echo '{"allowed":true,"person_id":"wp:9","credential_pool":"team-pool"}' ;;
  *'"id":"badpool"'*) echo '{"allowed":true,"person_id":"wp:9","credential_pool":"Not A Pool!"}' ;;
  *) echo '{"allowed":true,"person_id":"wp:9"}' ;;
esac`,
      ),
    )
    const pooled = await resolvePerson({ actor: { platform: 'discord', id: 'pooled' } })
    expect(pooled?.credentialPool).toBe('team-pool')
    // An invalid pool id is ignored: the person resolves as if it were absent.
    const bad = await resolvePerson({ actor: { platform: 'discord', id: 'badpool' } })
    expect(bad?.allowed).toBe(true)
    expect(bad?.credentialPool).toBeUndefined()
    // Hooks that do not send the field behave as before.
    const legacy = await resolvePerson({ actor: { platform: 'discord', id: 'plain' } })
    expect(legacy?.allowed).toBe(true)
    expect(legacy?.credentialPool).toBeUndefined()
  })

  test('applyPersonToIngress carries the credential pool override', async () => {
    const poolHook = writeHook(
      'pool-team.sh',
      `input=$(cat)
case "$input" in
  *'"id":"team"'*) echo '{"allowed":true,"person_id":"host:38","credential_pool":"team-pool"}' ;;
  *) echo '{"allowed":false}' ;;
esac`,
    )
    setIdentityHookCommand(poolHook)
    await resolvePerson({ actor: { platform: 'discord', id: 'team' } })
    expect(
      applyPersonToIngress({ prompt: 'hi', userId: 'team', username: 'Team Member', mode: 'direct' }),
    ).toMatchObject({ personId: 'host:38', credentialPool: 'team-pool' })
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
    mode: 'direct',
  }

  test('adds person id, agent, model and permission rules for chat speakers', async () => {
    setIdentityHookCommand(mappingHook)
    await resolvePerson({ actor: { platform: 'discord', id: 'team' } })
    expect(applyPersonToIngress({ ...base, permissions: ['edit:deny'] })).toMatchObject({
      personId: 'host:38',
      agent: 'team-bot',
      model: 'anthropic/claude-sonnet-5-5',
      permissions: ['edit:deny', 'roadie_pm_*:deny', 'bash:deny'],
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
