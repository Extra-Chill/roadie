import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { poolCapacity } from './capacity.js'
import { addPoolOAuthAccount, getPoolDir, readPoolAccounts } from './store.js'

test('usage refreshes and persists the account token, and rotates history', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-refresh-'))
  const poolId = 'shared'
  try {
    await addPoolOAuthAccount({ dataDir, poolId, provider: 'anthropic', access: 'expired', refresh: 'old-refresh', expires: 1 })
    const history = path.join(getPoolDir({ dataDir, poolId }), 'usage.jsonl')
    fs.writeFileSync(history, ' '.repeat(1024 * 1024))
    const calls: string[] = []
    const report = await poolCapacity({ dataDir, poolId, fetchImpl: async (input, init) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/token')) {
        expect(JSON.parse(String(init?.body)).refresh_token).toBe('old-refresh')
        return Response.json({ access_token: 'fresh-token', refresh_token: 'rotated-refresh', expires_in: 3600 })
      }
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer fresh-token')
      expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
      if (url.endsWith('/profile')) return Response.json({ account: { email: 'idle@example.com' } })
      return Response.json({ five_hour: { utilization: 10 } })
    } })
    expect(report).toMatchObject({ state: 'available', remaining: 90, accounts: [{ label: 'idle@example.com' }] })
    expect(calls).toHaveLength(3)
    expect(readPoolAccounts({ dataDir, poolId })).toMatchObject([{ access: 'fresh-token', refresh: 'rotated-refresh' }])
    expect(fs.statSync(`${history}.1`).size).toBe(1024 * 1024)
    const saved = fs.readFileSync(history, 'utf8')
    expect(JSON.parse(saved).timestamp).toBeTruthy()
    expect(saved).not.toContain('fresh-token')
    expect(saved).not.toContain('rotated-refresh')
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
})
