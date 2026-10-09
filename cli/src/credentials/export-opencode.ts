// Export a credential pool's OAuth accounts back to OpenCode's own auth files
// (`roadie credentials export-opencode`). This is the rollback direction of
// `import-opencode`: refresh tokens rotate on every use, so a pre-migration
// copy of OpenCode's auth.json goes stale once the pool has refreshed —
// exporting writes the pool's newest tokens back.
//
// Written files (the command's explicit target, nothing else):
//   <opencode-data>/auth.json                        the first pool account per
//                                                    provider becomes the
//                                                    provider's entry; other
//                                                    providers' entries are
//                                                    preserved untouched
//   <opencode-data>/<provider>-oauth-accounts.json   every pool oauth account
//                                                    for the provider, as the
//                                                    array Kimaki's rotation
//                                                    files used
//
// Only oauth subscription accounts are exported: API keys stay pool-managed
// (OpenCode would keep using them from auth.json, defeating the pool). Output
// is counts and labels — email/accountId labels or the last 4 characters of
// the refresh token; tokens and keys are never printed.

import fs from 'node:fs'
import path from 'node:path'
import {
  CREDENTIALS_DIR_MODE,
  CREDENTIALS_FILE_MODE,
  readPoolAccounts,
  SHARED_POOL_ID,
  type OAuthPoolAccount,
} from './store.js'
import { defaultOpencodeDataDir, resolveOpencodeDataDir } from './import-opencode.js'

export { defaultOpencodeDataDir, resolveOpencodeDataDir }

/** Auth entry shape OpenCode keeps in auth.json / rotation files. */
export type OpencodeOauthEntry = {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
}

function toOpencodeEntry(account: OAuthPoolAccount): OpencodeOauthEntry {
  return { type: 'oauth', refresh: account.refresh, access: account.access, expires: account.expires }
}

/** Output label: the pool account's label when present, otherwise `…last4`. */
export function oauthAccountDisplay(account: OAuthPoolAccount): string {
  if (account.label?.trim()) return account.label.trim()
  return `…${account.refresh.slice(-4)}`
}

function atomicWriteFileSync({ filePath, data }: { filePath: string; data: string }): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: CREDENTIALS_DIR_MODE })
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.export.tmp`)
  fs.writeFileSync(tempPath, data, { mode: CREDENTIALS_FILE_MODE })
  fs.renameSync(tempPath, filePath)
}

export type OpencodeExportProvider = {
  provider: string
  /** Accounts written to the rotation file, in pool order. */
  count: number
  /** Display label of the account written into auth.json (the first one). */
  first: string
}

export type OpencodeExportResult = {
  dir: string
  poolId: string
  providers: OpencodeExportProvider[]
  /** Files written (auth.json plus one rotation file per provider). */
  written: string[]
}

/**
 * Write the pool's OAuth accounts back to OpenCode's auth.json (first account
 * per provider) and the `<provider>-oauth-accounts.json` rotation files.
 * A pool with no oauth accounts writes nothing and reports an empty provider
 * list. API-key accounts are never exported.
 */
export async function exportOpencodeCredentials({
  dataDir,
  poolId = SHARED_POOL_ID,
  opencodeData,
}: {
  dataDir: string
  poolId?: string
  opencodeData?: string
}): Promise<OpencodeExportResult | Error> {
  const dir = resolveOpencodeDataDir({ opencodeData })
  if (dir instanceof Error) return dir
  const accounts = readPoolAccounts({ dataDir, poolId })
  if (accounts instanceof Error) return accounts

  const byProvider = new Map<string, OAuthPoolAccount[]>()
  for (const account of accounts) {
    if (account.type !== 'oauth') continue
    const existing = byProvider.get(account.provider) ?? []
    existing.push(account)
    byProvider.set(account.provider, existing)
  }

  const written: string[] = []
  const providers: OpencodeExportProvider[] = []

  if (byProvider.size > 0) {
    // auth.json: overwrite only the exported providers' entries; unrelated
    // providers (api keys opencode manages itself, other logins) survive.
    const authPath = path.join(dir, 'auth.json')
    let auth: Record<string, unknown> = {}
    if (fs.existsSync(authPath)) {
      const text = fs.readFileSync(authPath, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return new Error(`Malformed ${authPath}: expected a JSON object`)
      }
      auth = parsed as Record<string, unknown>
    }
    for (const [provider, providerAccounts] of byProvider) {
      auth[provider] = toOpencodeEntry(providerAccounts[0]!)
    }
    atomicWriteFileSync({ filePath: authPath, data: `${JSON.stringify(auth, null, 2)}\n` })
    written.push(authPath)

    for (const [provider, providerAccounts] of byProvider) {
      const rotationPath = path.join(dir, `${provider}-oauth-accounts.json`)
      atomicWriteFileSync({
        filePath: rotationPath,
        data: `${JSON.stringify(providerAccounts.map(toOpencodeEntry), null, 2)}\n`,
      })
      written.push(rotationPath)
      providers.push({
        provider,
        count: providerAccounts.length,
        first: oauthAccountDisplay(providerAccounts[0]!),
      })
    }
  }

  return { dir, poolId, providers, written }
}

/**
 * Printable report lines. Counts and labels only; tokens and keys never reach
 * the output.
 */
export function formatOpencodeExportReport(result: OpencodeExportResult): string[] {
  if (result.providers.length === 0) {
    return [`Pool ${result.poolId} has no oauth accounts to export to ${result.dir}`]
  }
  const lines = [`Exporting pool ${result.poolId} oauth accounts to ${result.dir}:`]
  for (const provider of result.providers) {
    lines.push(`  ${provider.provider}: ${provider.count} account${provider.count === 1 ? '' : 's'} (auth.json entry: ${provider.first})`)
  }
  return lines
}
