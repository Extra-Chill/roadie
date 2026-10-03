// Service lifecycle: what a long-running Roadie service does around restarts.
//
// - Orphan cleanup: the bot records the pid of the agent server it spawns.
//   If the bot dies without cleaning up (SIGKILL, OOM), the next start stops
//   that leftover server before spawning a new one.
// - Restart continuation: on graceful shutdown the bot records which threads
//   had a run in progress. The next start resumes them, so a restart (service
//   update, host-triggered restart) does not silently drop work.
// - Managed install: the host owns installation and upgrades, so Roadie never
//   upgrades itself.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.CLI)

const AGENT_SERVER_PID_FILE = 'agent-server.pid'
const INTERRUPTED_FILE = 'interrupted-sessions.json'
const INTERRUPTED_VERSION = 1
// A restart that takes longer than this is not a restart anymore; resuming
// stale work hours later would surprise whoever is in the thread.
export const INTERRUPTED_TTL_MS = 15 * 60 * 1000

let serviceProcess = false

/** Called by the bot process. CLI subcommands never own the agent server pid. */
export function markServiceProcess(): void {
  serviceProcess = true
}

export function isServiceProcess(): boolean {
  return serviceProcess
}

/** ROADIE_MANAGED=1 (or --managed): the host owns installation and upgrades. */
export function isManagedInstall(): boolean {
  const value = process.env.ROADIE_MANAGED?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export const MANAGED_UPGRADE_MESSAGE =
  'This Roadie install is managed by its host (ROADIE_MANAGED). Upgrade it through the host tooling.'

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// ── Orphan cleanup ───────────────────────────────────────────────────

function pidFilePath(dataDir = getDataDir()): string {
  return path.join(dataDir, AGENT_SERVER_PID_FILE)
}

export function recordAgentServerPid(pid: number, dataDir?: string): void {
  if (!serviceProcess && !dataDir) return
  try {
    writeFileAtomic(pidFilePath(dataDir), `${pid}\n`)
  } catch (error) {
    logger.warn(`Could not record agent server pid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function clearAgentServerPid(pid: number, dataDir?: string): void {
  if (!serviceProcess && !dataDir) return
  const file = pidFilePath(dataDir)
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file)
  } catch {
    // Already gone.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: gone. EPERM: alive but owned by another user, so never our orphan.
    return false
  }
}

/** Command line of a process, or undefined if it cannot be read. */
function readCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
    }
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

/** Pid reuse guard: only an agent server process is ever signalled. */
export function looksLikeAgentServer(commandLine: string | undefined): boolean {
  return !!commandLine && /\bopencode\b/.test(commandLine) && /\bserve\b/.test(commandLine)
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isAlive(pid)
}

/**
 * Stop an agent server left behind by a previous bot process. Returns the pid
 * that was stopped, or undefined when there was nothing to clean up.
 */
export async function cleanupOrphanedAgentServer({
  dataDir,
  graceMs = 5000,
  readCommand = readCommandLine,
}: { dataDir?: string; graceMs?: number; readCommand?: (pid: number) => string | undefined } = {}): Promise<number | undefined> {
  const file = pidFilePath(dataDir)
  let pid: number
  try {
    pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
  } catch {
    return undefined
  }
  const remove = () => fs.rmSync(file, { force: true })
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !isAlive(pid)) {
    remove()
    return undefined
  }
  if (!looksLikeAgentServer(readCommand(pid))) {
    logger.log(`Pid ${pid} from ${AGENT_SERVER_PID_FILE} is not an agent server anymore; leaving it alone`)
    remove()
    return undefined
  }
  logger.log(`Stopping orphaned agent server from a previous run (pid ${pid})`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    remove()
    return undefined
  }
  if (!(await waitForExit(pid, graceMs))) {
    logger.warn(`Orphaned agent server ${pid} ignored SIGTERM, sending SIGKILL`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Exited in between.
    }
    await waitForExit(pid, 1000)
  }
  remove()
  return pid
}

// ── Restart continuation ─────────────────────────────────────────────

export type InterruptedSession = {
  threadId: string
  sessionId: string
  userId?: string
  username?: string
}

type InterruptedFile = {
  version: number
  recordedAt: number
  sessions: InterruptedSession[]
}

function interruptedFilePath(dataDir = getDataDir()): string {
  return path.join(dataDir, INTERRUPTED_FILE)
}

/** Disabled with ROADIE_RESUME_INTERRUPTED=0. */
export function isRestartContinuationEnabled(): boolean {
  const value = process.env.ROADIE_RESUME_INTERRUPTED?.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no')
}

export function recordInterruptedSessions(
  sessions: InterruptedSession[],
  { dataDir, now = Date.now() }: { dataDir?: string; now?: number } = {},
): void {
  // Empty means nothing new to record. Leave any earlier, not yet consumed
  // record alone: a bot stopped again before it was ready never resumed it.
  if (sessions.length === 0 || !isRestartContinuationEnabled()) {
    return
  }
  const file = interruptedFilePath(dataDir)
  const body: InterruptedFile = { version: INTERRUPTED_VERSION, recordedAt: now, sessions }
  writeFileAtomic(file, `${JSON.stringify(body)}\n`)
  logger.log(`Recorded ${sessions.length} interrupted session(s) for restart continuation`)
}

/**
 * Read and delete the interrupted-session record. Consuming is one-shot, so a
 * crash while resuming never replays the same continuation twice.
 */
export function consumeInterruptedSessions({
  dataDir,
  now = Date.now(),
  ttlMs = INTERRUPTED_TTL_MS,
}: { dataDir?: string; now?: number; ttlMs?: number } = {}): { resume: InterruptedSession[]; stale: InterruptedSession[] } {
  const file = interruptedFilePath(dataDir)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { resume: [], stale: [] }
  }
  fs.rmSync(file, { force: true })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn(`Ignoring unreadable ${INTERRUPTED_FILE}`)
    return { resume: [], stale: [] }
  }
  const record = parsed as Partial<InterruptedFile>
  if (record.version !== INTERRUPTED_VERSION || typeof record.recordedAt !== 'number' || !Array.isArray(record.sessions)) {
    logger.warn(`Ignoring ${INTERRUPTED_FILE} with an unknown shape`)
    return { resume: [], stale: [] }
  }
  const sessions = record.sessions.filter((s): s is InterruptedSession => {
    return !!s && typeof s.threadId === 'string' && typeof s.sessionId === 'string'
  })
  const fresh = now - record.recordedAt <= ttlMs && now >= record.recordedAt
  if (!isRestartContinuationEnabled()) return { resume: [], stale: sessions }
  return fresh ? { resume: sessions, stale: [] } : { resume: [], stale: sessions }
}

export const RESTART_CONTINUATION_PROMPT =
  'Roadie restarted while you were working on this, which interrupted your last turn. ' +
  'Continue where you left off. If the work was already finished, say so briefly.'
