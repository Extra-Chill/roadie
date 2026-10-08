import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  importSubrouterCredentials,
  formatSubrouterImportReport,
  resolveSubrouterHome,
  orderAccountsByActiveIndex,
  findExistingPoolAccount,
  isImportRoutableProvider,
  planSubrouterImport,
  readSubrouterFiles,
  type SubrouterImportResult,
} from './import-subrouter.js'
import {
  readPoolAccounts,
  readPoolRotations,
  setPoolRotation,
  SHARED_POOL_ID,
} from './store.js'
import { resetCatalogCacheForTests } from './provider-catalog.js'

let dataDir: string
let subrouterHome: string
let originalSubrouterHomeEnv: string | undefined
let originalXdgCacheHome: string | undefined

// Fixture catalog served through $XDG_CACHE_HOME/opencode/models.json, so the
// import resolves providers without any network. `zai` resolves (the #136
// example); `github-copilot` deliberately does not.
const TEST_CATALOG = {
  anthropic: { id: 'anthropic', npm: '@ai-sdk/anthropic' },
  openai: { id: 'openai', npm: '@ai-sdk/openai' },
  zai: { id: 'zai', npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/paas/v4' },
}

// Fixture shaped like a real subrouter home: anthropic with 5 oauth accounts
// and activeIndex 4, zai with 1 api key, github-copilot oauth, openai api +
// oauth, and presets including github-copilot entries and a #high variant.
const ANTHROPIC_ACCOUNTS = [
  { type: 'oauth', refresh: 'rt-anth-1', access: 'at-anth-1', expires: 1893456000001, email: 'alice@example.com', addedAt: 1, lastUsed: 1 },
  { type: 'oauth', refresh: 'rt-anth-2', access: 'at-anth-2', expires: 1893456000002, email: 'bridget@example.com', addedAt: 2, lastUsed: 2 },
  { type: 'oauth', refresh: 'rt-anth-3', access: 'at-anth-3', expires: 1893456000003, accountId: 'acct-777', addedAt: 3, lastUsed: 3 },
  { type: 'oauth', refresh: 'rt-anth-4', access: 'at-anth-4', expires: 1893456000004, addedAt: 4, lastUsed: 4 },
  { type: 'oauth', refresh: 'rt-anth-5', access: 'at-anth-5', expires: 1893456000005, email: 'elle@example.com', addedAt: 5, lastUsed: 5 },
]
const ALL_SECRETS = [
  ...ANTHROPIC_ACCOUNTS.flatMap((account) => [account.refresh, account.access]),
  'zai-live-key-8888',
  'sk-openai-live-0001',
  'ok-rt-secret-1',
  'ok-at-secret-1',
  'gh-rt-secret-1',
  'gh-at-secret-1',
]

function writeSubrouterFixture({
  auth = true,
  config = true,
  authOverrides,
}: {
  auth?: boolean
  config?: boolean
  authOverrides?: Record<string, unknown>
} = {}): void {
  if (auth) {
    const authFile = {
      $schema: 'https://subrouter.org/auth.schema.json',
      version: 1,
      providers: {
        anthropic: { activeIndex: 4, accounts: ANTHROPIC_ACCOUNTS },
        zai: { activeIndex: 0, accounts: [{ type: 'api', key: 'zai-live-key-8888', addedAt: 1, lastUsed: 1 }] },
        'github-copilot': {
          activeIndex: 0,
          accounts: [{ type: 'oauth', refresh: 'gh-rt-secret-1', access: 'gh-at-secret-1', expires: 1893456000006, addedAt: 1, lastUsed: 1 }],
        },
        openai: {
          activeIndex: 0,
          accounts: [
            { type: 'api', key: 'sk-openai-live-0001', addedAt: 1, lastUsed: 1 },
            { type: 'oauth', refresh: 'ok-rt-secret-1', access: 'ok-at-secret-1', expires: 1893456000007, addedAt: 2, lastUsed: 2 },
          ],
        },
        ...(authOverrides ?? {}),
      },
    }
    fs.writeFileSync(path.join(subrouterHome, 'auth.json'), JSON.stringify(authFile, null, 2))
  }
  if (config) {
    const configFile = {
      $schema: 'https://subrouter.org/config.schema.json',
      version: 1,
      presets: {
        max: ['anthropic/claude-opus-4-6#high', 'anthropic/claude-sonnet-4', 'zai/glm-4.7', 'github-copilot/gpt-5'],
        'copilot-only': ['github-copilot/gpt-5'],
        'bad name!': ['anthropic/claude-sonnet-4'],
        backup: ['openai/gpt-5.5'],
      },
      cooldowns: {},
      routes: {},
    }
    fs.writeFileSync(path.join(subrouterHome, 'config.json'), JSON.stringify(configFile, null, 2))
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-import-'))
  subrouterHome = fs.mkdtempSync(path.join(os.tmpdir(), 'subrouter-home-'))
  originalSubrouterHomeEnv = process.env.SUBROUTER_HOME
  process.env.SUBROUTER_HOME = subrouterHome
  originalXdgCacheHome = process.env.XDG_CACHE_HOME
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-cache-'))
  fs.mkdirSync(path.join(cacheHome, 'opencode'), { recursive: true })
  fs.writeFileSync(path.join(cacheHome, 'opencode', 'models.json'), JSON.stringify(TEST_CATALOG))
  process.env.XDG_CACHE_HOME = cacheHome
  resetCatalogCacheForTests()
})

afterEach(() => {
  if (originalSubrouterHomeEnv === undefined) {
    delete process.env.SUBROUTER_HOME
  } else {
    process.env.SUBROUTER_HOME = originalSubrouterHomeEnv
  }
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  resetCatalogCacheForTests()
})

function importResult(result: SubrouterImportResult | Error): SubrouterImportResult {
  expect(result).not.toBeInstanceOf(Error)
  if (result instanceof Error) throw result
  return result
}

function reportText(result: SubrouterImportResult): string {
  return formatSubrouterImportReport(result).join('\n')
}

describe('importSubrouterCredentials', () => {
  test('imports ordered by activeIndex, with labels from email or accountId', async () => {
    writeSubrouterFixture()
    const result = importResult(
      await importSubrouterCredentials({ dataDir, dryRun: false }),
    )
    expect(result.accounts.imported).toBe(7)
    expect(result.accounts.skipped).toBe(2)
    expect(result.accounts.alreadyPresent).toBe(0)
    // anthropic order: account at activeIndex 4 first, then wrap-around.
    expect(
      result.accounts.entries
        .filter((entry) => entry.action === 'imported')
        .map((entry) => (entry.action === 'imported' ? entry.display : '')),
    ).toEqual([
      'elle@example.com',
      'alice@example.com',
      'bridget@example.com',
      'acct-777',
      '…th-4',
      '…8888',
      '…0001',
    ])

    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    expect(accounts).toHaveLength(7)
    if (accounts instanceof Error) return
    const oauth = accounts.filter((account) => account.type === 'oauth')
    expect(oauth.map((account) => (account.type === 'oauth' ? account.refresh : ''))).toEqual([
      'rt-anth-5',
      'rt-anth-1',
      'rt-anth-2',
      'rt-anth-3',
      'rt-anth-4',
    ])
    expect(oauth.map((account) => account.label)).toEqual([
      'elle@example.com',
      'alice@example.com',
      'bridget@example.com',
      'acct-777',
      undefined,
    ])
    if (oauth[0]?.type !== 'oauth') return
    expect(oauth[0]).toMatchObject({ refresh: 'rt-anth-5', access: 'at-anth-5', expires: 1893456000005 })
    // The zai api key imports for any provider the catalog resolves (#136).
    const api = accounts.filter((account) => account.type === 'api')
    expect(api.map((account) => (account.type === 'api' ? account.key : ''))).toEqual([
      'zai-live-key-8888',
      'sk-openai-live-0001',
    ])
    expect(api[0]).toMatchObject({ provider: 'zai', type: 'api' })
    expect(api[1]).toMatchObject({ provider: 'openai', type: 'api' })
  })

  test('skips github-copilot and openai oauth with per-entry reasons; the zai api key imports', async () => {
    writeSubrouterFixture()
    const result = importResult(await importSubrouterCredentials({ dataDir }))
    const skips = result.accounts.entries
      .filter((entry) => entry.action === 'skipped')
      .map((entry) => ({ provider: entry.provider, reason: entry.action === 'skipped' ? entry.reason : '' }))
    expect(skips).toEqual([
      { provider: 'github-copilot', reason: 'no pool adapter for github-copilot' },
      { provider: 'openai', reason: 'no pool adapter for openai oauth' },
    ])
  })

  test('imports presets as rotations with variants stripped and unroutable entries dropped', async () => {
    writeSubrouterFixture()
    const result = importResult(await importSubrouterCredentials({ dataDir }))
    expect(result.rotations.set).toBe(2)
    expect(result.rotations.skipped).toBe(2)
    const max = result.rotations.entries.find((entry) => entry.name === 'max')
    expect(max).toMatchObject({
      action: 'set',
      entries: ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4', 'zai/glm-4.7'],
      strippedVariants: 1,
      droppedUnroutable: ['github-copilot'],
    })
    const rotations = readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })
    if (rotations instanceof Error) return
    expect(rotations).toEqual({
      max: ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4', 'zai/glm-4.7'],
      backup: ['openai/gpt-5.5'],
    })
    const text = reportText(result)
    expect(text).toContain('stripped #variant suffix from 1 entry')
    expect(text).toContain('skipped copilot-only: no routable entries')
    expect(text).toContain('skipped bad name!: invalid rotation name')
  })

  test('a second run adds nothing and reports already present', async () => {
    writeSubrouterFixture()
    const first = importResult(await importSubrouterCredentials({ dataDir }))
    expect(first.accounts.imported).toBe(7)
    expect(first.rotations.set).toBe(2)
    const second = importResult(await importSubrouterCredentials({ dataDir }))
    expect(second.accounts.imported).toBe(0)
    expect(second.accounts.alreadyPresent).toBe(7)
    expect(second.accounts.skipped).toBe(2)
    expect(second.rotations.set).toBe(0)
    expect(second.rotations.skipped).toBe(4)
    const text = reportText(second)
    expect(text).toContain('already present anthropic elle@example.com')
    expect(text).toContain('skipped max: rotation already exists')
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) return
    expect(accounts).toHaveLength(7)
  })

  test('dedupes oauth by refresh token, accountId and email', async () => {
    writeSubrouterFixture()
    importResult(await importSubrouterCredentials({ dataDir }))
    // Simulate a re-login with rotated tokens but the same email/accountId.
    const authFile = JSON.parse(fs.readFileSync(path.join(subrouterHome, 'auth.json'), 'utf8')) as {
      providers: Record<string, { activeIndex: number; accounts: Array<Record<string, unknown>> } | undefined>
    }
    const anthropic = authFile.providers.anthropic
    if (!anthropic) throw new Error('fixture is missing the anthropic provider')
    anthropic.accounts = [
      { type: 'oauth', refresh: 'rt-new-1', access: 'at-new-1', expires: 1893456790001, email: 'ALICE@example.com', addedAt: 9, lastUsed: 9 },
      { type: 'oauth', refresh: 'rt-new-3', access: 'at-new-3', expires: 1893456790003, accountId: 'acct-777', addedAt: 9, lastUsed: 9 },
      { type: 'oauth', refresh: 'rt-anth-4', access: 'at-fresh-4', expires: 1893456790004, addedAt: 9, lastUsed: 9 },
    ]
    anthropic.activeIndex = 0
    fs.writeFileSync(path.join(subrouterHome, 'auth.json'), JSON.stringify(authFile, null, 2))
    const second = importResult(await importSubrouterCredentials({ dataDir }))
    // 3 re-listed anthropic accounts dedupe by refresh/accountId/email, the
    // unchanged zai and openai api keys by key; nothing new is added.
    expect(second.accounts.alreadyPresent).toBe(5)
    expect(second.accounts.imported).toBe(0)
    expect(second.accounts.skipped).toBe(2)
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) return
    expect(accounts).toHaveLength(7)
  })

  test('dry run prints the plan and writes nothing', async () => {
    writeSubrouterFixture()
    const result = importResult(await importSubrouterCredentials({ dataDir, dryRun: true }))
    expect(result.dryRun).toBe(true)
    expect(result.accounts.imported).toBe(7)
    expect(result.rotations.set).toBe(2)
    expect(fs.existsSync(path.join(dataDir, 'credentials'))).toBe(false)
    const text = reportText(result)
    expect(text).toContain('dry run, nothing written')
    // The plan lists the same adds a real run would do.
    expect(text).toContain('imported anthropic elle@example.com')
    expect(text).toContain('set max: anthropic/claude-opus-4-6 anthropic/claude-sonnet-4 zai/glm-4.7')
  })

  test('dry run after a real import previews everything as already present', async () => {
    writeSubrouterFixture()
    importResult(await importSubrouterCredentials({ dataDir }))
    const preview = importResult(await importSubrouterCredentials({ dataDir, dryRun: true }))
    expect(preview.accounts.imported).toBe(0)
    expect(preview.accounts.alreadyPresent).toBe(7)
  })

  test('concurrent imports add each account and rotation once', async () => {
    writeSubrouterFixture()
    const runs = await Promise.all([
      importSubrouterCredentials({ dataDir }),
      importSubrouterCredentials({ dataDir }),
      importSubrouterCredentials({ dataDir }),
    ])
    const results = runs.map(importResult)
    expect(results.reduce((sum, result) => sum + result.accounts.imported, 0)).toBe(7)
    expect(results.reduce((sum, result) => sum + result.rotations.set, 0)).toBe(2)
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    if (accounts instanceof Error) throw accounts
    expect(accounts).toHaveLength(7)
  })

  test('subrouter files are byte-identical after a real import', async () => {
    writeSubrouterFixture()
    const authBefore = fs.readFileSync(path.join(subrouterHome, 'auth.json'))
    const configBefore = fs.readFileSync(path.join(subrouterHome, 'config.json'))
    const listingBefore = fs.readdirSync(subrouterHome).sort()
    importResult(await importSubrouterCredentials({ dataDir }))
    expect(fs.readFileSync(path.join(subrouterHome, 'auth.json')).equals(authBefore)).toBe(true)
    expect(fs.readFileSync(path.join(subrouterHome, 'config.json')).equals(configBefore)).toBe(true)
    expect(fs.readdirSync(subrouterHome).sort()).toEqual(listingBefore)
  })

  test('no token or key appears in the report', async () => {
    writeSubrouterFixture()
    const dry = importResult(await importSubrouterCredentials({ dataDir, dryRun: true }))
    const real = importResult(await importSubrouterCredentials({ dataDir }))
    for (const result of [dry, real]) {
      const text = reportText(result)
      for (const secret of ALL_SECRETS) {
        expect(text).not.toContain(secret)
      }
    }
  })

  test('never overwrites an existing rotation with the same name', async () => {
    writeSubrouterFixture()
    const preset = await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'max',
      entries: ['anthropic/claude-3-haiku'],
    })
    expect(preset).toBe(true)
    const result = importResult(await importSubrouterCredentials({ dataDir }))
    expect(result.rotations.set).toBe(1)
    expect(result.rotations.entries.find((entry) => entry.name === 'max')).toMatchObject({
      action: 'skipped',
      reason: 'rotation already exists',
    })
    const rotations = readPoolRotations({ dataDir, poolId: SHARED_POOL_ID })
    if (rotations instanceof Error) return
    expect(rotations.max).toEqual(['anthropic/claude-3-haiku'])
  })

  test('malformed auth.json reports the parse error and writes nothing', async () => {
    writeSubrouterFixture()
    fs.writeFileSync(path.join(subrouterHome, 'auth.json'), '{ not json')
    const result = await importSubrouterCredentials({ dataDir })
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) return
    expect(result.message).toContain('Failed to parse')
    expect(result.message).toContain('auth.json')
    expect(fs.existsSync(path.join(dataDir, 'credentials'))).toBe(false)
  })

  test('malformed config.json writes nothing, missing config.json imports accounts only', async () => {
    writeSubrouterFixture()
    fs.writeFileSync(path.join(subrouterHome, 'config.json'), '[]')
    const bad = await importSubrouterCredentials({ dataDir })
    expect(bad).toBeInstanceOf(Error)
    fs.rmSync(path.join(subrouterHome, 'config.json'))
    fs.rmSync(path.join(dataDir, 'credentials'), { recursive: true, force: true })
    const good = importResult(await importSubrouterCredentials({ dataDir }))
    expect(good.accounts.imported).toBe(7)
    expect(good.rotations.set).toBe(0)
  })

  test('a missing subrouter home and a missing auth.json are clear errors', async () => {
    const missing = await importSubrouterCredentials({
      dataDir,
      subrouterHome: path.join(subrouterHome, 'does-not-exist'),
    })
    expect(missing).toBeInstanceOf(Error)
    if (!(missing instanceof Error)) return
    expect(missing.message).toContain('No subrouter home found at')

    const empty = await importSubrouterCredentials({ dataDir, subrouterHome })
    expect(empty).toBeInstanceOf(Error)
    if (!(empty instanceof Error)) return
    expect(empty.message).toContain('No auth.json found in')
  })

  test('accepts --subrouter-home without relying on the environment variable', async () => {
    writeSubrouterFixture()
    delete process.env.SUBROUTER_HOME
    const result = importResult(
      await importSubrouterCredentials({ dataDir, subrouterHome }),
    )
    expect(result.home).toBe(subrouterHome)
    expect(result.accounts.imported).toBe(7)
  })
})

describe('catalog-aware routability', () => {
  const files = () => {
    writeSubrouterFixture()
    const subrouterFiles = readSubrouterFiles({ home: subrouterHome })
    if (subrouterFiles instanceof Error) throw subrouterFiles
    return subrouterFiles
  }

  test('a catalog-resolvable provider imports; github-copilot does not', () => {
    const subrouterFiles = files()
    const plan = planSubrouterImport({
      files: subrouterFiles,
      existingAccounts: [],
      existingRotations: {},
      catalog: TEST_CATALOG,
    })
    const imported = plan.accounts
      .filter((entry) => entry.action === 'import')
      .map((entry) => (entry.action === 'import' ? entry.candidate.provider : ''))
    expect(imported).toEqual(['anthropic', 'anthropic', 'anthropic', 'anthropic', 'anthropic', 'zai', 'openai'])
    const rotations = plan.rotations.find((entry) => entry.name === 'max')
    expect(rotations).toMatchObject({
      action: 'set',
      entries: ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4', 'zai/glm-4.7'],
      droppedUnroutable: ['github-copilot'],
    })
  })

  test('without a catalog, the legacy anthropic/openai pair still imports and zai is skipped', () => {
    const subrouterFiles = files()
    const plan = planSubrouterImport({
      files: subrouterFiles,
      existingAccounts: [],
      existingRotations: {},
      catalog: null,
    })
    const imported = plan.accounts
      .filter((entry) => entry.action === 'import')
      .map((entry) => (entry.action === 'import' ? entry.candidate.provider : ''))
    expect(imported).toEqual([
      'anthropic',
      'anthropic',
      'anthropic',
      'anthropic',
      'anthropic',
      'openai',
    ])
    const skippedZai = plan.accounts.find(
      (entry) => entry.action === 'skip' && entry.provider === 'zai',
    )
    expect(skippedZai).toMatchObject({ action: 'skip', reason: 'no pool adapter for zai' })
  })

  test('isImportRoutableProvider: catalog resolution vs the legacy fallback pair', () => {
    const catalog = { zai: { id: 'zai', api: 'https://api.z.ai/api/paas/v4' } }
    expect(isImportRoutableProvider('zai', catalog)).toBe(true)
    expect(isImportRoutableProvider('github-copilot', catalog)).toBe(false)
    expect(isImportRoutableProvider('zai', null)).toBe(false)
    expect(isImportRoutableProvider('anthropic', null)).toBe(true)
    expect(isImportRoutableProvider('openai', null)).toBe(true)
  })
})

describe('resolveSubrouterHome', () => {
  test('prefers the flag, then $SUBROUTER_HOME, then ~/.subrouter', () => {    expect(resolveSubrouterHome({ subrouterHome: subrouterHome })).toBe(subrouterHome)
    expect(resolveSubrouterHome({})).toBe(subrouterHome)
    const previous = process.env.SUBROUTER_HOME
    delete process.env.SUBROUTER_HOME
    try {
      // Under vitest the real ~/.subrouter is refused so tests can never read it.
      const fallback = resolveSubrouterHome({})
      expect(fallback).toBeInstanceOf(Error)
      if (!(fallback instanceof Error)) return
      expect(fallback.message).toContain('SUBROUTER_HOME')
    } finally {
      if (previous === undefined) {
        delete process.env.SUBROUTER_HOME
      } else {
        process.env.SUBROUTER_HOME = previous
      }
    }
  })
})

describe('orderAccountsByActiveIndex', () => {
  test('starts at activeIndex and wraps around like subrouter', () => {
    expect(orderAccountsByActiveIndex(['a', 'b', 'c', 'd', 'e'], 4)).toEqual(['e', 'a', 'b', 'c', 'd'])
    expect(orderAccountsByActiveIndex(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c'])
    expect(orderAccountsByActiveIndex(['a', 'b', 'c'], 5)).toEqual(['c', 'a', 'b'])
    expect(orderAccountsByActiveIndex(['a', 'b', 'c'], -1)).toEqual(['c', 'a', 'b'])
    expect(orderAccountsByActiveIndex([], 2)).toEqual([])
  })
})

describe('findExistingPoolAccount', () => {
  const oauthCandidate = {
    kind: 'oauth' as const,
    provider: 'anthropic',
    refresh: 'rt-new',
    access: 'at-new',
    expires: 1893456000000,
    display: 'x',
  }

  test('matches api accounts by key', () => {
    const pool = [
      { id: '1', provider: 'anthropic', type: 'api' as const, key: 'sk-live-1', addedAt: '', lastUsed: null },
    ]
    expect(
      findExistingPoolAccount({ accounts: pool, candidate: { kind: 'api', provider: 'openai', key: 'sk-live-1', display: 'x' } }),
    ).toMatchObject({ id: '1' })
    expect(
      findExistingPoolAccount({ accounts: pool, candidate: { kind: 'api', provider: 'openai', key: 'sk-other', display: 'x' } }),
    ).toBeNull()
  })

  test('matches oauth accounts by refresh token, then accountId/email against the label', () => {
    const pool = [
      { id: '1', provider: 'anthropic', type: 'oauth' as const, refresh: 'rt-old', access: 'at-old', expires: 1, label: 'alice@example.com', addedAt: '', lastUsed: null },
      { id: '2', provider: 'anthropic', type: 'oauth' as const, refresh: 'rt-old-2', access: 'at-old-2', expires: 1, label: 'acct-777', addedAt: '', lastUsed: null },
    ]
    expect(findExistingPoolAccount({ accounts: pool, candidate: { ...oauthCandidate, refresh: 'rt-old' } })).toMatchObject({ id: '1' })
    expect(findExistingPoolAccount({ accounts: pool, candidate: { ...oauthCandidate, accountId: 'acct-777' } })).toMatchObject({ id: '2' })
    expect(findExistingPoolAccount({ accounts: pool, candidate: { ...oauthCandidate, email: 'Alice@Example.com' } })).toMatchObject({ id: '1' })
    expect(findExistingPoolAccount({ accounts: pool, candidate: { ...oauthCandidate, provider: 'openai' } })).toBeNull()
    expect(findExistingPoolAccount({ accounts: [], candidate: oauthCandidate })).toBeNull()
  })
})
