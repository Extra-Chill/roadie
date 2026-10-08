// Credential pools phase 2b: the /credentials target-pool contract.
//
// resolveCredentialsTargetPool decides which pool a /credentials invocation
// touches (own pool vs shared, admin-gated), and resolvePersonBillingPool is
// the one helper routing and the command share, so they can never disagree.
// hasCredentialPoolAdminPermission is the shared-pool admin gate. Pure checks
// plus real identity-hook scripts; no Discord client, no real credentials.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { Guild } from 'discord.js'
import { resolveCredentialsTargetPool } from '../commands/credentials.js'
import { resolvePersonBillingPool, resolveTurnBilling } from './person-pool.js'
import { hasRoadieAdminPermission, hasCredentialPoolAdminPermission } from '../discord-utils.js'
import { resolvePerson, setIdentityHookCommand } from '../identity.js'

let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-target-'))
})

afterEach(() => {
  setIdentityHookCommand(null)
})

const writeHook = (name: string, body: string) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

// Minimal API-shaped guild member: no roles, no admin bits by default.
const member = (id: string, permissions = '0') =>
  ({
    user: { id },
    roles: [],
    permissions,
  }) as unknown as Parameters<typeof hasCredentialPoolAdminPermission>[0]

const ownBilling = { personKey: 'discord:42', poolId: 'discord:42' }

describe('resolveCredentialsTargetPool', () => {
  test('per-person modes default to the caller own pool', () => {
    expect(
      resolveCredentialsTargetPool({
        requestShared: false,
        isAdmin: false,
        billing: ownBilling,
        mode: 'per-person',
      }),
    ).toEqual({ poolId: 'discord:42', shared: false })
    expect(
      resolveCredentialsTargetPool({
        requestShared: false,
        isAdmin: false,
        billing: ownBilling,
        mode: 'per-person-fallback',
      }),
    ).toEqual({ poolId: 'discord:42', shared: false })
  })

  test('the identity hook credential_pool override wins, exactly like routing', () => {
    expect(
      resolveCredentialsTargetPool({
        requestShared: false,
        isAdmin: false,
        billing: { personKey: 'wp:1', poolId: 'team-pool' },
        mode: 'per-person',
      }),
    ).toEqual({ poolId: 'team-pool', shared: false })
  })

  test('pool:shared as admin writes the shared pool', () => {
    expect(
      resolveCredentialsTargetPool({
        requestShared: true,
        isAdmin: true,
        billing: ownBilling,
        mode: 'per-person',
      }),
    ).toEqual({ poolId: 'shared', shared: true })
  })

  test('pool:shared is refused for a non-admin', () => {
    expect(
      resolveCredentialsTargetPool({
        requestShared: true,
        isAdmin: false,
        billing: ownBilling,
        mode: 'per-person',
      }),
    ).toBeInstanceOf(Error)
  })

  test('global mode targets shared and needs admin, even without the option', () => {
    expect(
      resolveCredentialsTargetPool({
        requestShared: false,
        isAdmin: true,
        billing: ownBilling,
        mode: 'global',
      }),
    ).toEqual({ poolId: 'shared', shared: true })
    expect(
      resolveCredentialsTargetPool({
        requestShared: false,
        isAdmin: false,
        billing: ownBilling,
        mode: 'global',
      }),
    ).toBeInstanceOf(Error)
  })

  test('a non-admin can never target any pool except their own', () => {
    for (const mode of ['global', 'per-person', 'per-person-fallback'] as const) {
      const target = resolveCredentialsTargetPool({
        requestShared: false,
        isAdmin: false,
        billing: ownBilling,
        mode,
      })
      if (mode === 'global') {
        expect(target).toBeInstanceOf(Error)
      } else {
        expect(target).toEqual({ poolId: 'discord:42', shared: false })
      }
    }
  })
})

describe('resolvePersonBillingPool matches routing', () => {
  test('identical inputs resolve identically through the helper and resolveTurnBilling', () => {
    const cases = [
      { personId: 'wp:1', credentialPool: 'team', platform: 'discord', actorId: '42' },
      { personId: 'wp:1', credentialPool: undefined, platform: 'slack', actorId: 'U1' },
      { personId: 'wp:1', credentialPool: 'Not Valid!', platform: 'discord', actorId: '42' },
      { personId: null, credentialPool: null, platform: 'discord', actorId: '42' },
      { personId: undefined, credentialPool: undefined, platform: 'discord', actorId: '42' },
    ]
    for (const c of cases) {
      expect(
        resolvePersonBillingPool({
          person: { personId: c.personId, credentialPool: c.credentialPool },
          platform: c.platform,
          actorId: c.actorId,
        }),
      ).toEqual(
        resolveTurnBilling({
          personId: c.personId,
          platform: c.platform,
          actorId: c.actorId,
          credentialPoolOverride: c.credentialPool,
        }),
      )
    }
  })

  test('no actor means no pool', () => {
    expect(resolvePersonBillingPool({ person: null, platform: 'discord', actorId: null })).toBeUndefined()
    expect(resolvePersonBillingPool({})).toBeUndefined()
  })
})

describe('hasCredentialPoolAdminPermission', () => {
  test('the identity hook admin capability decides when a hook is configured', async () => {
    setIdentityHookCommand(
      writeHook(
        'pool-admin.sh',
        `input=$(cat)
case "$input" in
  *'"id":"pool-admin"'*) echo '{"allowed":true,"person_id":"wp:1","capabilities":["sessions","admin"]}' ;;
  *'"id":"pool-peon"'*) echo '{"allowed":true,"person_id":"wp:2","capabilities":["sessions"]}' ;;
esac`,
      ),
    )
    await resolvePerson({ actor: { platform: 'discord', id: 'pool-admin' } })
    await resolvePerson({ actor: { platform: 'discord', id: 'pool-peon' } })
    expect(hasCredentialPoolAdminPermission(member('pool-admin'))).toBe(true)
    expect(hasCredentialPoolAdminPermission(member('pool-peon'))).toBe(false)
  })

  test('an actor the hook never resolved is denied (fail closed)', () => {
    setIdentityHookCommand(
      writeHook('anything.sh', `input=$(cat)
case "$input" in
  *'"id":"someone"'*) echo '{"allowed":true}' ;;
esac`),
    )
    expect(hasCredentialPoolAdminPermission(member('ghost'))).toBe(false)
  })

  test('without a hook: Discord Administrator, Manage Server, or the guild owner', () => {
    setIdentityHookCommand(null)
    expect(hasCredentialPoolAdminPermission(member('a', '8'))).toBe(true)
    expect(hasCredentialPoolAdminPermission(member('b', '32'))).toBe(true)
    expect(hasCredentialPoolAdminPermission(member('c', '0'))).toBe(false)
    expect(
      hasCredentialPoolAdminPermission(member('owner-1'), {
        ownerId: 'owner-1',
      } as unknown as Guild),
    ).toBe(true)
  })

  test('the Roadie role is not enough, unlike hasRoadieAdminPermission', () => {
    setIdentityHookCommand(null)
    const roadieRoleMember = {
      user: { id: 'r1' },
      roles: ['role-1'],
      permissions: '0',
    } as unknown as Parameters<typeof hasCredentialPoolAdminPermission>[0]
    const guildWithRoadieRole = {
      ownerId: 'someone-else',
      roles: { cache: { get: (_id: string) => ({ name: 'Roadie' }) } },
    } as unknown as Guild
    expect(hasRoadieAdminPermission(roadieRoleMember, guildWithRoadieRole)).toBe(true)
    expect(hasCredentialPoolAdminPermission(roadieRoleMember, guildWithRoadieRole)).toBe(false)
  })
})
