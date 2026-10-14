import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'
import type { InterruptedSession } from './service-lifecycle.js'

const logger = createLogger(LogPrefix.CLI)

/** Where the approval prompt was posted: a message in the requesting session's thread. */
export type OperatorRequestPrompt = { threadId: string; messageId: string }

export type OperatorRequest = {
  id: string
  sessionId: string
  argv: string[]
  createdAt: Date
  state: 'pending' | 'approved' | 'denied' | 'expired'
  approverId?: string
  prompt?: OperatorRequestPrompt
}

/** What an approved request ended with, posted on its prompt. */
export type OperatorRequestOutcome = { exitCode: number; output: string } | { interrupted: true }

const requests = new Map<string, OperatorRequest>()
// Approved and still running. Mirrored to disk so a restart that drops one is
// reported as interrupted rather than left looking approved.
const running = new Map<string, OperatorRequest>()
// Sessions whose approved command restarts Roadie (`upgrade`): the restart's
// continuation tells them it followed their command.
const restartFollowUps = new Map<string, { threadId: string; argv: string[]; exitCode: number; at: number }>()
const finishListeners = new Set<(request: OperatorRequest, outcome: OperatorRequestOutcome) => Promise<void> | void>()
const waiters = new Map<string, Set<(request: OperatorRequest) => void>>()
const listeners = new Set<(request: OperatorRequest) => void>()
const allowedCommands = [
  ['credentials', 'list'],
  ['credentials', 'remove'],
  ['credentials', 'import-subrouter'],
  ['credentials', 'import-opencode'],
  ['credentials', 'rotation', 'set'],
  ['credentials', 'client', 'list'],
  ['upgrade'],
] as const

export function isAllowedOperatorCommand(argv: string[]): boolean {
  // The bot runs `upgrade` itself, so only its one flag is meaningful.
  if (argv[0] === 'upgrade') return argv.slice(1).every((arg) => arg === '--skip-restart')
  return allowedCommands.some((prefix) => prefix.every((part, index) => argv[index] === part))
}

function snapshot(request: OperatorRequest): OperatorRequest {
  return {
    ...request,
    argv: [...request.argv],
    createdAt: new Date(request.createdAt),
    ...(request.prompt ? { prompt: { ...request.prompt } } : {}),
  }
}

function notify(request: OperatorRequest): void {
  for (const waiter of waiters.get(request.id) ?? []) waiter(snapshot(request))
  waiters.delete(request.id)
  requests.delete(request.id)
}

/** Only these non-interactive operator subcommands may cross the agent-to-operator boundary. */
export function createOperatorRequest({
  sessionId,
  argv,
}: {
  sessionId: string
  argv: string[]
}): OperatorRequest {
  if (
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    !Array.isArray(argv) ||
    !argv.length ||
    !argv.every((arg) => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')) ||
    !isAllowedOperatorCommand(argv)
  ) {
    throw new Error('Invalid operator request: command is not allowed')
  }
  const request: OperatorRequest = {
    id: randomUUID(),
    sessionId,
    argv: [...argv],
    createdAt: new Date(),
    state: 'pending',
  }
  requests.set(request.id, request)
  // Let the HTTP handler register its decision waiter before a listener can decide.
  queueMicrotask(() => {
    if (requests.has(request.id)) {
      for (const listener of listeners) listener(snapshot(request))
    }
  })
  return snapshot(request)
}

export function onOperatorRequestCreated(listener: (request: OperatorRequest) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function decideOperatorRequest({
  id,
  decision,
  approverId,
}: {
  id: string
  decision: 'approve' | 'deny'
  approverId: string
}): OperatorRequest {
  const request = requests.get(id)
  if (!request) throw new Error('Operator request not found')
  if (request.state !== 'pending') throw new Error('Operator request has already been decided')
  if (decision !== 'approve' && decision !== 'deny') throw new Error('Invalid operator decision')
  if (typeof approverId !== 'string' || !approverId.trim()) throw new Error('Approver ID is required')
  request.state = decision === 'approve' ? 'approved' : 'denied'
  request.approverId = approverId
  if (request.state === 'approved') {
    running.set(request.id, request)
    persistRunning()
  }
  notify(request)
  return snapshot(request)
}

/** Expire a still-pending request when its agent disconnects. */
export function expireOperatorRequest(id: string): void {
  const request = requests.get(id)
  if (!request || request.state !== 'pending') return
  request.state = 'expired'
  notify(request)
}

export function waitForOperatorDecision(
  id: string,
  { timeoutMs }: { timeoutMs: number },
): Promise<OperatorRequest> {
  const request = requests.get(id)
  if (!request) return Promise.reject(new Error('Operator request not found'))
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error('Invalid timeout'))
  if (request.state !== 'pending') return Promise.resolve(snapshot(request))
  return new Promise((resolve) => {
    const waiting = waiters.get(id) ?? new Set<(request: OperatorRequest) => void>()
    waiters.set(id, waiting)
    const timer = setTimeout(() => {
      waiting.delete(done)
      if (request.state === 'pending') {
        expireOperatorRequest(id)
      }
      resolve(snapshot(request))
    }, timeoutMs)
    const done = (result: OperatorRequest) => {
      clearTimeout(timer)
      resolve(result)
    }
    waiting.add(done)
  })
}

/** Record where the approval prompt was posted, so the outcome can be shown on it. */
export function attachOperatorRequestPrompt(id: string, prompt: OperatorRequestPrompt): void {
  const request = requests.get(id) ?? running.get(id)
  if (!request) return
  request.prompt = { ...prompt }
  if (running.has(id)) persistRunning()
}

export function onOperatorRequestFinished(
  listener: (request: OperatorRequest, outcome: OperatorRequestOutcome) => Promise<void> | void,
): () => void {
  finishListeners.add(listener)
  return () => finishListeners.delete(listener)
}

const FINISH_POST_TIMEOUT_MS = 10_000

async function postOutcome(request: OperatorRequest, outcome: OperatorRequestOutcome): Promise<void> {
  const posts = [...finishListeners].map(async (listener) => listener(snapshot(request), outcome))
  const settled = Promise.allSettled(posts).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') logger.warn(`Could not post operator request outcome: ${String(result.reason)}`)
    }
  })
  let timer: NodeJS.Timeout | undefined
  await Promise.race([settled, new Promise((resolve) => { timer = setTimeout(resolve, FINISH_POST_TIMEOUT_MS) })])
  clearTimeout(timer)
}

/**
 * An approved request finished. Resolves once the outcome is posted (bounded),
 * so a command that restarts Roadie can post its result before the restart.
 * `restarts` registers the requesting session for the restart's continuation.
 */
export async function finishOperatorRequest(
  id: string,
  outcome: { exitCode: number; output: string },
  { restarts = false, now = Date.now() }: { restarts?: boolean; now?: number } = {},
): Promise<void> {
  const request = running.get(id)
  if (!request) return
  if (restarts && request.prompt) {
    restartFollowUps.set(request.sessionId, {
      threadId: request.prompt.threadId,
      argv: [...request.argv],
      exitCode: outcome.exitCode,
      at: now,
    })
  }
  await postOutcome(request, outcome)
  running.delete(id)
  persistRunning()
}

function commandText(argv: string[]): string {
  return `roadie ${argv.join(' ')}`
}

// A host upgrade can take a while before it restarts Roadie; past this, a
// restart is unrelated to the command.
export const RESTART_FOLLOW_UP_TTL_MS = 60 * 60 * 1000

/**
 * Restart continuations owed to operator requests, recorded on graceful
 * shutdown: sessions whose approved command was still running (interrupted,
 * not completed) and sessions whose approved command restarts Roadie.
 */
export function operatorRequestContinuations(now = Date.now()): InterruptedSession[] {
  const sessions: InterruptedSession[] = []
  for (const request of running.values()) {
    if (!request.prompt) continue
    sessions.push({
      threadId: request.prompt.threadId,
      sessionId: request.sessionId,
      note: `Your approved operator command \`${commandText(request.argv)}\` was still running when Roadie restarted. ` +
        'It was interrupted and did not complete; check its effect before relying on it.',
    })
  }
  for (const [sessionId, followUp] of restartFollowUps) {
    if (now - followUp.at > RESTART_FOLLOW_UP_TTL_MS) continue
    sessions.push({
      threadId: followUp.threadId,
      sessionId,
      note: `This restart followed your approved operator command \`${commandText(followUp.argv)}\`, which exited ${followUp.exitCode}.`,
    })
  }
  return sessions
}

// ── Persistence of approved, running requests ─────────────────────────

const RUNNING_FILE = 'operator-requests-running.json'
const RUNNING_VERSION = 1

type PersistedRequest = { id: string; sessionId: string; argv: string[]; approverId?: string; prompt?: OperatorRequestPrompt }

function runningFilePath(dataDir = getDataDir()): string {
  return path.join(dataDir, RUNNING_FILE)
}

function persistRunning(): void {
  try {
    const file = runningFilePath()
    if (running.size === 0) {
      fs.rmSync(file, { force: true })
      return
    }
    const requests: PersistedRequest[] = [...running.values()].map(({ id, sessionId, argv, approverId, prompt }) => ({
      id, sessionId, argv, approverId, prompt,
    }))
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ version: RUNNING_VERSION, requests })}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    logger.warn(`Could not persist running operator requests: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Read and delete the approved requests a previous process never finished.
 * Called once at startup: each was interrupted by a restart or crash.
 */
export function consumeInterruptedOperatorRequests({ dataDir }: { dataDir?: string } = {}): PersistedRequest[] {
  const file = runningFilePath(dataDir)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  fs.rmSync(file, { force: true })
  try {
    const parsed = JSON.parse(raw) as { version?: number; requests?: unknown }
    if (parsed.version !== RUNNING_VERSION || !Array.isArray(parsed.requests)) return []
    return parsed.requests.filter((entry): entry is PersistedRequest => {
      const r = entry as PersistedRequest
      return !!r && typeof r.id === 'string' && typeof r.sessionId === 'string' && Array.isArray(r.argv)
    })
  } catch {
    logger.warn(`Ignoring unreadable ${RUNNING_FILE}`)
    return []
  }
}
