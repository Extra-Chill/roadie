// One `pi --mode rpc` child process: JSONL commands on stdin, responses and
// events on stdout (docs/rpc.md in @mariozechner/pi-coding-agent).
//
// Framing is strict LF. Node's readline also splits on U+2028/U+2029, which
// are valid inside JSON strings, so records are split by hand.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as errore from 'errore'
import { childProcesses } from '../../child-process-lifecycle.js'
import { createLogger } from '../../logger.js'

const logger = createLogger('PI')
import { PROCESS_GROUP_SPAWN_OPTIONS, terminateProcessGroup } from '../../process-group.js'

export class PiRpcError extends errore.createTaggedError({
  name: 'PiRpcError',
  message: '$detail',
}) {}

/** Any record Pi writes to stdout. Events have no `id`; responses do. */
export type PiRecord = { type: string; [key: string]: unknown }

export type PiResponse = PiRecord & {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export class PiProcessLimitError extends errore.createTaggedError({
  name: 'PiProcessLimitError',
  message: '$detail',
}) {}

/**
 * Global cap on live Roadie-spawned Pi processes (#477). Normal use is one per
 * active session plus a few short-lived probes; anything past the cap is a
 * spawn loop, so it fails clearly instead of running the host out of memory.
 * Configure with ROADIE_PI_MAX_PROCESSES or setPiProcessLimit().
 */
export const DEFAULT_PI_PROCESS_LIMIT = 64

function envProcessLimit(): number | undefined {
  const value = Number(process.env['ROADIE_PI_MAX_PROCESSES'])
  return Number.isInteger(value) && value > 0 ? value : undefined
}

let processLimit: number | undefined
const liveProcesses = new Set<PiProcess>()

/** The cap in force: setPiProcessLimit(), else ROADIE_PI_MAX_PROCESSES, else the default. */
export function piProcessLimit(): number {
  return processLimit ?? envProcessLimit() ?? DEFAULT_PI_PROCESS_LIMIT
}

/** Override the cap (a positive integer); undefined restores the env/default. */
export function setPiProcessLimit(limit: number | undefined): void {
  processLimit = limit !== undefined && Number.isInteger(limit) && limit > 0 ? limit : undefined
}

/** How many Roadie-spawned Pi processes have not exited yet. */
export function livePiProcessCount(): number {
  return liveProcesses.size
}

export type PiProcessOptions = {
  bin: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

/** Split a growing buffer into complete LF-terminated records. */
export function splitRecords(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = []
  let start = 0
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n', start)) {
    const line = buffer.slice(start, i).replace(/\r$/, '')
    if (line) lines.push(line)
    start = i + 1
  }
  return { lines, rest: buffer.slice(start) }
}

export class PiProcess {
  readonly child: ChildProcessWithoutNullStreams
  private buffer = ''
  private nextId = 0
  private pending = new Map<string, (response: PiResponse) => void>()
  private listeners = new Set<(record: PiRecord) => void>()
  private exitListeners = new Set<(code: number | null) => void>()
  private stderrTail = ''
  private stderrBuffer = ''
  exited = false
  /** Set by kill(); resolves once the process has exited. */
  private stopping?: Promise<void>
  /** Usable: not exited and not being stopped. */
  get running(): boolean { return !this.exited && !this.stopping }

  /**
   * Start a Pi process, unless the global cap is reached: then return a
   * PiProcessLimitError and start nothing.
   */
  static spawn(options: PiProcessOptions): PiProcess | PiProcessLimitError {
    const limit = piProcessLimit()
    if (liveProcesses.size >= limit) {
      logger.warn(`Refusing to start pi: ${liveProcesses.size} Pi processes already running (limit ${limit}, ROADIE_PI_MAX_PROCESSES)`)
      return new PiProcessLimitError({
        detail: `Too many Pi processes running (${liveProcesses.size}, limit ${limit}); not starting another. Raise ROADIE_PI_MAX_PROCESSES if this is expected.`,
      })
    }
    return new PiProcess(options)
  }

  private constructor(options: PiProcessOptions) {
    this.child = childProcesses.track(spawn(options.bin, ['--mode', 'rpc', ...options.args], {
      ...PROCESS_GROUP_SPAWN_OPTIONS,
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
    liveProcesses.add(this)
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
      const { lines, rest } = splitRecords(this.stderrBuffer + chunk)
      this.stderrBuffer = rest
      for (const line of lines) {
        if (line.includes('[roadie-mcp]')) logger.warn(line)
      }
    })
    this.child.stderr.on('end', () => {
      if (this.stderrBuffer.includes('[roadie-mcp]')) logger.warn(this.stderrBuffer)
      this.stderrBuffer = ''
    })
    const gone = (code: number | null, why?: string) => {
      if (this.exited) return
      this.exited = true
      liveProcesses.delete(this)
      const reason = why ?? `pi exited with code ${code}${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ''}`
      for (const resolve of this.pending.values()) {
        resolve({ type: 'response', command: 'unknown', success: false, error: reason })
      }
      this.pending.clear()
      for (const listener of this.exitListeners) listener(code)
    }
    this.child.on('exit', (code) => gone(code))
    // A spawn failure (ENOENT) emits error and never exit.
    this.child.on('error', (error) => {
      if (this.child.pid === undefined) gone(null, `could not start pi: ${error.message}`)
    })
    // A write after exit raises EPIPE asynchronously; requests already resolve on exit.
    this.child.stdin.on('error', () => {})
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  private onData(chunk: string) {
    const { lines, rest } = splitRecords(this.buffer + chunk)
    this.buffer = rest
    for (const line of lines) {
      let record: PiRecord
      try {
        record = JSON.parse(line) as PiRecord
      } catch {
        continue
      }
      if (record.type === 'response' && typeof record.id === 'string') {
        const resolve = this.pending.get(record.id)
        if (resolve) {
          this.pending.delete(record.id)
          resolve(record as PiResponse)
          continue
        }
      }
      for (const listener of this.listeners) listener(record)
    }
  }

  /** Every non-response record (events, extension UI requests). */
  onRecord(listener: (record: PiRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.add(listener)
  }

  /** Fire-and-forget write (extension UI responses). */
  send(record: Record<string, unknown>): void {
    if (this.exited) return
    this.child.stdin.write(`${JSON.stringify(record)}\n`)
  }

  /**
   * Send a command and wait for its response. A failed response becomes an
   * error. With `timeoutMs`, a response that does not arrive in time becomes
   * an error too (the process is left to the caller to kill).
   */
  async request<T = unknown>(
    command: Record<string, unknown> & { type: string },
    { timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<T | PiRpcError> {
    if (!this.running) return new PiRpcError({ detail: `pi is not running (${command.type})` })
    const id = `roadie-${++this.nextId}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const response = await new Promise<PiResponse>((resolve) => {
      this.pending.set(id, resolve)
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          resolve({ type: 'response', command: command.type, success: false, error: `pi did not answer ${command.type} within ${timeoutMs}ms` })
        }, timeoutMs)
        timer.unref?.()
      }
      this.send({ ...command, id })
    })
    clearTimeout(timer)
    if (!response.success) {
      return new PiRpcError({ detail: response.error || `pi rejected ${command.type}` })
    }
    return response.data as T
  }

  /**
   * SIGTERM, then SIGKILL if pi is still up after `graceMs`. Resolves once it
   * has exited, so its session file is no longer being written.
   */
  kill({ graceMs = 3_000 }: { graceMs?: number } = {}): Promise<void> {
    if (!this.stopping) {
      childProcesses.captureDescendants()
      this.stopping = terminateProcessGroup(this.child, { graceMs }).then(() => {})
    }
    return this.stopping
  }
}
