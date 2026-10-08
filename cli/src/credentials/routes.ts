// Session route store: turn affinity for credential pools.
//
// Maps an opencode session id to the live route (pool, account,
// provider/model) its turn was pinned to. The pool provider
// (credentials/provider.ts) pins the route on every successful dispatch and
// prefers the held candidate on the next request, so tool follow-ups inside
// one turn never split across accounts; the credential pools plugin's event
// hook clears the session's route on session.idle and session.deleted. The
// TTL is the safety net for a missed idle event.
//
// Layout: a single <dataDir>/credentials/routes.json (mode 0600), written via
// temp file + rename so readers in other processes only ever observe complete
// files. One in-process lock (promise chain) serializes read-modify-write
// cycles; this is routes' own lock, not a pool lock, so route writes never
// contend with pool writes.
//
// Like the rest of credentials/, this module is imported by the provider
// module that runs inside the OpenCode server process, so it must stay
// dependency-free: only node builtins (plus the store's file-mode constants),
// and every function takes the data directory explicitly instead of importing
// cli/src/config.ts.

import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'
import { CREDENTIALS_DIR_MODE, CREDENTIALS_FILE_MODE } from './store.js'

/** Routes older than this are ignored (and pruned on the next write). */
export const ROUTES_TTL_MS = 30 * 60 * 1000

export type SessionRoute = {
  /** Pool the session is pinned to. */
  poolId: string
  /** Account in that pool the turn bills to. */
  accountId: string
  /** Rotation entry (`provider/model`) the turn resolves to. */
  provider: string
  modelId: string
  /** Rotation name the route was pinned under (`roadie/<rotation>`). */
  rotation: string
  /** Epoch ms of the last pin; routes older than ROUTES_TTL_MS are ignored. */
  pinnedAt: number
}

type RoutesFile = { routes: Record<string, SessionRoute> }

const EMPTY_ROUTES_FILE: RoutesFile = { routes: {} }

function routesFilePath({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, 'credentials', 'routes.json')
}

// ── Routes lock ──────────────────────────────────────────────────

let routesLock: Promise<unknown> = Promise.resolve()

/**
 * Serialize routes read-modify-write cycles within this process. The chain
 * swallows the previous task's rejection (its own caller already received it)
 * so one failed write never poisons later ones.
 */
async function withRoutesLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const task = routesLock.then(fn, fn)
  routesLock = task.then(
    () => undefined,
    () => undefined,
  )
  return await task
}

// ── File primitives ──────────────────────────────────────────────

let tempWriteCounter = 0

/**
 * Write via temp file + rename so readers in other processes never see a
 * partial file. The temp file is created with the final mode so the bytes are
 * never world-readable, even briefly.
 */
function atomicWriteFileSync({ filePath, data }: { filePath: string; data: string }): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: CREDENTIALS_DIR_MODE })
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${++tempWriteCounter}.tmp`,
  )
  fs.writeFileSync(tempPath, data, { mode: CREDENTIALS_FILE_MODE })
  fs.renameSync(tempPath, filePath)
}

function normalizeRoute(input: unknown): SessionRoute | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (
    typeof record.poolId !== 'string' ||
    typeof record.accountId !== 'string' ||
    typeof record.provider !== 'string' ||
    typeof record.modelId !== 'string' ||
    typeof record.rotation !== 'string' ||
    typeof record.pinnedAt !== 'number'
  ) {
    return null
  }
  return {
    poolId: record.poolId,
    accountId: record.accountId,
    provider: record.provider,
    modelId: record.modelId,
    rotation: record.rotation,
    pinnedAt: record.pinnedAt,
  }
}

function readRoutesFile({ dataDir }: { dataDir: string }): RoutesFile {
  const text = errore.try({
    try: () => fs.readFileSync(routesFilePath({ dataDir }), 'utf8'),
    catch: () => null,
  })
  if (text === null) return EMPTY_ROUTES_FILE
  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => null,
  })
  if (!parsed || typeof parsed !== 'object') return EMPTY_ROUTES_FILE
  const routes: Record<string, SessionRoute> = {}
  const raw = (parsed as { routes?: unknown }).routes
  if (raw && typeof raw === 'object') {
    for (const [sessionId, value] of Object.entries(raw)) {
      const route = normalizeRoute(value)
      if (route) routes[sessionId] = route
    }
  }
  return { routes }
}

function isExpired(route: SessionRoute, now: number): boolean {
  return !(Number.isFinite(route.pinnedAt) && route.pinnedAt + ROUTES_TTL_MS > now)
}

/**
 * The session's live route, or null when there is none or it expired (the TTL
 * safety net for a missed session.idle). Lock-free like the pool reads: the
 * atomic rename means the file is never observed half-written.
 */
export function readSessionRoute({
  dataDir,
  sessionId,
  now,
}: {
  dataDir: string
  sessionId: string
  now: number
}): SessionRoute | null {
  const route = readRoutesFile({ dataDir }).routes[sessionId]
  if (!route || isExpired(route, now)) return null
  return route
}

/**
 * Pin (or re-pin) the session's live route under the routes lock. Expired
 * routes are pruned in the same write, so the file never accumulates stale
 * sessions beyond the TTL.
 */
export async function setSessionRoute({
  dataDir,
  sessionId,
  route,
  now,
}: {
  dataDir: string
  sessionId: string
  route: SessionRoute
  now: number
}): Promise<true | Error> {
  return await withRoutesLock(() => {
    const file = readRoutesFile({ dataDir })
    const routes: Record<string, SessionRoute> = {}
    for (const [id, existing] of Object.entries(file.routes)) {
      if (!isExpired(existing, now)) routes[id] = existing
    }
    routes[sessionId] = route
    try {
      atomicWriteFileSync({
        filePath: routesFilePath({ dataDir }),
        data: JSON.stringify({ routes }, null, 2),
      })
    } catch (cause) {
      return new Error(`Failed to write session route for ${sessionId}`, { cause })
    }
    return true
  })
}

/**
 * Drop the session's live route under the routes lock (the plugin's
 * session.idle / session.deleted handler). A missing route is a no-op.
 */
export async function clearSessionRoute({
  dataDir,
  sessionId,
}: {
  dataDir: string
  sessionId: string
}): Promise<true | Error> {
  return await withRoutesLock(() => {
    const file = readRoutesFile({ dataDir })
    if (!(sessionId in file.routes)) return true
    const { [sessionId]: _cleared, ...routes } = file.routes
    try {
      atomicWriteFileSync({
        filePath: routesFilePath({ dataDir }),
        data: JSON.stringify({ routes }, null, 2),
      })
    } catch (cause) {
      return new Error(`Failed to clear session route for ${sessionId}`, { cause })
    }
    return true
  })
}
