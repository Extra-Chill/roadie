// One-time startup migration from subrouter to credential pools (issue #150,
// phase 4a). Runs at bot startup, after the database opens, when credential
// pools are enabled. Subrouter itself still loads in this release; removal is
// phase 4b.
//
// Two steps, both idempotent:
//
// 1. Accounts: when the shared pool has no accounts and a subrouter home
//    exists ($SUBROUTER_HOME, else ~/.subrouter), run importSubrouterCredentials
//    into the pool. Import is strictly read-only on subrouter files and dedupes
//    under the pool lock, so a second startup re-imports nothing.
// 2. Stored model choices: rewrite `subrouter/<preset>` to `roadie/<preset>` in
//    global_models, channel_models and session_models — but only when the pool
//    has a rotation named <preset> (the import creates rotations under the same
//    names). The variant is cleared on rewritten rows. Every other row is left
//    untouched; unmappable choices (e.g. presets made only of unroutable
//    providers such as github-copilot) keep working while subrouter still loads.
//
// Output is counts and preset names only: keys and tokens are never printed.

import fs from 'node:fs'
import path from 'node:path'
import * as orm from 'drizzle-orm'
import { getDb } from '../db.js'
import * as schema from '../schema.js'
import {
  importSubrouterCredentials,
  resolveSubrouterHome,
  type SubrouterImportResult,
} from './import-subrouter.js'
import { readPoolAccounts, readPoolRotations, SHARED_POOL_ID } from './store.js'

export const SUBROUTER_MODEL_PREFIX = 'subrouter/'
export const ROADIE_MODEL_PREFIX = 'roadie/'

/**
 * Marker written once the shared pool holds subrouter's accounts. From then on
 * the pool is the only store allowed to refresh them: Anthropic (and other
 * OAuth providers) rotate the refresh token on every use, so two stores holding
 * copies of one account invalidate each other (invalid_grant). With the marker
 * Roadie stops loading subrouter and serves `subrouter/<preset>` as an alias of
 * `roadie/<preset>` (see opencode.ts), so a host config that still names a
 * `subrouter/...` model keeps working through the pool.
 */
export const SUBROUTER_HANDOFF_MARKER = 'subrouter-handoff.json'

function handoffMarkerPath(dataDir: string): string {
  return path.join(dataDir, 'credentials', SUBROUTER_HANDOFF_MARKER)
}

export function hasSubrouterHandoff({ dataDir }: { dataDir: string }): boolean {
  return fs.existsSync(handoffMarkerPath(dataDir))
}

function writeSubrouterHandoff({ dataDir, home }: { dataDir: string; home: string }): void {
  const file = handoffMarkerPath(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify({ home, handedOffAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
}

export type SubrouterModelRewrites = {
  globalModels: number
  channelModels: number
  sessionModels: number
  /** Rows left on `subrouter/<preset>` because the pool has no such rotation. */
  unmapped: number
  /** Preset names (sorted, unique) behind the unmapped rows. */
  unmappedPresets: string[]
}

export type SubrouterStartupMigration = {
  poolId: string
  home: string | null
  /**
   * The accounts import, when it ran. Null when skipped: the pool already had
   * accounts (never re-import) or no subrouter home exists.
   */
  import: SubrouterImportResult | null
  /** Why the import did not run, when it was attempted and failed. */
  importError: string | null
  rewrites: SubrouterModelRewrites
  /** The pool now owns subrouter's accounts; subrouter is no longer loaded. */
  handedOff: boolean
}

/**
 * True when the preset behind a `subrouter/<preset>` row can be rewritten:
 * the pool has a rotation with that exact name (imports create rotations
 * under the subrouter preset names).
 */
export function canRewriteSubrouterModel({
  modelId,
  rotations,
}: {
  modelId: string
  rotations: Record<string, string[]>
}): boolean {
  if (!modelId.startsWith(SUBROUTER_MODEL_PREFIX)) return false
  const preset = modelId.slice(SUBROUTER_MODEL_PREFIX.length)
  return Boolean(rotations[preset] && rotations[preset]!.length > 0)
}

/**
 * Rewrite `subrouter/<preset>` rows to `roadie/<preset>` when the pool has a
 * matching rotation, clearing the variant. Pure with respect to the database
 * apart from the updates themselves; returns per-table counts so the caller
 * logs without touching row data.
 */
export async function rewriteSubrouterModelChoices({
  rotations,
}: {
  rotations: Record<string, string[]>
}): Promise<SubrouterModelRewrites | Error> {
  const db = await getDb()
  const rewrites: SubrouterModelRewrites = {
    globalModels: 0,
    channelModels: 0,
    sessionModels: 0,
    unmapped: 0,
    unmappedPresets: [],
  }
  const unmapped = new Set<string>()

  const rewriteRows = async <Row extends { model_id: string }>({
    rows,
    keyOf,
    update,
  }: {
    rows: Row[]
    keyOf: (row: Row) => string
    update: (key: string, preset: string) => Promise<unknown>
  }): Promise<number> => {
    let rewritten = 0
    for (const row of rows) {
      // Only `subrouter/<preset>` rows participate; every other row (other
      // providers, already-migrated roadie rows) is left untouched.
      if (!row.model_id.startsWith(SUBROUTER_MODEL_PREFIX)) continue
      const preset = row.model_id.slice(SUBROUTER_MODEL_PREFIX.length)
      if (canRewriteSubrouterModel({ modelId: row.model_id, rotations })) {
        await update(keyOf(row), preset)
        rewritten += 1
      } else {
        rewrites.unmapped += 1
        unmapped.add(preset)
      }
    }
    return rewritten
  }

  const globalRows = await db.select({
    app_id: schema.global_models.app_id,
    model_id: schema.global_models.model_id,
  }).from(schema.global_models)
  rewrites.globalModels = await rewriteRows({
    rows: globalRows,
    keyOf: (row) => row.app_id,
    update: (appId, preset) =>
      db.update(schema.global_models)
        .set({ model_id: `${ROADIE_MODEL_PREFIX}${preset}`, variant: null })
        .where(orm.eq(schema.global_models.app_id, appId)),
  })

  const channelRows = await db.select({
    channel_id: schema.channel_models.channel_id,
    model_id: schema.channel_models.model_id,
  }).from(schema.channel_models)
  rewrites.channelModels = await rewriteRows({
    rows: channelRows,
    keyOf: (row) => row.channel_id,
    update: (channelId, preset) =>
      db.update(schema.channel_models)
        .set({ model_id: `${ROADIE_MODEL_PREFIX}${preset}`, variant: null })
        .where(orm.eq(schema.channel_models.channel_id, channelId)),
  })

  const sessionRows = await db.select({
    session_id: schema.session_models.session_id,
    model_id: schema.session_models.model_id,
  }).from(schema.session_models)
  rewrites.sessionModels = await rewriteRows({
    rows: sessionRows,
    keyOf: (row) => row.session_id,
    update: (sessionId, preset) =>
      db.update(schema.session_models)
        .set({ model_id: `${ROADIE_MODEL_PREFIX}${preset}`, variant: null })
        .where(orm.eq(schema.session_models.session_id, sessionId)),
  })

  rewrites.unmappedPresets = [...unmapped].sort()
  return rewrites
}

/**
 * Run the one-time subrouter migration for a pool. Never writes subrouter
 * files; failures inside the accounts import are returned on the result (the
 * model-choice rewrite still runs, since a pool can already hold rotations
 * from an earlier manual import).
 */
export async function migrateSubrouterCredentialsAtStartup({
  dataDir,
  poolId = SHARED_POOL_ID,
  subrouterHome,
}: {
  dataDir: string
  poolId?: string
  /** Overrides the $SUBROUTER_HOME / ~/.subrouter resolution (tests). */
  subrouterHome?: string
}): Promise<SubrouterStartupMigration | Error> {
  const home = resolveSubrouterHome({ subrouterHome })
  const homePath = home instanceof Error ? null : home
  const homeExists = homePath !== null && fs.existsSync(homePath) && fs.statSync(homePath).isDirectory()

  const accounts = readPoolAccounts({ dataDir, poolId })
  if (accounts instanceof Error) return accounts

  // Import only into an empty pool: never re-import over accounts the operator
  // (or an earlier startup) already manages. Import itself dedupes, but the
  // empty check keeps later startups from even reading the subrouter files.
  let importResult: SubrouterImportResult | null = null
  let importError: string | null = null
  if (accounts.length === 0 && homeExists && homePath) {
    const imported = await importSubrouterCredentials({
      dataDir,
      poolId,
      subrouterHome: homePath,
    })
    if (imported instanceof Error) {
      importError = imported.message
    } else {
      importResult = imported
      // Hand off only when every importable account is in the pool: a partial
      // import keeps subrouter loaded for the accounts that did not move.
      if (imported.accounts.failed === 0 && imported.accounts.imported + imported.accounts.alreadyPresent > 0) {
        writeSubrouterHandoff({ dataDir, home: homePath })
      }
    }
  }

  const rotations = readPoolRotations({ dataDir, poolId })
  if (rotations instanceof Error) return rotations

  const rewrites = await rewriteSubrouterModelChoices({ rotations })
  if (rewrites instanceof Error) return rewrites

  return {
    poolId,
    home: homeExists ? homePath : null,
    import: importResult,
    importError,
    rewrites,
    handedOff: hasSubrouterHandoff({ dataDir }),
  }
}

/**
 * Printable report lines. Counts and preset names only — account secrets stay
 * in the pool files and are never formatted here.
 */
export function formatSubrouterStartupMigration(result: SubrouterStartupMigration): string[] {
  const lines: string[] = []
  if (result.importError) {
    lines.push(`Subrouter account import failed: ${result.importError}`)
  }
  if (result.import) {
    const a = result.import.accounts
    lines.push(
      `Imported subrouter accounts into pool ${result.poolId}: ${a.imported} imported, ${a.alreadyPresent} already present, ${a.skipped} skipped${a.failed ? `, ${a.failed} failed` : ''}`,
    )
    const r = result.import.rotations
    if (r.set > 0 || r.skipped > 0 || r.failed > 0) {
      lines.push(`Imported subrouter presets as rotations: ${r.set} set, ${r.skipped} skipped${r.failed ? `, ${r.failed} failed` : ''}`)
    }
  }
  const rewrites = result.rewrites
  const total = rewrites.globalModels + rewrites.channelModels + rewrites.sessionModels
  if (total > 0) {
    lines.push(
      `Migrated ${total} stored model choice${total === 1 ? '' : 's'} from subrouter/ to roadie/ (global ${rewrites.globalModels}, channel ${rewrites.channelModels}, session ${rewrites.sessionModels})`,
    )
  }
  if (result.handedOff) {
    lines.push(
      'Credential pools own the subrouter accounts: subrouter is not loaded, and subrouter/<preset> models are served from the pool',
    )
  }
  if (rewrites.unmapped > 0) {
    lines.push(
      `Kept ${rewrites.unmapped} subrouter model choice${rewrites.unmapped === 1 ? '' : 's'} with no matching rotation: ${rewrites.unmappedPresets.join(', ')}`,
    )
  }
  return lines
}
