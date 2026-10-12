// Test helper: one process refreshing a pool account (see pool-lock.test.ts).
import { ensureFreshOAuthAccount } from './provider.js'
import { readPoolAccounts } from './store.js'

const [dataDir, poolId, tokenUrl] = process.argv.slice(2) as [string, string, string]
const accounts = readPoolAccounts({ dataDir, poolId })
if (accounts instanceof Error) throw accounts
// Wait for the shared start signal so both processes race.
while (Date.now() < Number(process.env['START_AT'])) await new Promise((r) => setTimeout(r, 2))
const result = await ensureFreshOAuthAccount({
  dataDir,
  poolId,
  account: accounts[0]!,
  now: Date.now(),
  fetchImpl: (_url, init) => fetch(tokenUrl, init),
})
if (result instanceof Error) throw result
process.stdout.write(JSON.stringify({ access: result.type === 'oauth' ? result.access : null }))
