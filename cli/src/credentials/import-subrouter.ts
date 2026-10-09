// Import subrouter accounts and presets into the shared credential pool
// (`roadie credentials import-subrouter`).
//
// Strictly read-only on subrouter files: auth.json and config.json are opened
// for reading only — never written, moved or deleted. Everything is validated
// and planned before the first pool write, so a malformed subrouter file
// reports the parse error and writes nothing.
//
// Mapping (issue #128, extended by issue #136): anthropic oauth accounts go in
// via addPoolOAuthAccount, and api-key accounts for any provider the models.dev
// catalog resolves (cli/src/credentials/provider-catalog.ts) go in via
// addPoolAccount — only unsupported oauth providers and unresolvable providers
// are skipped, with a per-entry reason. Presets become same-named rotations via
// setPoolRotation with `#variant` suffixes stripped and unroutable entries
// dropped; an existing rotation with the same name is never overwritten. Runs
// are idempotent: dedupe compares inside the pool lock (api keys by key, oauth
// accounts by refresh token or accountId/email) and an existing match is
// reported as already present.
//
// Output is counts and labels only: email or accountId when present,
// otherwise the last 4 characters of the secret. Keys and tokens are never
// printed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as errore from 'errore'
import {
  addPoolAccount,
  addPoolOAuthAccount,
  DuplicatePoolAccountError,
  readPoolAccounts,
  readPoolRotations,
  setPoolRotation,
  ROTATION_NAME_PATTERN,
  SHARED_POOL_ID,
  type PoolAccount,
} from './store.js'
import { parseRotationEntry } from './router.js'
import { isCatalogProviderRoutable, resolveCatalog, type ModelsDevCatalog } from './provider-catalog.js'

/**
 * Fallback when the models.dev catalog cannot be loaded (offline, no cache):
 * keep the pre-#136 pair so an import never regresses for anthropic/openai.
 */
const LEGACY_IMPORT_PROVIDERS: readonly string[] = ['anthropic', 'openai']

/**
 * True when an api-key account for the provider can be routed: the models.dev
 * catalog resolves it (a bundled SDK or an `api` base URL), or — only when the
 * catalog itself is unavailable — it is one of the pre-#136 supported pair.
 */
export function isImportRoutableProvider(provider: string, catalog: ModelsDevCatalog | null): boolean {
  if (catalog) return isCatalogProviderRoutable(catalog, provider)
  return LEGACY_IMPORT_PROVIDERS.includes(provider)
}

// --- Resolving the subrouter home ---

/**
 * `--subrouter-home <dir>` wins, then $SUBROUTER_HOME, then ~/.subrouter.
 * Under vitest the real ~/.subrouter is refused so tests can only ever read a
 * temp SUBROUTER_HOME fixture.
 */
export function resolveSubrouterHome({ subrouterHome }: { subrouterHome?: string }): string | Error {
  const home = subrouterHome?.trim() || process.env.SUBROUTER_HOME || path.join(os.homedir(), '.subrouter')
  if (process.env.VITEST && path.resolve(home) === path.resolve(path.join(os.homedir(), '.subrouter'))) {
    return new Error(
      'Refusing to read the real ~/.subrouter in tests. Point SUBROUTER_HOME (or --subrouter-home) at a temp fixture.',
    )
  }
  return home
}

// --- Reading and validating subrouter files ---

export type SubrouterProviderEntry = {
  provider: string
  activeIndex: number
  accounts: unknown[]
}

export type SubrouterFiles = {
  home: string
  authPath: string
  configPath: string | null
  providers: SubrouterProviderEntry[]
  presets: Record<string, unknown[]>
}

function jsonParseError({ filePath, text }: { filePath: string; text: string }): Error | null {
  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause: unknown) =>
      new Error(`Failed to parse ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  if (parsed instanceof Error) return parsed
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Error(`Malformed ${filePath}: expected a JSON object`)
  }
  return null
}

/**
 * Read auth.json and config.json from the subrouter home without writing
 * anything. File-level problems (missing home/auth.json, unparseable JSON,
 * `providers`/`presets` of the wrong type) are errors; malformed entries
 * inside otherwise-valid files are skipped later, per entry, by the planner.
 * config.json is optional: a missing file just means no presets to import.
 */
export function readSubrouterFiles({ home }: { home: string }): SubrouterFiles | Error {
  if (!fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
    return new Error(`No subrouter home found at ${home}`)
  }
  const authPath = path.join(home, 'auth.json')
  if (!fs.existsSync(authPath)) {
    return new Error(`No auth.json found in ${home}. Is subrouter set up there?`)
  }
  const authText = fs.readFileSync(authPath, 'utf8')
  const authError = jsonParseError({ filePath: authPath, text: authText })
  if (authError) return authError
  const auth = JSON.parse(authText) as Record<string, unknown>
  const rawProviders = auth.providers
  if (!rawProviders || typeof rawProviders !== 'object' || Array.isArray(rawProviders)) {
    return new Error(`Malformed ${authPath}: expected a "providers" object`)
  }
  const providers: SubrouterProviderEntry[] = []
  for (const [provider, entry] of Object.entries(rawProviders as Record<string, unknown>)) {
    // Container-level malformed entries (not an object, accounts not an
    // array) are skipped per provider; account-level ones per account.
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (!Array.isArray(record.accounts)) continue
    const rawIndex = typeof record.activeIndex === 'number' && Number.isFinite(record.activeIndex)
      ? Math.floor(record.activeIndex)
      : 0
    providers.push({ provider, activeIndex: rawIndex, accounts: record.accounts })
  }

  let configPath: string | null = null
  const presets: Record<string, unknown[]> = {}
  const configPathCandidate = path.join(home, 'config.json')
  if (fs.existsSync(configPathCandidate)) {
    configPath = configPathCandidate
    const configText = fs.readFileSync(configPath, 'utf8')
    const configError = jsonParseError({ filePath: configPath, text: configText })
    if (configError) return configError
    const config = JSON.parse(configText) as Record<string, unknown>
    if (config.presets !== undefined) {
      if (!config.presets || typeof config.presets !== 'object' || Array.isArray(config.presets)) {
        return new Error(`Malformed ${configPath}: expected "presets" to be an object`)
      }
      for (const [name, entries] of Object.entries(config.presets as Record<string, unknown>)) {
        if (Array.isArray(entries)) presets[name] = entries
      }
    }
  }

  return { home, authPath, configPath, providers, presets }
}

/**
 * Rotation order from subrouter: the account at `activeIndex` is tried first,
 * wrapping around (same normalization subrouter applies: index modulo length).
 */
export function orderAccountsByActiveIndex(accounts: unknown[], activeIndex: number): unknown[] {
  const count = accounts.length
  if (count === 0) return []
  const start = ((Math.floor(activeIndex) % count) + count) % count
  return [...accounts.slice(start), ...accounts.slice(0, start)]
}

// --- Planning (pure; no writes) ---

export type SubrouterAccountCandidate =
  | {
      kind: 'api'
      provider: string
      key: string
      email?: string
      accountId?: string
      display: string
    }
  | {
      kind: 'oauth'
      provider: string
      refresh: string
      access: string
      expires: number
      email?: string
      accountId?: string
      display: string
    }

export type SubrouterAccountPlanEntry =
  | { action: 'import'; candidate: SubrouterAccountCandidate }
  | { action: 'skip'; provider: string; display: string; reason: string }

export type SubrouterRotationPlanEntry =
  | {
      action: 'set'
      name: string
      entries: string[]
      strippedVariants: number
      droppedUnroutable: string[]
      droppedMalformed: number
    }
  | { action: 'skip'; name: string; reason: string }

export type SubrouterImportPlan = {
  accounts: SubrouterAccountPlanEntry[]
  rotations: SubrouterRotationPlanEntry[]
}

/** Output label: email or accountId when present, otherwise `…last4`. */
function accountDisplay(entry: Record<string, unknown>): string {
  if (typeof entry.email === 'string' && entry.email.trim()) return entry.email.trim()
  if (typeof entry.accountId === 'string' && entry.accountId.trim()) return entry.accountId.trim()
  const secret =
    typeof entry.key === 'string' && entry.key
      ? entry.key
      : typeof entry.refresh === 'string' && entry.refresh
        ? entry.refresh
        : ''
  return secret ? `…${secret.slice(-4)}` : '(no credentials)'
}

function oauthLabel(entry: { email?: string; accountId?: string }): string | undefined {
  if (entry.email?.trim()) return entry.email.trim()
  if (entry.accountId?.trim()) return entry.accountId.trim()
  return undefined
}

/** Trimmed email/accountId when the entry carries them (used for dedupe). */
function identityFields(record: Record<string, unknown>): { email?: string; accountId?: string } {
  return {
    ...(typeof record.email === 'string' && record.email.trim() && { email: record.email.trim() }),
    ...(typeof record.accountId === 'string' && record.accountId.trim() && { accountId: record.accountId.trim() }),
  }
}

/**
 * Map one ordered subrouter account entry onto the pool. Api-key accounts for
 * any catalog-resolvable provider and anthropic oauth accounts import;
 * everything else is skipped with a per-entry reason. Malformed entries
 * (missing key/tokens) are skipped too, with the entry's own reason, and
 * never block the rest of the import.
 */
export function planSubrouterAccount(
  entry: unknown,
  provider: string,
  catalog: ModelsDevCatalog | null,
): SubrouterAccountPlanEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { action: 'skip', provider, display: '(no credentials)', reason: 'malformed account entry' }
  }
  const record = entry as Record<string, unknown>
  const display = accountDisplay(record)
  const identity = identityFields(record)
  if (!isImportRoutableProvider(provider, catalog)) {
    return { action: 'skip', provider, display, reason: `no pool adapter for ${provider}` }
  }
  const type = record.type
  if (type === 'api') {
    const key = record.key
    if (typeof key !== 'string' || key.length === 0) {
      return { action: 'skip', provider, display, reason: 'malformed account entry' }
    }
    return {
      action: 'import',
      candidate: { kind: 'api', provider, key, ...identity, display },
    }
  }
  if (type === 'oauth') {
    if (provider !== 'anthropic') {
      return { action: 'skip', provider, display, reason: `no pool adapter for ${provider} oauth` }
    }
    const refresh = record.refresh
    const access = record.access
    const expires = record.expires
    if (
      typeof refresh !== 'string' ||
      refresh.length === 0 ||
      typeof access !== 'string' ||
      access.length === 0
    ) {
      return { action: 'skip', provider, display, reason: 'malformed account entry' }
    }
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) {
      return { action: 'skip', provider, display, reason: 'malformed account entry' }
    }
    return {
      action: 'import',
      candidate: { kind: 'oauth', provider, refresh, access, expires, ...identity, display },
    }
  }
  const typeLabel = typeof type === 'string' && type ? type : 'account'
  return { action: 'skip', provider, display, reason: `no pool adapter for ${provider} ${typeLabel}` }
}

/**
 * Map one preset onto a rotation. `#variant` suffixes are stripped (counted,
 * logged once per preset), entries whose provider the catalog cannot resolve
 * are dropped, and a preset with nothing left — or a name that cannot be a
 * rotation name — is skipped with a reason.
 */
export function planSubrouterPreset({
  name,
  entries,
  existingRotations,
  catalog,
}: {
  name: string
  entries: unknown[]
  existingRotations: Record<string, string[]>
  catalog: ModelsDevCatalog | null
}): SubrouterRotationPlanEntry {
  if (!ROTATION_NAME_PATTERN.test(name)) {
    return {
      action: 'skip',
      name,
      reason: `invalid rotation name (use letters, digits, dots, dashes or underscores)`,
    }
  }
  const kept: string[] = []
  const unroutable = new Set<string>()
  let strippedVariants = 0
  let droppedMalformed = 0
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) {
      droppedMalformed += 1
      continue
    }
    const withoutVariant = entry.includes('#') ? entry.slice(0, entry.indexOf('#')) : entry
    if (withoutVariant !== entry) strippedVariants += 1
    const parsed = parseRotationEntry(withoutVariant)
    if (!parsed) {
      droppedMalformed += 1
      continue
    }
    if (!isImportRoutableProvider(parsed.provider, catalog)) {
      unroutable.add(parsed.provider)
      continue
    }
    kept.push(withoutVariant)
  }
  if (kept.length === 0) {
    return { action: 'skip', name, reason: 'no routable entries' }
  }
  if (existingRotations[name]) {
    return { action: 'skip', name, reason: 'rotation already exists' }
  }
  return {
    action: 'set',
    name,
    entries: kept,
    strippedVariants,
    droppedUnroutable: [...unroutable].sort(),
    droppedMalformed,
  }
}

/**
 * Dedupe match against current pool accounts: api keys by key, oauth accounts
 * by refresh token or by accountId/email (compared against the account label
 * the import and `credentials login` write). Same provider only for oauth.
 */
export function findExistingPoolAccount({
  accounts,
  candidate,
}: {
  accounts: PoolAccount[]
  candidate: SubrouterAccountCandidate
}): PoolAccount | null {
  if (candidate.kind === 'api') {
    return accounts.find((existing) => existing.type === 'api' && existing.key === candidate.key) ?? null
  }
  const email = candidate.email?.toLowerCase()
  return (
    accounts.find((existing) => {
      if (existing.provider !== candidate.provider) return false
      if (existing.type === 'oauth' && existing.refresh === candidate.refresh) return true
      if (!existing.label) return false
      if (candidate.accountId && existing.label === candidate.accountId) return true
      if (email && existing.label.trim().toLowerCase() === email) return true
      return false
    }) ?? null
  )
}

export function planSubrouterImport({
  files,
  existingAccounts,
  existingRotations,
  catalog,
}: {
  files: SubrouterFiles
  existingAccounts: PoolAccount[]
  existingRotations: Record<string, string[]>
  catalog: ModelsDevCatalog | null
}): SubrouterImportPlan {
  const accounts: SubrouterAccountPlanEntry[] = []
  for (const { provider, activeIndex, accounts: entries } of files.providers) {
    for (const entry of orderAccountsByActiveIndex(entries, activeIndex)) {
      accounts.push(planSubrouterAccount(entry, provider, catalog))
    }
  }
  const rotations: SubrouterRotationPlanEntry[] = []
  for (const [name, entries] of Object.entries(files.presets)) {
    rotations.push(planSubrouterPreset({ name, entries, existingRotations, catalog }))
  }
  return { accounts, rotations }
}

// --- Applying the plan ---

export type SubrouterAccountReport =
  | { action: 'imported'; provider: string; display: string }
  | { action: 'already-present'; provider: string; display: string }
  | { action: 'skipped'; provider: string; display: string; reason: string }
  | { action: 'failed'; provider: string; display: string; reason: string }

export type SubrouterRotationReport =
  | {
      action: 'set'
      name: string
      entries: string[]
      strippedVariants: number
      droppedUnroutable: string[]
      droppedMalformed: number
    }
  | { action: 'skipped'; name: string; reason: string }
  | { action: 'failed'; name: string; reason: string }

export type SubrouterImportResult = {
  home: string
  poolId: string
  dryRun: boolean
  accounts: { imported: number; alreadyPresent: number; skipped: number; failed: number; entries: SubrouterAccountReport[] }
  rotations: { set: number; skipped: number; failed: number; entries: SubrouterRotationReport[] }
}

/**
 * Apply one planned account entry to the pool. Shared by the subrouter import
 * and the OpenCode auth import: dedupe runs in the same pool-lock critical
 * section as the write, and a dry run previews against the pool snapshot plus
 * anything earlier in the same plan without writing.
 */
export async function applyAccountPlanEntry({
  dataDir,
  poolId,
  entry,
  dryRun,
  pendingImports,
}: {
  dataDir: string
  poolId: string
  entry: SubrouterAccountPlanEntry
  dryRun: boolean
  pendingImports: PoolAccount[]
}): Promise<SubrouterAccountReport> {
  if (entry.action === 'skip') {
    return { action: 'skipped', provider: entry.provider, display: entry.display, reason: entry.reason }
  }
  const candidate = entry.candidate
  if (dryRun) {
    // Preview against the pool snapshot plus anything earlier in this plan,
    // so a twice-listed account reports as already present in the dry run too.
    const existing = findExistingPoolAccount({ accounts: [...pendingImports], candidate })
    if (existing) {
      return { action: 'already-present', provider: candidate.provider, display: candidate.display }
    }
    if (candidate.kind === 'api') {
      pendingImports.push({
        id: 'pending',
        provider: candidate.provider,
        type: 'api',
        key: candidate.key,
        addedAt: '',
        lastUsed: null,
      })
    } else {
      pendingImports.push({
        id: 'pending',
        provider: candidate.provider,
        type: 'oauth',
        refresh: candidate.refresh,
        access: candidate.access,
        expires: candidate.expires,
        addedAt: '',
        lastUsed: null,
      })
    }
    return { action: 'imported', provider: candidate.provider, display: candidate.display }
  }
  // Dedupe in the same pool-lock critical section as the write, so two
  // concurrent imports cannot both add the same account.
  const isDuplicate = (account: PoolAccount) =>
    findExistingPoolAccount({ accounts: [account], candidate }) !== null
  if (candidate.kind === 'api') {
    const added = await addPoolAccount({
      dataDir,
      poolId,
      provider: candidate.provider,
      key: candidate.key,
      isDuplicate,
    })
    if (added instanceof DuplicatePoolAccountError) {
      return { action: 'already-present', provider: candidate.provider, display: candidate.display }
    }
    if (added instanceof Error) {
      return { action: 'failed', provider: candidate.provider, display: candidate.display, reason: added.message }
    }
    return { action: 'imported', provider: candidate.provider, display: candidate.display }
  }
  const label = oauthLabel(candidate)
  const added = await addPoolOAuthAccount({
    dataDir,
    poolId,
    provider: candidate.provider,
    refresh: candidate.refresh,
    access: candidate.access,
    expires: candidate.expires,
    ...(label && { label }),
    isDuplicate,
  })
  if (added instanceof DuplicatePoolAccountError) {
    return { action: 'already-present', provider: candidate.provider, display: candidate.display }
  }
  if (added instanceof Error) {
    return { action: 'failed', provider: candidate.provider, display: candidate.display, reason: added.message }
  }
  return { action: 'imported', provider: candidate.provider, display: candidate.display }
}

async function applyRotationPlanEntry({
  dataDir,
  poolId,
  entry,
  dryRun,
}: {
  dataDir: string
  poolId: string
  entry: SubrouterRotationPlanEntry
  dryRun: boolean
}): Promise<SubrouterRotationReport> {
  if (entry.action === 'skip') {
    return { action: 'skipped', name: entry.name, reason: entry.reason }
  }
  if (!dryRun) {
    // The existence check runs inside setPoolRotation's lock, so a rotation
    // created since the plan is never overwritten.
    const set = await setPoolRotation({
      dataDir,
      poolId,
      name: entry.name,
      entries: entry.entries,
      onlyIfAbsent: true,
    })
    if (set === 'exists') {
      return { action: 'skipped', name: entry.name, reason: 'rotation already exists' }
    }
    if (set instanceof Error) {
      return { action: 'failed', name: entry.name, reason: set.message }
    }
  }
  return {
    action: 'set',
    name: entry.name,
    entries: entry.entries,
    strippedVariants: entry.strippedVariants,
    droppedUnroutable: entry.droppedUnroutable,
    droppedMalformed: entry.droppedMalformed,
  }
}

/**
 * Import subrouter accounts and presets into a credential pool. Read-only on
 * the subrouter files; `dryRun` also skips every pool write. Providers are
 * resolved through the models.dev catalog; when the catalog cannot be loaded
 * the import falls back to the pre-#136 anthropic/openai pair so it never
 * regresses for those.
 */
export async function importSubrouterCredentials({
  dataDir,
  poolId = SHARED_POOL_ID,
  subrouterHome,
  dryRun = false,
}: {
  dataDir: string
  poolId?: string
  subrouterHome?: string
  dryRun?: boolean
}): Promise<SubrouterImportResult | Error> {
  const home = resolveSubrouterHome({ subrouterHome })
  if (home instanceof Error) return home
  const files = readSubrouterFiles({ home })
  if (files instanceof Error) return files
  const existingAccounts = readPoolAccounts({ dataDir, poolId })
  if (existingAccounts instanceof Error) return existingAccounts
  const existingRotations = readPoolRotations({ dataDir, poolId })
  if (existingRotations instanceof Error) return existingRotations

  const catalog = await resolveCatalog({ dataDir })
  const routableCatalog: ModelsDevCatalog | null = catalog instanceof Error ? null : catalog

  const plan = planSubrouterImport({ files, existingAccounts, existingRotations, catalog: routableCatalog })

  const accountEntries: SubrouterAccountReport[] = []
  // Dry runs preview against the pool as it is now plus earlier plan entries.
  const pendingImports: PoolAccount[] = [...existingAccounts]
  for (const entry of plan.accounts) {
    accountEntries.push(await applyAccountPlanEntry({ dataDir, poolId, entry, dryRun, pendingImports }))
  }
  const rotationEntries: SubrouterRotationReport[] = []
  for (const entry of plan.rotations) {
    rotationEntries.push(await applyRotationPlanEntry({ dataDir, poolId, entry, dryRun }))
  }

  const countAccounts = (action: SubrouterAccountReport['action']) =>
    accountEntries.filter((entry) => entry.action === action).length
  const countRotations = (action: SubrouterRotationReport['action']) =>
    rotationEntries.filter((entry) => entry.action === action).length

  return {
    home,
    poolId,
    dryRun,
    accounts: {
      imported: countAccounts('imported'),
      alreadyPresent: countAccounts('already-present'),
      skipped: countAccounts('skipped'),
      failed: countAccounts('failed'),
      entries: accountEntries,
    },
    rotations: {
      set: countRotations('set'),
      skipped: countRotations('skipped'),
      failed: countRotations('failed'),
      entries: rotationEntries,
    },
  }
}

// --- Report (counts and labels only; never keys or tokens) ---

/**
 * Printable report lines. Built exclusively from non-secret fields
 * (providers, labels, `…last4` displays, reasons), so keys and tokens can
 * never reach the output.
 */
export function formatSubrouterImportReport(result: SubrouterImportResult): string[] {
  const lines: string[] = []
  lines.push(
    `Importing subrouter credentials from ${result.home} into pool ${result.poolId}${result.dryRun ? ' (dry run, nothing written)' : ''}`,
  )
  const a = result.accounts
  lines.push(`accounts: ${a.imported} imported, ${a.alreadyPresent} already present, ${a.skipped} skipped${a.failed ? `, ${a.failed} failed` : ''}`)
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
  const r = result.rotations
  lines.push(`rotations: ${r.set} set, ${r.skipped} skipped${r.failed ? `, ${r.failed} failed` : ''}`)
  for (const entry of r.entries) {
    if (entry.action === 'set') {
      lines.push(`  set ${entry.name}: ${entry.entries.join(' ')}`)
      if (entry.strippedVariants > 0) {
        lines.push(`    stripped #variant suffix from ${entry.strippedVariants} ${entry.strippedVariants === 1 ? 'entry' : 'entries'}`)
      }
      const dropped = entry.droppedUnroutable.length + entry.droppedMalformed
      if (dropped > 0) {
        const parts = [
          entry.droppedUnroutable.length ? `no pool adapter for ${entry.droppedUnroutable.join(', ')}` : '',
          entry.droppedMalformed ? `${entry.droppedMalformed} malformed` : '',
        ].filter(Boolean)
        lines.push(`    dropped ${dropped} ${dropped === 1 ? 'entry' : 'entries'} (${parts.join('; ')})`)
      }
    } else if (entry.action === 'skipped') {
      lines.push(`  skipped ${entry.name}: ${entry.reason}`)
    } else {
      lines.push(`  failed ${entry.name}: ${entry.reason}`)
    }
  }
  return lines
}
