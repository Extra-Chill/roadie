// Session route store tests: turn-affinity persistence in
// <dataDir>/credentials/routes.json. No real keys and no network.

import { test, expect, describe, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ROUTES_TTL_MS, clearSessionRoute, readSessionRoute, setSessionRoute } from './routes.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-routes-'))
})

const NOW = 1_000_000

const ROUTE = {
  poolId: 'alice',
  accountId: 'acc_1',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4',
  rotation: 'default',
}

function routeAt(pinnedAt: number) {
  return { ...ROUTE, pinnedAt }
}

function routesPath(): string {
  return path.join(dataDir, 'credentials', 'routes.json')
}

describe('session routes', () => {
  test('a missing file reads as no route', () => {
    expect(readSessionRoute({ dataDir, sessionId: 'ses_1', now: NOW })).toBeNull()
  })

  test('set + read round-trip, other sessions untouched', async () => {
    const set = await setSessionRoute({ dataDir, sessionId: 'ses_1', route: routeAt(NOW), now: NOW })
    expect(set).toBe(true)
    expect(readSessionRoute({ dataDir, sessionId: 'ses_1', now: NOW })).toEqual(routeAt(NOW))
    expect(readSessionRoute({ dataDir, sessionId: 'ses_2', now: NOW })).toBeNull()
    await setSessionRoute({ dataDir, sessionId: 'ses_2', route: routeAt(NOW), now: NOW })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_1', now: NOW })).toEqual(routeAt(NOW))
    expect(readSessionRoute({ dataDir, sessionId: 'ses_2', now: NOW })).toEqual(routeAt(NOW))
  })

  test('routes expire at the TTL and are pruned on the next write', async () => {
    await setSessionRoute({ dataDir, sessionId: 'ses_old', route: routeAt(NOW), now: NOW })
    // Just inside the TTL the route still applies.
    expect(readSessionRoute({ dataDir, sessionId: 'ses_old', now: NOW + ROUTES_TTL_MS - 1 })).toEqual(routeAt(NOW))
    // At the TTL boundary it is expired (the safety net for a missed idle).
    expect(readSessionRoute({ dataDir, sessionId: 'ses_old', now: NOW + ROUTES_TTL_MS })).toBeNull()
    // The next write prunes the expired entry.
    const later = NOW + ROUTES_TTL_MS
    await setSessionRoute({ dataDir, sessionId: 'ses_new', route: routeAt(later), now: later })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_new', now: later })).toEqual(routeAt(later))
    const file = JSON.parse(fs.readFileSync(routesPath(), 'utf8')) as { routes: Record<string, unknown> }
    expect(Object.keys(file.routes)).toEqual(['ses_new'])
  })

  test('re-pinning overwrites the route', async () => {
    await setSessionRoute({ dataDir, sessionId: 'ses_1', route: routeAt(NOW), now: NOW })
    const moved = { ...ROUTE, accountId: 'acc_2', pinnedAt: NOW + 5 }
    await setSessionRoute({ dataDir, sessionId: 'ses_1', route: moved, now: NOW + 5 })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_1', now: NOW + 5 })).toEqual(moved)
  })

  test('clear drops the route; clearing a missing route is a no-op', async () => {
    await setSessionRoute({ dataDir, sessionId: 'ses_1', route: routeAt(NOW), now: NOW })
    expect(await clearSessionRoute({ dataDir, sessionId: 'ses_1' })).toBe(true)
    expect(readSessionRoute({ dataDir, sessionId: 'ses_1', now: NOW })).toBeNull()
    expect(await clearSessionRoute({ dataDir, sessionId: 'ses_missing' })).toBe(true)
    expect(fs.existsSync(routesPath())).toBe(true)
  })

  test('clear removes only the cleared session', async () => {
    await setSessionRoute({ dataDir, sessionId: 'ses_1', route: routeAt(NOW), now: NOW })
    await setSessionRoute({ dataDir, sessionId: 'ses_2', route: routeAt(NOW), now: NOW })
    await clearSessionRoute({ dataDir, sessionId: 'ses_1' })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_1', now: NOW })).toBeNull()
    expect(readSessionRoute({ dataDir, sessionId: 'ses_2', now: NOW })).toEqual(routeAt(NOW))
  })

  test('the routes file is created with mode 0600 under <dataDir>/credentials', async () => {
    await setSessionRoute({ dataDir, sessionId: 'ses_1', route: routeAt(NOW), now: NOW })
    const stat = fs.statSync(routesPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test('a corrupt file reads as empty and the next write recovers', async () => {
    fs.mkdirSync(path.join(dataDir, 'credentials'), { recursive: true })
    fs.writeFileSync(routesPath(), '{not json')
    expect(readSessionRoute({ dataDir, sessionId: 'ses_1', now: NOW })).toBeNull()
    await setSessionRoute({ dataDir, sessionId: 'ses_1', route: routeAt(NOW), now: NOW })
    expect(readSessionRoute({ dataDir, sessionId: 'ses_1', now: NOW })).toEqual(routeAt(NOW))
  })

  test('malformed entries are dropped on read', async () => {
    fs.mkdirSync(path.join(dataDir, 'credentials'), { recursive: true })
    fs.writeFileSync(
      routesPath(),
      JSON.stringify({ routes: { ses_bad: { poolId: 'alice' }, ses_ok: routeAt(NOW) } }),
    )
    expect(readSessionRoute({ dataDir, sessionId: 'ses_bad', now: NOW })).toBeNull()
    expect(readSessionRoute({ dataDir, sessionId: 'ses_ok', now: NOW })).toEqual(routeAt(NOW))
  })
})
