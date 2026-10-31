import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { poolCapacity } from './capacity.js'
import { addPoolOAuthAccount, getPoolDir, readPoolAccounts } from './store.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const reset = '2030-01-01T00:00:00.000Z'
const cases = [
  { name: 'anthropic windows and profile', provider: 'anthropic', body: { five_hour: { utilization: 25, resets_at: reset }, seven_day: { utilization: 60, resets_at: reset }, extra_usage: { is_enabled: true } }, state: 'available', windows: [{ name: 'five_hour', used_percent: 25, reset_at: reset }, { name: 'seven_day', used_percent: 60, reset_at: reset }] },
  { name: 'codex windows', provider: 'openai-codex', body: { rate_limit: { primary_window: { used_percent: 75, limit_window_seconds: 18000, reset_at: 1893456000 } } }, state: 'available', windows: [{ name: '5_hour', used_percent: 75, reset_at: reset }] },
  { name: 'unauthorized', provider: 'anthropic', status: 401, state: 'auth_failed', windows: [] },
  { name: 'forbidden', provider: 'openai-codex', status: 403, state: 'auth_failed', windows: [] },
  { name: 'unknown provider', provider: 'other', state: 'unmeasured', windows: [] },
  { name: 'one throwing account', provider: 'openai-codex', throws: true, state: 'unmeasured', windows: [] },
  { name: 'zai token limit', provider: 'zai-coding-plan', body: { data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 100, number: 5, unit: 3, nextResetTime: reset }] } }, state: 'exhausted', windows: [{ name: 'tokens_5_hour', used_percent: 100, reset_at: reset }] },
  { name: 'xai credit ratio', provider: 'xai', body: { config: { used: { val: 10 }, monthlyLimit: { val: 40 }, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: reset } } }, state: 'available', windows: [{ name: 'credits_weekly', used_percent: 25, reset_at: reset }] },
]

test.each(cases)('poolCapacity: $name', async (entry) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-'))
  dirs.push(dataDir)
  const poolId = 'shared'
  const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'stored-account' } })).toString('base64url')}.signature`
  const account = await addPoolOAuthAccount({ dataDir, poolId, provider: entry.provider, access, refresh: 'refresh-secret', expires: Date.now() + 3600000 })
  expect(account).not.toBeInstanceOf(Error)
  await addPoolOAuthAccount({ dataDir, poolId, provider: 'xai', access: 'healthy-token', refresh: 'other-refresh', expires: Date.now() + 3600000 })
  const calls: string[] = []
  const report = await poolCapacity({ dataDir, poolId, fetchImpl: async (input, init) => {
    const url = String(input)
    calls.push(url)
    expect(init?.signal).toBeDefined()
    const headers = new Headers(init?.headers)
    if (headers.get('Authorization') === 'Bearer healthy-token') return Response.json({ config: {} })
    if (entry.throws) throw new Error('network failure')
    if (entry.provider === 'openai-codex') expect(headers.get('chatgpt-account-id')).toBe('stored-account')
    if (url.endsWith('/profile')) return Response.json({ account: { email_address: 'person@example.com' } })
    return Response.json(entry.body || {}, { status: entry.status || 200 })
  } })
  if (report instanceof Error) throw report
  expect(report.scope).toBe(poolId)
  expect(report.accounts[0]).toMatchObject({ state: entry.state, windows: entry.windows })
  expect(report.accounts[1]?.state).toBe('available')
  expect(report.state).toBe('available')
  if (entry.provider === 'other') expect(calls).toHaveLength(1)
  if (entry.name === 'anthropic windows and profile') expect(report.accounts[0]).toMatchObject({ label: 'person@example.com', extra_usage: { enabled: true, limit_reached: false } })
  const history = fs.readFileSync(path.join(getPoolDir({ dataDir, poolId }), 'usage.jsonl'), 'utf8')
  expect(JSON.parse(history).accounts).toEqual(report.accounts)
  expect(history).not.toContain(access)
  expect(history).not.toContain('refresh-secret')
  expect(readPoolAccounts({ dataDir, poolId })).not.toBeInstanceOf(Error)
})
