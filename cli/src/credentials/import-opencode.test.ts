// Tests for `roadie credentials import-opencode` and `export-opencode`
// (issue #150): OpenCode auth.json + Kimaki's <provider>-oauth-accounts.json
// rotation files in and out of a pool. Read-only on the source for imports,
// explicit-target-only writes for exports, and never a secret in any report.

import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  defaultOpencodeDataDir,
  formatOpencodeImportReport,
  importOpencodeCredentials,
  readOpencodeAuthFiles,
  resolveOpencodeDataDir,
  type OpencodeImportResult,
} from './import-opencode.js'
import {
  exportOpencodeCredentials,
  formatOpencodeExportReport,
} from './export-opencode.js'
import {
  readPoolAccounts,
  readPoolRotations,
  SHARED_POOL_ID,
  updatePoolAccount,
} from './store.js'
import { resetCatalogCacheForTests } from './provider-catalog.js'

let dataDir: string
let opencodeData: string
let originalXdgCacheHome: string | undefined

// Fixture catalog served through $XDG_CACHE_HOME/opencode/models.json, so the
// import resolves providers without any network. `zai` resolves; the rest of
// the routing rules come from the shared subrouter planner.
const TEST_CATALOG = {
  anthropic: { id: 'anthropic', npm: '@ai-sdk/anthropic' },
  openai: { id: 'openai', npm: '@ai-sdk/openai' },
  zai: { id: 'zai', npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/paas/v4' },
}

const ALL_SECRETS = [
  'ok-rt-secret-1',
  'ok-at-secret-1',
  'ok-rt-secret-2',
  'ok-at-secret-2',
  'ok-rt-secret-3',
  'ok-at-secret-3',
  'zai-live-key-8888',
  'sk-openai-live-0001',
  'rotated-rt',
  'rotated-at',
]

function writeOpencodeFixture({
  auth = true,
  rotations = true,
  authOverrides,
}: {
  auth?: boolean
  rotations?: boolean
  authOverrides?: Record<string, unknown>
} = {}): void {
  if (auth) {
    // Shaped like OpenCode's own auth.json: provider -> entry.
    const authFile = {
      $schema: 'https://opencode.ai/config.json',
      anthropic: {
        type: 'oauth',
        refresh: 'ok-rt-secret-1',
        access: 'ok-at-secret-1',
        expires: 1893456000001,
        accountId: 'acct-777',
      },
      zai: { type: 'api', key: 'zai-live-key-8888' },
      'github-copilot': {
        type: 'oauth',
        refresh: 'gh-rt-secret-1',
        access: 'gh-at-secret-1',
        expires: 1893456000002,
      },
      ...(authOverrides ?? {}),
    }
    fs.writeFileSync(path.join(opencodeData, 'auth.json'), JSON.stringify(authFile, null, 2))
  }
  if (rotations) {
    // Kimaki's per-provider oauth rotation files: an array of the same
    // entries auth.json holds, one per account in the rotation.
    fs.writeFileSync(
      path.join(opencodeData, 'anthropic-oauth-accounts.json'),
      JSON.stringify(
        [
          { type: 'oauth', refresh: 'ok-rt-secret-1', access: 'ok-at-secret-1', expires: 1893456000001, accountId: 'acct-777' },
          { type: 'oauth', refresh: 'ok-rt-secret-2', access: 'ok-at-secret-2', expires: 1893456000002, email: 'bridget@example.com' },
          { type: 'oauth', refresh: 'ok-rt-secret-3', access: 'ok-at-secret-3', expires: 1893456000003 },
        ],
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(opencodeData, 'openai-oauth-accounts.json'),
      JSON.stringify(
        { 'acct-openai': { type: 'oauth', refresh: 'ok-rt-secret-9', access: 'ok-at-secret-9', expires: 1893456000004 } },
        null,
        2,
      ),
    )
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-opencode-import-'))
  opencodeData = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-data-'))
  originalXdgCacheHome = process.env.XDG_CACHE_HOME
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-opencode-cache-'))
  fs.mkdirSync(path.join(cacheHome, 'opencode'), { recursive: true })
  fs.writeFileSync(path.join(cacheHome, 'opencode', 'models.json'), JSON.stringify(TEST_CATALOG))
  process.env.XDG_CACHE_HOME = cacheHome
  resetCatalogCacheForTests()
})

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  resetCatalogCacheForTests()
})

function importResult(result: OpencodeImportResult | Error): OpencodeImportResult {
  expect(result).not.toBeInstanceOf(Error)
  if (result instanceof Error) throw result
  return result
}

function reportText(result: OpencodeImportResult): string {
  return formatOpencodeImportReport(result).join('\n')
}

describe('readOpencodeAuthFiles', () => {
  test('collects auth.json entries per provider and rotation entries by file name', () => {
    writeOpencodeFixture()
    const files = readOpencodeAuthFiles({ dir: opencodeData })
    expect(files).not.toBeInstanceOf(Error)
    if (files instanceof Error) return
    expect(files.authPath).toBe(path.join(opencodeData, 'auth.json'))
    expect(files.rotationPaths).toEqual([
      path.join(opencodeData, 'anthropic-oauth-accounts.json'),
      path.join(opencodeData, 'openai-oauth-accounts.json'),
    ])
    expect(files.providers).toMatchObject([
      { provider: 'anthropic', source: 'auth.json' },
      { provider: 'zai', source: 'auth.json' },
      { provider: 'github-copilot', source: 'auth.json' },
      { provider: 'anthropic', source: 'rotation' },
      { provider: 'openai', source: 'rotation' },
    ])
  })

  test('a missing directory, a dir with no auth files, and unparseable files are errors', () => {
    expect(readOpencodeAuthFiles({ dir: path.join(opencodeData, 'gone') })).toBeInstanceOf(Error)
    expect(readOpencodeAuthFiles({ dir: opencodeData })).toBeInstanceOf(Error)
    fs.writeFileSync(path.join(opencodeData, 'auth.json'), '{ not json')
    expect(readOpencodeAuthFiles({ dir: opencodeData })).toBeInstanceOf(Error)
    fs.writeFileSync(path.join(opencodeData, 'auth.json'), '{}')
    fs.writeFileSync(path.join(opencodeData, 'zai-oauth-accounts.json'), '[]xxx')
    expect(readOpencodeAuthFiles({ dir: opencodeData })).toBeInstanceOf(Error)
  })

  test('auth.json alone or rotation files alone are enough', () => {
    fs.writeFileSync(path.join(opencodeData, 'auth.json'), JSON.stringify({ zai: { type: 'api', key: 'k1' } }))
    const authOnly = readOpencodeAuthFiles({ dir: opencodeData })
    expect(authOnly).not.toBeInstanceOf(Error)
    fs.rmSync(path.join(opencodeData, 'auth.json'))
    fs.writeFileSync(
      path.join(opencodeData, 'zai-oauth-accounts.json'),
      JSON.stringify([{ type: 'oauth', refresh: 'r', access: 'a', expires: 1 }]),
    )
    const rotationsOnly = readOpencodeAuthFiles({ dir: opencodeData })
    expect(rotationsOnly).not.toBeInstanceOf(Error)
    if (rotationsOnly instanceof Error) return
    expect(rotationsOnly.providers).toHaveLength(1)
    expect(rotationsOnly.authPath).toBeNull()
  })
})

describe('resolveOpencodeDataDir', () => {
  test('requires a directory and refuses the real OpenCode data home in tests', () => {
    expect(resolveOpencodeDataDir({})).toBeInstanceOf(Error)
    expect(resolveOpencodeDataDir({ opencodeData: '   ' })).toBeInstanceOf(Error)
    expect(resolveOpencodeDataDir({ opencodeData: opencodeData })).toBe(opencodeData)
    const real = resolveOpencodeDataDir({ opencodeData: defaultOpencodeDataDir() })
    expect(real).toBeInstanceOf(Error)
    if (!(real instanceof Error)) return
    expect(real.message).toContain('tests')
  })
})

describe('importOpencodeCredentials', () => {
  test('imports auth.json and rotation accounts with labels, skipping un-adapted providers', async () => {
    writeOpencodeFixture()
    const result = importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    // auth.json: anthropic oauth + zai api import, github-copilot oauth skips.
    // The rotation file's first entry duplicates the auth.json account (same
    // refresh token) and reports already present; its other two import. The
    // openai rotation entry skips (no oauth adapter for openai).
    expect(result.accounts.imported).toBe(4)
    expect(result.accounts.skipped).toBe(2)
    expect(result.accounts.alreadyPresent).toBe(1)
    expect(
      result.accounts.entries
        .filter((entry) => entry.action === 'imported')
        .map((entry) => (entry.action === 'imported' ? entry.display : '')),
    ).toEqual(['acct-777', '…8888', 'bridget@example.com', '…et-3'])

    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    expect(accounts).not.toBeInstanceOf(Error)
    if (accounts instanceof Error) return
    expect(accounts).toHaveLength(4)
    const oauth = accounts.filter((account) => account.type === 'oauth')
    expect(oauth.map((account) => (account.type === 'oauth' ? account.refresh : ''))).toEqual([
      'ok-rt-secret-1',
      'ok-rt-secret-2',
      'ok-rt-secret-3',
    ])
    expect(oauth.map((account) => account.label)).toEqual([
      'acct-777',
      'bridget@example.com',
      undefined,
    ])
    const api = accounts.filter((account) => account.type === 'api')
    expect(api.map((account) => (account.type === 'api' ? account.key : ''))).toEqual(['zai-live-key-8888'])
  })

  test('a second run imports nothing and reports already present', async () => {
    writeOpencodeFixture()
    importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    const second = importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    expect(second.accounts.imported).toBe(0)
    // Every plan entry is a dedupe match on the second run, including the
    // auth.json/rotation duplicate.
    expect(second.accounts.alreadyPresent).toBe(5)
    expect(second.accounts.skipped).toBe(2)
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) return
    expect(accounts).toHaveLength(4)
  })

  test('skips with per-entry reasons: un-adapted oauth and unknown api providers', async () => {
    writeOpencodeFixture({
      authOverrides: { groq: { type: 'api', key: 'gq-key-1' } },
    })
    const result = importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    const skips = result.accounts.entries
      .filter((entry) => entry.action === 'skipped')
      .map((entry) => ({ provider: entry.provider, reason: entry.action === 'skipped' ? entry.reason : '' }))
    expect(skips).toEqual([
      { provider: 'github-copilot', reason: 'no pool adapter for github-copilot' },
      { provider: 'groq', reason: 'no pool adapter for groq' },
      { provider: 'openai', reason: 'no pool adapter for openai oauth' },
    ])
  })

  test('dry run prints the plan and writes nothing', async () => {
    writeOpencodeFixture()
    const result = importResult(await importOpencodeCredentials({ dataDir, opencodeData, dryRun: true }))
    expect(result.dryRun).toBe(true)
    expect(result.accounts.imported).toBe(4)
    expect(result.accounts.alreadyPresent).toBe(1)
    expect(fs.existsSync(path.join(dataDir, 'credentials'))).toBe(false)
    const text = reportText(result)
    expect(text).toContain('dry run, nothing written')
    expect(text).toContain('imported anthropic acct-777')
  })

  test('source files are byte-identical after a real import', async () => {
    writeOpencodeFixture()
    const authBefore = fs.readFileSync(path.join(opencodeData, 'auth.json'))
    const rotationsBefore = fs.readdirSync(opencodeData).sort()
    importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    expect(fs.readFileSync(path.join(opencodeData, 'auth.json')).equals(authBefore)).toBe(true)
    expect(fs.readdirSync(opencodeData).sort()).toEqual(rotationsBefore)
  })

  test('no token or key appears in the report', async () => {
    writeOpencodeFixture()
    const dry = importResult(await importOpencodeCredentials({ dataDir, opencodeData, dryRun: true }))
    const real = importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    for (const result of [dry, real]) {
      const text = reportText(result)
      for (const secret of ALL_SECRETS) {
        expect(text).not.toContain(secret)
      }
    }
  })

  test('a malformed auth.json reports the parse error and writes nothing', async () => {
    writeOpencodeFixture()
    fs.writeFileSync(path.join(opencodeData, 'auth.json'), '{ not json')
    const result = await importOpencodeCredentials({ dataDir, opencodeData })
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) return
    expect(result.message).toContain('Failed to parse')
    expect(result.message).toContain('auth.json')
    expect(fs.existsSync(path.join(dataDir, 'credentials'))).toBe(false)
  })

  test('a pool id must be valid', async () => {
    writeOpencodeFixture()
    const result = await importOpencodeCredentials({ dataDir, opencodeData, poolId: 'Not A Pool!' })
    expect(result).toBeInstanceOf(Error)
  })
})

describe('exportOpencodeCredentials', () => {
  test('writes the first account per provider to auth.json and all accounts to rotation files', async () => {
    writeOpencodeFixture()
    importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    // Refresh tokens rotate on use; the export must write the newest ones.
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) throw accounts
    const firstOauth = accounts.find((account) => account.type === 'oauth')
    if (firstOauth?.type !== 'oauth') throw new Error('expected an oauth account')
    const updated = await updatePoolAccount({
      dataDir,
      poolId: SHARED_POOL_ID,
      accountId: firstOauth.id,
      refresh: 'rotated-rt',
      access: 'rotated-at',
      expires: 1893456999999,
    })
    expect(updated).not.toBeInstanceOf(Error)

    // An unrelated provider entry in auth.json must survive the export.
    fs.writeFileSync(
      path.join(opencodeData, 'auth.json'),
      JSON.stringify({ openai: { type: 'api', key: 'sk-unrelated' } }, null, 2),
    )

    const result = await exportOpencodeCredentials({ dataDir, opencodeData })
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    // The pool holds one anthropic rotation (3 accounts after the refresh)
    // and one zai api key. Only oauth accounts export, so only anthropic is
    // written — the pool has no openai oauth account, and its stale rotation
    // file on disk is left alone.
    expect(result.providers.map((provider) => provider.provider)).toEqual(['anthropic'])
    expect(result.providers[0]).toMatchObject({ count: 3, first: 'acct-777' })
    expect(result.written).toHaveLength(2)

    const auth = JSON.parse(fs.readFileSync(path.join(opencodeData, 'auth.json'), 'utf8')) as Record<string, unknown>
    expect(auth.anthropic).toEqual({ type: 'oauth', refresh: 'rotated-rt', access: 'rotated-at', expires: 1893456999999 })
    expect(auth.openai).toEqual({ type: 'api', key: 'sk-unrelated' })

    const rotation = JSON.parse(
      fs.readFileSync(path.join(opencodeData, 'anthropic-oauth-accounts.json'), 'utf8'),
    ) as Array<Record<string, unknown>>
    expect(rotation).toHaveLength(3)
    expect(rotation[0]).toMatchObject({ type: 'oauth', refresh: 'rotated-rt' })

    const text = formatOpencodeExportReport(result).join('\n')
    expect(text).toContain('anthropic: 3 accounts')
    for (const secret of ALL_SECRETS) {
      expect(text).not.toContain(secret)
    }
  })

  test('a pool with no oauth accounts writes nothing', async () => {
    const result = await exportOpencodeCredentials({ dataDir, opencodeData })
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.providers).toEqual([])
    expect(result.written).toEqual([])
    expect(fs.readdirSync(opencodeData)).toEqual([])
    expect(formatOpencodeExportReport(result).join('\n')).toContain('no oauth accounts')
  })

  test('api-key accounts are never exported', async () => {
    writeOpencodeFixture({ rotations: false })
    importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    const result = await exportOpencodeCredentials({ dataDir, opencodeData })
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    // Only the anthropic oauth account exports; the zai api key stays
    // pool-managed, and unrelated auth.json entries (the zai api key and the
    // github-copilot oauth opencode holds) are preserved as they were.
    expect(result.providers.map((provider) => provider.provider)).toEqual(['anthropic'])
    const auth = JSON.parse(fs.readFileSync(path.join(opencodeData, 'auth.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(auth).sort()).toEqual(['$schema', 'anthropic', 'github-copilot', 'zai'])
    expect(auth.zai).toEqual({ type: 'api', key: 'zai-live-key-8888' })
    expect(auth.anthropic).toMatchObject({ type: 'oauth' })
  })

  test('round-trips through a fresh pool without duplicating', async () => {
    writeOpencodeFixture()
    importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    const exported = await exportOpencodeCredentials({ dataDir, opencodeData })
    expect(exported).not.toBeInstanceOf(Error)

    // Import back into a second pool from the exported files: same accounts.
    const second = importResult(
      await importOpencodeCredentials({ dataDir, poolId: 'rollback', opencodeData }),
    )
    expect(second.accounts.imported).toBe(4)
    expect(second.accounts.alreadyPresent).toBe(1)
    const rollback = readPoolAccounts({ dataDir, poolId: 'rollback' })
    if (rollback instanceof Error) throw rollback
    const original = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (original instanceof Error) throw original
    expect(rollback.length).toBe(original.length)
  })

  test('leaves pool rotations untouched', async () => {
    writeOpencodeFixture({ rotations: false })
    importResult(await importOpencodeCredentials({ dataDir, opencodeData }))
    await exportOpencodeCredentials({ dataDir, opencodeData })
    expect(readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toEqual({})
  })
})
