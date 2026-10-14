// execAsync stops the whole process tree on timeout and reports it as a
// timeout, never as an exit (#218).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { CommandTimeoutError, execAsync } from './exec-async.js'
import { runShellCommand } from './commands/run-command.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

describe.skipIf(process.platform === 'win32')('execAsync timeout', () => {
  test('rejects with CommandTimeoutError and stops grandchildren', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-async-'))
    const pidFile = path.join(dir, 'grandchild.pid')
    // The shell backgrounds a long sleep (a grandchild of Roadie) and waits:
    // signalling only the shell would leave the sleep running.
    const command = `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`
    const error = await execAsync(command, { timeout: 500 }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(CommandTimeoutError)
    expect((error as CommandTimeoutError).timeoutMs).toBe(500)
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(grandchild).toBeGreaterThan(0)
    expect(await waitFor(() => !isAlive(grandchild))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a command that finishes in time resolves with its output', async () => {
    const result = await execAsync('echo out; echo err >&2', { timeout: 5_000 })
    expect(result.stdout.trim()).toBe('out')
    expect(result.stderr.trim()).toBe('err')
  })

  test('a non-zero exit is still an exit, not a timeout', async () => {
    const error = await execAsync('exit 3', { timeout: 5_000 }).catch((cause: unknown) => cause)
    expect(error).not.toBeInstanceOf(CommandTimeoutError)
    expect((error as { code?: number }).code).toBe(3)
  })
})

describe.skipIf(process.platform === 'win32')('runShellCommand', () => {
  test('reports a timeout as stopped, not as exit 1', async () => {
    const result = await runShellCommand({ command: 'sleep 30', directory: os.tmpdir(), timeoutMs: 300 })
    expect(result).toBe('`sleep 30` timed out after 300ms and was stopped')
    expect(result).not.toContain('exited with')
  })

  test('reports the real exit code and output', async () => {
    const result = await runShellCommand({ command: 'echo nope; exit 4', directory: os.tmpdir() })
    expect(result.startsWith('`echo nope; exit 4` exited with 4')).toBe(true)
    expect(result).toContain('nope')
  })

  test('a successful command reports exit 0', async () => {
    expect(await runShellCommand({ command: 'true', directory: os.tmpdir() })).toBe('`true` exited with 0')
  })
})
