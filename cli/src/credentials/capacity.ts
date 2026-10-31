// Subscription usage only: these probes never make inference requests.
// Response parsing mirrors homeboy-extensions/agent-runtimes/lib/provider-capacity.js.
import fs from 'node:fs'
import path from 'node:path'
import { getPoolDir, readPoolAccounts, withPoolLockAt, type PoolAccount } from './store.js'
import { ensureFreshOAuthAccount, type PoolFetch } from './pool-routing.js'
import { isPermanentRefreshFailure } from './adapters/anthropic-oauth.js'
import { codexAccountId } from './adapters/openai-codex-oauth.js'

export type UsageWindow = { name: string; used_percent: number; reset_at: string | null }
export type AccountCapacity = {
  id: string
  provider: string
  label: string
  state: 'available' | 'exhausted' | 'auth_failed' | 'unmeasured'
  windows: UsageWindow[]
  diagnostic?: string
  extra_usage?: { enabled: boolean; limit_reached: boolean; user_disabled?: boolean }
}
export type PoolCapacity = {
  state: AccountCapacity['state']
  remaining: number | null
  limit: number
  unit: 'percent'
  reset_at: string | null
  scope: string
  accounts: AccountCapacity[]
  diagnostic?: string
}

const URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/api/oauth/usage',
  'openai-codex': 'https://chatgpt.com/backend-api/wham/usage',
  'zai-coding-plan': 'https://api.z.ai/api/monitor/usage/quota/limit',
  xai: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
function iso(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (value === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
function window(name: string, used: number, reset: unknown): UsageWindow {
  return { name, used_percent: Math.min(100, Math.max(0, Math.round(used * 100) / 100)), reset_at: iso(reset) }
}
function parseWindows(provider: string, body: Record<string, unknown>): { windows: UsageWindow[]; blocked: boolean } {
  let windows: UsageWindow[] = []
  let blocked = false
  if (provider === 'anthropic') {
    windows = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'].flatMap((name) => {
      const entry = record(body[name])
      return finite(entry.utilization) ? [window(name, entry.utilization, entry.resets_at)] : []
    })
  } else if (provider === 'openai-codex') {
    const limit = record(body.rate_limit)
    blocked = limit.allowed === false || limit.limit_reached === true
    windows = ['primary_window', 'secondary_window'].flatMap((name) => {
      const entry = record(limit[name])
      const seconds = entry.limit_window_seconds
      const label = finite(seconds) && seconds > 0 ? seconds % 86400 === 0 ? `${seconds / 86400}_day` : seconds % 3600 === 0 ? `${seconds / 3600}_hour` : name : name
      return finite(entry.used_percent) ? [window(label, entry.used_percent, finite(entry.reset_at) ? entry.reset_at * 1000 : null)] : []
    })
  } else if (provider === 'zai-coding-plan') {
    const limits = record(body.data).limits
    const units: Record<string, string> = { 3: 'hour', 4: 'day', 5: 'month', 6: 'week' }
    windows = (Array.isArray(limits) ? limits : []).flatMap((value: unknown) => {
      const entry = record(value)
      return entry.type === 'TOKENS_LIMIT' && finite(entry.percentage) ? [window(`tokens_${entry.number}_${units[String(entry.unit)] || `unit${entry.unit}`}`, entry.percentage, entry.nextResetTime)] : []
    })
  } else if (provider === 'xai' && body.config && typeof body.config === 'object') {
    const config = record(body.config)
    const period = record(config.currentPeriod)
    const limit = record(config.monthlyLimit).val
    const used = record(config.used).val
    const percent = finite(config.creditUsagePercent) ? config.creditUsagePercent : finite(limit) && limit > 0 ? (finite(used) ? used : 0) / limit * 100 : 0
    windows = [window(period.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? 'credits_weekly' : 'credits', percent, period.end || config.billingPeriodEnd)]
  }
  return { windows, blocked }
}

function xaiUserId(token: string): string | undefined {
  try {
    const id = record(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))).principal_id
    return typeof id === 'string' ? id : undefined
  } catch { return undefined }
}

async function probe(account: PoolAccount, options: { dataDir: string; poolId: string; fetchImpl: PoolFetch }): Promise<AccountCapacity> {
  const result: AccountCapacity = { id: account.id, provider: account.provider, label: account.label || account.id, state: 'unmeasured', windows: [] }
  const url = URLS[account.provider]
  if (!url) return result
  try {
    const fresh = await ensureFreshOAuthAccount({ ...options, account, now: Date.now() })
    if (fresh instanceof Error) {
      result.state = isPermanentRefreshFailure(fresh) || ('status' in fresh && fresh.status === 403) ? 'auth_failed' : 'unmeasured'
      result.diagnostic = 'OAuth token refresh failed'
      return result
    }
    const token = fresh.type === 'oauth' ? fresh.access : fresh.key
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: account.provider === 'zai-coding-plan' ? token : `Bearer ${token}` }
    if (account.provider === 'anthropic') headers['anthropic-beta'] = 'oauth-2025-04-20'
    if (account.provider === 'openai-codex') {
      const id = codexAccountId(token)
      if (id) headers['chatgpt-account-id'] = id
    }
    if (account.provider === 'xai') {
      headers['X-XAI-Token-Auth'] = 'xai-grok-cli'
      const id = xaiUserId(token)
      if (id) headers['x-userid'] = id
    }
    const response = await options.fetchImpl(url, { method: 'GET', headers })
    if (!response.ok) {
      result.state = response.status === 401 || response.status === 403 ? 'auth_failed' : 'unmeasured'
      result.diagnostic = `Usage lookup returned HTTP ${response.status}`
      return result
    }
    const body = record(await response.json())
    const parsed = parseWindows(account.provider, body)
    result.windows = parsed.windows
    if (!result.windows.length) {
      result.diagnostic = 'Usage response did not include recognized usage windows'
      return result
    }
    result.state = parsed.blocked || result.windows.some((entry) => entry.used_percent >= 100) ? 'exhausted' : 'available'
    if (account.provider === 'anthropic') {
      if (body.extra_usage && typeof body.extra_usage === 'object') {
        const extra = record(body.extra_usage)
        result.extra_usage = { enabled: extra.is_enabled === true, limit_reached: extra.spend_limit_reached === true, ...(extra.user_disabled === true && { user_disabled: true }) }
      }
      try {
        const profile = await options.fetchImpl('https://api.anthropic.com/api/oauth/profile', { method: 'GET', headers })
        if (profile.status === 401 || profile.status === 403) {
          result.state = 'auth_failed'
          result.diagnostic = `Profile lookup returned HTTP ${profile.status}`
        } else if (profile.ok) {
          const identity = record(record(await profile.json()).account)
          const label = identity.email_address || identity.email
          if (typeof label === 'string' && label.trim()) result.label = label.trim()
        }
      } catch { /* A missing label does not invalidate measured usage. */ }
    }
  } catch {
    result.diagnostic = 'Usage lookup failed (request error or timeout)'
  }
  return result
}

function accountReset(account: AccountCapacity): string | null {
  const windows = account.state === 'exhausted' ? account.windows.filter((entry) => entry.used_percent >= 100) : []
  if (windows.length) return windows.map((entry) => entry.reset_at).filter((value): value is string => !!value).sort().pop() || null
  return [...account.windows].sort((a, b) => b.used_percent - a.used_percent)[0]?.reset_at || null
}
const remaining = (account: AccountCapacity): number => account.state === 'exhausted' ? 0 : Math.max(0, 100 - Math.max(...account.windows.map((entry) => entry.used_percent)))

/** Public local report. Refreshes each account under the store lock, never the router's selected account. */
export async function poolCapacity({ dataDir, poolId, fetchImpl = fetch, timeoutMs = 5000 }: {
  dataDir: string
  poolId: string
  fetchImpl?: PoolFetch
  timeoutMs?: number
}): Promise<PoolCapacity | Error> {
  const stored = readPoolAccounts({ dataDir, poolId })
  if (stored instanceof Error) return stored
  const boundedFetch: PoolFetch = (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const accounts = await Promise.all(stored.map((account) => probe(account, { dataDir, poolId, fetchImpl: boundedFetch })))
  const available = accounts.filter((account) => account.state === 'available').sort((a, b) => remaining(b) - remaining(a))
  const exhausted = accounts.filter((account) => account.state === 'exhausted').sort((a, b) => (accountReset(a) || '~').localeCompare(accountReset(b) || '~'))
  const best = available[0] || exhausted[0]
  const report: PoolCapacity = {
    state: available.length ? 'available' : accounts.length && exhausted.length === accounts.length ? 'exhausted' : accounts.length && accounts.every((account) => account.state === 'auth_failed') ? 'auth_failed' : 'unmeasured',
    remaining: best ? remaining(best) : null,
    limit: 100, unit: 'percent', reset_at: best ? accountReset(best) : null, scope: poolId, accounts,
  }
  try {
    await withPoolLockAt(dataDir, poolId, () => {
      const dir = getPoolDir({ dataDir, poolId })
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, 'usage.jsonl')
      // At most two ~1MiB segments; append within each segment, never rewrite records.
      if (fs.existsSync(file) && fs.statSync(file).size >= 1024 * 1024) fs.renameSync(file, `${file}.1`)
      fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), accounts }) + '\n', { mode: 0o600 })
    })
  } catch { report.diagnostic = 'Could not append usage history' }
  return report
}
