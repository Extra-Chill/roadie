// Tests for `roadie credentials import-opencode` (issue #150): OpenCode
// auth.json + Kimaki's <provider>-oauth-accounts.json rotation files into a
// pool. Read-only on the source and never a secret in any report.

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
  readPoolAccounts,
  readPoolRotations,
  SHARED_POOL_ID,
  updatePoolAccount,
} from './store.js'
import { resetCatalogCacheForTests } from './provider-catalog.js'

let dataDir: string
let opencodeData: string

// Fixture catalog preset in the catalog memo, so the
// import resolves providers without any network. `zai` resolves; the rest of
// the routing rules come from the shared subrouter planner.
const TEST_CATALOG = {
  anthropic: { id: 'anthropic' },
  openai: { id: 'openai' },
  zai: { id: 'zai', api: 'https://api.z.ai/api/paas/v4' },
}

const ALL_SECRETS = [
  'ok-rt-secret-1',
  'ok-at-secret-1',
  'ok-rt-secret-2',
  'ok-at-secret-2',
  'ok-rt-secret-3',
  'ok-at-secret-3',
  'ok-rt-secret-9',
  'ok-at-secret-9',
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
  resetCatalogCacheForTests(TEST_CATALOG)
})

afterEach(() => {
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
    // openai rotation entry is a ChatGPT subscription (#198) and imports as
    // openai-codex.
    expect(result.accounts.imported).toBe(5)
    expect(result.accounts.skipped).toBe(1)
    expect(result.accounts.alreadyPresent).toBe(1)
    expect(
      result.accounts.entries
        .filter((entry) => entry.action === 'imported')
        .map((entry) => (entry.action === 'imported' ? entry.display : '')),
    ).toEqual(['acct-777', '…8888', 'bridget@example.com', '…et-3', '…et-9'])

    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    expect(accounts).not.toBeInstanceOf(Error)
    if (accounts instanceof Error) return
    expect(accounts).toHaveLength(5)
    const oauth = accounts.filter((account) => account.type === 'oauth')
    expect(oauth.map((account) => (account.type === 'oauth' ? account.refresh : ''))).toEqual([
      'ok-rt-secret-1',
      'ok-rt-secret-2',
      'ok-rt-secret-3',
      'ok-rt-secret-9',
    ])
    expect(oauth.map((account) => account.label)).toEqual([
      'acct-777',
      'bridget@example.com',
      undefined,
      undefined,
    ])
    expect(oauth[3]).toMatchObject({ provider: 'openai-codex', type: 'oauth' })
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
    expect(second.accounts.alreadyPresent).toBe(6)
    expect(second.accounts.skipped).toBe(1)
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) return
    expect(accounts).toHaveLength(5)
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
    ])
  })

  test('dry run prints the plan and writes nothing', async () => {
    writeOpencodeFixture()
    const result = importResult(await importOpencodeCredentials({ dataDir, opencodeData, dryRun: true }))
    expect(result.dryRun).toBe(true)
    expect(result.accounts.imported).toBe(5)
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
