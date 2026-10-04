// Process-group lifecycle for the agent server.
//
// The agent server spawns children of its own (plugins, tools, language
// tooling). Signalling only the server's pid leaves those children running,
// still writing into the data directory after "stop" returned. On POSIX the
// server is therefore spawned as the leader of its own process group, and
// stopping it signals the whole group and waits until the group is gone.

import type { ChildProcess } from 'node:child_process'

const POSIX = process.platform !== 'win32'

/** Spawn option: make the child the leader of a new process group (POSIX). */
export const PROCESS_GROUP_SPAWN_OPTIONS = { detached: POSIX } as const

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH'
}

/**
 * Signal the process group led by `pid` (POSIX), or the pid itself where groups
 * are unavailable. Returns false when nothing was left to signal.
 *
 * On POSIX this deliberately never falls back to the bare pid: once the leader
 * has exited its pid may be reused by an unrelated process, whereas a group id
 * stays reserved for as long as any member is alive.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (POSIX) {
    try {
      process.kill(-pid, signal)
      return true
    } catch (error) {
      if (isMissingProcess(error)) return false
      throw error
    }
  }
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    if (isMissingProcess(error)) return false
    throw error
  }
}

/** True while any process in the group led by `pid` (POSIX), or the pid, is alive. */
export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(POSIX ? -pid : pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return !isMissingProcess(error)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/**
 * Stop a process and every process in its group: SIGTERM the group, wait up to
 * `graceMs`, then SIGKILL whatever is left and wait up to `killMs` more.
 * Resolves true once the group is gone, false if it outlived both bounds.
 */
export async function terminateProcessGroup(
  child: Pick<ChildProcess, 'pid'>,
  { graceMs = 5_000, killMs = 2_000 }: { graceMs?: number; killMs?: number } = {},
): Promise<boolean> {
  const pid = child.pid
  if (!pid) return true
  if (!signalProcessGroup(pid, 'SIGTERM')) return true
  if (await waitUntil(() => !processGroupAlive(pid), graceMs)) return true
  signalProcessGroup(pid, 'SIGKILL')
  return waitUntil(() => !processGroupAlive(pid), killMs)
}
