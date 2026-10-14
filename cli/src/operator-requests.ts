import { randomUUID } from 'node:crypto'

export type OperatorRequest = {
  id: string
  sessionId: string
  argv: string[]
  createdAt: Date
  state: 'pending' | 'approved' | 'denied' | 'expired'
  approverId?: string
}

const requests = new Map<string, OperatorRequest>()
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

function snapshot(request: OperatorRequest): OperatorRequest {
  return { ...request, argv: [...request.argv], createdAt: new Date(request.createdAt) }
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
    !allowedCommands.some((prefix) => prefix.every((part, index) => argv[index] === part))
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
