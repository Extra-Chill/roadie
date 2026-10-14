import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

const DEFAULT_EXEC_TIMEOUT_MS = 10_000
/** child_process.exec's default output cap. */
const DEFAULT_MAX_BUFFER = 1024 * 1024
/** Grace between SIGTERM and SIGKILL when a timed-out command is stopped. */
const KILL_GRACE_MS = 2_000

export type ExecAsyncOptions = Pick<SpawnOptions, 'cwd' | 'env'> & {
  timeout?: number
  maxBuffer?: number
}

/**
 * A command ran past its budget. Distinct from a non-zero exit: the command
 * never exited on its own, and the whole process tree it started was stopped.
 */
export class CommandTimeoutError extends Error {
  readonly timeoutMs: number
  readonly command: string
  constructor({ command, timeoutMs }: { command: string; timeoutMs: number }) {
    super(`Command timed out after ${timeoutMs}ms: ${command}`)
    this.name = 'CommandTimeoutError'
    this.command = command
    this.timeoutMs = timeoutMs
  }
}

/** A command that exited non-zero or was killed, shaped like exec's error. */
export type ExecError = Error & {
  code: number | string | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  cmd: string
}

// POSIX children lead their own process group (spawn `detached`; exec and
// execFile ignore that option), so signalling -pid reaches every process the
// command started, not only the shell. Without that a timed-out command kept
// running unreported (#218).
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

export function execAsync(
  command: string | { command: string; args: string[] },
  options: ExecAsyncOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeout || DEFAULT_EXEC_TIMEOUT_MS
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  const commandLabel = typeof command === 'string'
    ? command
    : [command.command, ...command.args].join(' ')
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = typeof command === 'string'
        ? spawn(command, { ...spawnOptions, shell: true })
        : spawn(command.command, command.args, spawnOptions)
    } catch (cause) {
      reject(cause)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const failure = (message: string, extra: Partial<ExecError>): ExecError =>
      Object.assign(new Error(message), { code: null, signal: null, stdout, stderr, cmd: commandLabel, ...extra })

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (stream === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
      if (stdout.length + stderr.length > maxBuffer) {
        signalTree(child, 'SIGTERM')
        settle(() => reject(failure(`${stream} maxBuffer length exceeded: ${commandLabel}`, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })))
      }
    }
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))

    const timer = setTimeout(() => {
      signalTree(child, 'SIGTERM')
      setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE_MS).unref()
      settle(() => reject(new CommandTimeoutError({ command: commandLabel, timeoutMs })))
    }, timeoutMs)

    child.on('error', (cause) => {
      settle(() => reject(failure(cause.message, { code: (cause as NodeJS.ErrnoException).code ?? null })))
    })
    child.on('close', (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }
        const outcome = signal ? `killed by ${signal}` : `exited with ${code}`
        reject(failure(`Command ${outcome}: ${commandLabel}${stderr ? `\n${stderr}` : ''}`, { code, signal }))
      })
    })
  })
}
