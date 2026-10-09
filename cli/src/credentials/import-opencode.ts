// Import OpenCode-managed credentials into a credential pool
// (`roadie credentials import-opencode`).
//
// Source files (read-only, never written, moved or deleted):
//   <opencode-data>/auth.json                      Record<provider, entry>
//   <opencode-data>/<provider>-oauth-accounts.json  the per-provider OAuth
//      rotation files Kimaki kept (an array of entries, or an object keyed by
//      account id/email with entry values)
//
// Entries speak OpenCode's auth shapes: an OAuth subscription
// { type: 'oauth', refresh, access, expires, accountId? } or an API key
// { type: 'api', key }. They are planned with the same rules as the subrouter
// import (cli/src/credentials/import-subrouter.ts): api-key accounts for any
// provider the models.dev catalog resolves, anthropic OAuth only — everything
// else is skipped with a per-entry reason. Everything is validated before the
// first pool write, dedupe runs under the pool lock, and the report carries
// counts and labels only: email or accountId when present, otherwise the last
// 4 characters of the secret. Keys and tokens are never printed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyAccountPlanEntry,
  planSubrouterAccount,
  type SubrouterAccountPlanEntry,
  type SubrouterAccountReport,
} from './import-subrouter.js'
import { resolveCatalog, type ModelsDevCatalog } from './provider-catalog.js'
import { readPoolAccounts, SHARED_POOL_ID, type PoolAccount } from './store.js'

/** Opencode's own data dir, refused as a test source so tests never read the real one. */
export function defaultOpencodeDataDir(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
  return path.join(dataHome, 'opencode')
}

/**
 * `--opencode-data <dir>` is required. Under vitest the real OpenCode data
 * home is refused so tests can only ever read a temp fixture.
 */
export function resolveOpencodeDataDir({ opencodeData }: { opencodeData?: string }): string | Error {
  const dir = opencodeData?.trim()
  if (!dir) {
    return new Error('Missing --opencode-data <dir>: the OpenCode data directory holding auth.json')
  }
  if (process.env.VITEST && path.resolve(dir) === path.resolve(defaultOpencodeDataDir())) {
    return new Error(
      'Refusing to read the real OpenCode data directory in tests. Point --opencode-data at a temp fixture.',
    )
  }
  return dir
}

export type OpencodeProviderEntry = {
  provider: string
  source: 'auth.json' | 'rotation'
  entries: unknown[]
}

export type OpencodeAuthFiles = {
  dir: string
  authPath: string | null
  rotationPaths: string[]
  providers: OpencodeProviderEntry[]
}

function jsonParseError({ filePath, text, allowArray }: { filePath: string; text: string; allowArray?: boolean }): Error | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || (!allowArray && Array.isArray(parsed))) {
      return new Error(`Malformed ${filePath}: expected a JSON object`)
    }
    return null
  } catch (cause) {
    return new Error(`Failed to parse ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * Read auth.json and every `<provider>-oauth-accounts.json` rotation file from
 * the OpenCode data dir without writing anything. auth.json is optional (a
 * host may only keep rotation files); when present it must be an object keyed
 * by provider with entry objects. Rotation files are an array of entries or an
 * object with entry values. A directory with neither file is an error, as is
 * any unparseable file that does exist — the import then writes nothing.
 */
export function readOpencodeAuthFiles({ dir }: { dir: string }): OpencodeAuthFiles | Error {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return new Error(`No OpenCode data directory found at ${dir}`)
  }
  const providers: OpencodeProviderEntry[] = []

  const authPath = path.join(dir, 'auth.json')
  let authSeen = false
  if (fs.existsSync(authPath)) {
    authSeen = true
    const text = fs.readFileSync(authPath, 'utf8')
    const parseError = jsonParseError({ filePath: authPath, text })
    if (parseError) return parseError
    const auth = JSON.parse(text) as Record<string, unknown>
    for (const [provider, entry] of Object.entries(auth)) {
      // Container-level malformed entries are skipped per provider, like the
      // subrouter reader skips them.
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      providers.push({ provider, source: 'auth.json', entries: [entry] })
    }
  }

  const rotationPaths: string[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    const match = /^(.+)-oauth-accounts\.json$/.exec(name)
    if (!match) continue
    const filePath = path.join(dir, name)
    if (!fs.statSync(filePath).isFile()) continue
    authSeen = true
    rotationPaths.push(filePath)
    const text = fs.readFileSync(filePath, 'utf8')
    // Rotation files may be a JSON array (Kimaki's shape) or an object keyed
    // by account id/email; only auth.json must be an object.
    const parseError = jsonParseError({ filePath, text, allowArray: true })
    if (parseError) return parseError
    const parsed = JSON.parse(text) as unknown
    const entries: unknown[] = []
    if (Array.isArray(parsed)) {
      entries.push(...parsed)
    } else if (parsed && typeof parsed === 'object') {
      entries.push(...Object.values(parsed as Record<string, unknown>))
    }
    const provider = match[1] ?? ''
    if (entries.length > 0) {
      providers.push({ provider, source: 'rotation', entries })
    }
  }

  if (!authSeen) {
    return new Error(
      `No auth.json or <provider>-oauth-accounts.json found in ${dir}. Is OpenCode set up there?`,
    )
  }
  return { dir, authPath: fs.existsSync(authPath) ? authPath : null, rotationPaths, providers }
}

/**
 * Map the read files onto pool account plan entries. auth.json entries use the
 * provider recorded next to them in the file; rotation-file entries use the
 * provider in the file name. Planning is the subrouter import's: routable
 * api-key providers and anthropic oauth import, everything else is skipped
 * with a per-entry reason.
 */
export function planOpencodeImport({
  files,
  catalog,
}: {
  files: OpencodeAuthFiles
  catalog: ModelsDevCatalog | null
}): SubrouterAccountPlanEntry[] {
  const plan: SubrouterAccountPlanEntry[] = []
  for (const { provider, entries } of files.providers) {
    for (const entry of entries) {
      plan.push(planSubrouterAccount(entry, provider, catalog))
    }
  }
  return plan
}

export type OpencodeImportResult = {
  dir: string
  poolId: string
  dryRun: boolean
  accounts: {
    imported: number
    alreadyPresent: number
    skipped: number
    failed: number
    entries: SubrouterAccountReport[]
  }
}

/**
 * Import OpenCode auth.json + rotation-file credentials into a pool.
 * Read-only on the source files; `dryRun` also skips every pool write.
 * Providers are resolved through the models.dev catalog.
 */
export async function importOpencodeCredentials({
  dataDir,
  poolId = SHARED_POOL_ID,
  opencodeData,
  dryRun = false,
}: {
  dataDir: string
  poolId?: string
  opencodeData?: string
  dryRun?: boolean
}): Promise<OpencodeImportResult | Error> {
  const dir = resolveOpencodeDataDir({ opencodeData })
  if (dir instanceof Error) return dir
  const files = readOpencodeAuthFiles({ dir })
  if (files instanceof Error) return files
  const existingAccounts = readPoolAccounts({ dataDir, poolId })
  if (existingAccounts instanceof Error) return existingAccounts

  const catalog = await resolveCatalog({ dataDir })
  const routableCatalog: ModelsDevCatalog | null = catalog instanceof Error ? null : catalog

  const plan = planOpencodeImport({ files, catalog: routableCatalog })

  const entries: SubrouterAccountReport[] = []
  // Dry runs preview against the pool as it is now plus earlier plan entries.
  const pendingImports: PoolAccount[] = [...existingAccounts]
  for (const entry of plan) {
    entries.push(await applyAccountPlanEntry({ dataDir, poolId, entry, dryRun, pendingImports }))
  }
  const count = (action: SubrouterAccountReport['action']) =>
    entries.filter((entry) => entry.action === action).length

  return {
    dir,
    poolId,
    dryRun,
    accounts: {
      imported: count('imported'),
      alreadyPresent: count('already-present'),
      skipped: count('skipped'),
      failed: count('failed'),
      entries,
    },
  }
}

/**
 * Printable report lines. Built exclusively from non-secret fields
 * (providers, labels, `…last4` displays, reasons), so keys and tokens can
 * never reach the output.
 */
export function formatOpencodeImportReport(result: OpencodeImportResult): string[] {
  const a = result.accounts
  const lines = [
    `Importing OpenCode credentials from ${result.dir} into pool ${result.poolId}${result.dryRun ? ' (dry run, nothing written)' : ''}`,
    `accounts: ${a.imported} imported, ${a.alreadyPresent} already present, ${a.skipped} skipped${a.failed ? `, ${a.failed} failed` : ''}`,
  ]
  for (const entry of a.entries) {
    if (entry.action === 'imported') {
      lines.push(`  imported ${entry.provider} ${entry.display}`)
    } else if (entry.action === 'already-present') {
      lines.push(`  already present ${entry.provider} ${entry.display}`)
    } else if (entry.action === 'skipped') {
      lines.push(`  skipped ${entry.provider} ${entry.display}: ${entry.reason}`)
    } else {
      lines.push(`  failed ${entry.provider} ${entry.display}: ${entry.reason}`)
    }
  }
  return lines
}
