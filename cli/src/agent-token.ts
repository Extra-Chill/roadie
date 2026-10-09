// Per-session agent tokens for tool shells.
//
// The bot's local HTTP server exposes scoped agent endpoints (see
// agent-remote.ts) so `roadie` subcommands inside an agent tool shell never
// need the raw database credentials. The OpenCode plugin's shell.env hook
// exports ROADIE_AGENT_TOKEN — an HMAC of the OpenCode session id under a
// secret shared only between the bot and the OpenCode server process — and
// blanks the database credentials in the same hook output. The bot verifies
// the HMAC per request and never accepts an agent token on the hrana /v2
// routes or any admin route.
//
// The token is bound to one session: it authorizes that session's own
// operations, plus the read-shaped endpoints the CLI already exposes to any
// local operator (search, read, projects). It grants no SQL access.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'

export const AGENT_TOKEN_ENV = 'ROADIE_AGENT_TOKEN'
export const AGENT_TOKEN_SECRET_ENV = 'ROADIE_AGENT_TOKEN_SECRET'

/**
 * Credentials a tool shell must never hold. The shell.env hook blanks these
 * by setting them to '' because OpenCode merges hook env over the inherited
 * env; plugins in the server process keep their access.
 */
export const SCRUBBED_SHELL_ENV_NAMES = [
  'ROADIE_DB_URL',
  'ROADIE_DB_AUTH_TOKEN',
  'ROADIE_DB_AUTH_TOKEN_FILE',
  'ROADIE_SERVICE_TOKEN_FILE',
] as const

/** `<sessionId>.<hmac-sha256(secret, sessionId)>`, both hex/hex. */
export function mintAgentToken({
  secret,
  sessionId,
}: {
  secret: string
  sessionId: string
}): string {
  const mac = crypto.createHmac('sha256', secret).update(sessionId).digest('hex')
  return `${sessionId}.${mac}`
}

/**
 * Verify a token minted by mintAgentToken. Returns the session the token is
 * bound to, or null for malformed, foreign-secret or tampered tokens. The
 * MAC comparison is timing-safe.
 */
export function verifyAgentToken({
  secret,
  token,
}: {
  secret: string
  token: string
}): { sessionId: string } | null {
  const separator = token.lastIndexOf('.')
  if (separator <= 0 || separator === token.length - 1) return null
  const sessionId = token.slice(0, separator)
  const providedMac = token.slice(separator + 1)
  const expectedMac = crypto.createHmac('sha256', secret).update(sessionId).digest('hex')
  const expectedBuf = Buffer.from(expectedMac, 'utf8')
  const providedBuf = Buffer.from(providedMac, 'utf8')
  if (expectedBuf.length !== providedBuf.length) return null
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) return null
  return { sessionId }
}

/**
 * Secret shared between the bot and the OpenCode server process. Persisted
 * under <dataDir>/secrets so minted tokens keep working across bot restarts;
 * opencode.ts also passes it to the server process through
 * ROADIE_AGENT_TOKEN_SECRET so the shell.env hook can mint tokens there.
 * Tool shells only ever receive the derived per-session token: the hook
 * blanks the secret again in the same env it writes the token to.
 */
/**
 * Secret shared between the bot and the OpenCode server process. Persisted
 * under <dataDir>/secrets so minted tokens keep working across bot restarts;
 * opencode.ts also passes it to the server process through
 * ROADIE_AGENT_TOKEN_SECRET so the shell.env hook can mint tokens there.
 * Tool shells only ever receive the derived per-session token: the hook
 * blanks the secret again in the same env it writes the token to.
 */
export function ensureAgentTokenSecret(): string {
  const fromEnv = process.env[AGENT_TOKEN_SECRET_ENV]?.trim()
  if (fromEnv) return fromEnv
  const file = path.join(getDataDir(), 'secrets', 'agent-token-secret')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  const secret = fs.readFileSync(file, 'utf8').trim()
  if (!secret) throw new Error('Roadie agent token secret is unavailable')
  return secret
}

/**
 * shell.env contract: blank the database/service credentials and export the
 * per-session agent token. OpenCode merges hook env over the inherited env,
 * so writing '' blanks inherited values. The minting secret is removed so a
 * shell can never mint tokens for another session, and a stale
 * ROADIE_AGENT_TOKEN never survives into a session-less shell.
 */
export function applyAgentShellEnv({
  env,
  secret,
  sessionId,
}: {
  env: Record<string, string>
  secret: string | undefined
  sessionId: string | undefined
}): void {
  for (const name of SCRUBBED_SHELL_ENV_NAMES) {
    env[name] = ''
  }
  delete env[AGENT_TOKEN_SECRET_ENV]
  if (secret && sessionId) {
    env[AGENT_TOKEN_ENV] = mintAgentToken({ secret, sessionId })
    return
  }
  delete env[AGENT_TOKEN_ENV]
}
