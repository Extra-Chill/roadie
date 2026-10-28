// One `pi --mode rpc` child process: JSONL commands on stdin, responses and
// events on stdout (docs/rpc.md in @mariozechner/pi-coding-agent).
//
// Framing is strict LF. Node's readline also splits on U+2028/U+2029, which
// are valid inside JSON strings, so records are split by hand.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as errore from 'errore'
import { childProcesses } from '../../child-process-lifecycle.js'
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
  exited = false

  constructor(options: PiProcessOptions) {
    this.child = childProcesses.track(spawn(options.bin, ['--mode', 'rpc', ...options.args], {
      ...PROCESS_GROUP_SPAWN_OPTIONS,
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    this.child.on('exit', (code) => {
      this.exited = true
      const reason = `pi exited with code ${code}${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ''}`
      for (const resolve of this.pending.values()) {
        resolve({ type: 'response', command: 'unknown', success: false, error: reason })
      }
      this.pending.clear()
      for (const listener of this.exitListeners) listener(code)
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

  /** Send a command and wait for its response. A failed response becomes an error. */
  async request<T = unknown>(command: Record<string, unknown> & { type: string }): Promise<T | PiRpcError> {
    if (this.exited) return new PiRpcError({ detail: `pi is not running (${command.type})` })
    const id = `roadie-${++this.nextId}`
    const response = await new Promise<PiResponse>((resolve) => {
      this.pending.set(id, resolve)
      this.send({ ...command, id })
    })
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
    childProcesses.captureDescendants()
    return terminateProcessGroup(this.child, { graceMs }).then(() => {})
  }
}
