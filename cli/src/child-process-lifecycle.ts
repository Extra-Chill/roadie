import { execFileSync, type ChildProcess } from 'node:child_process'
import { processGroupAlive, signalProcessGroup, terminateProcessGroup } from './process-group.js'

/** Own groups, not just their leaders: tools may outlive the shell/Pi process. */
export class ChildProcessLifecycle {
  private groups = new Set<number>()
  private stopping = false

  track<T extends ChildProcess>(child: T): T {
    if (!child.pid) return child
    const pid = child.pid
    // Also prune groups whose last descendant exited after the leader closed.
    for (const group of this.groups) {
      if (!processGroupAlive(group)) this.groups.delete(group)
    }
    this.groups.add(pid)
    child.once('close', () => {
      if (!processGroupAlive(pid)) this.groups.delete(pid)
    })
    // A cleanup callback may race shutdown and launch another command.
    if (this.stopping) signalProcessGroup(pid, 'SIGKILL')
    return child
  }

  /** Pi tools may create separate sessions; capture them before Pi exits. */
  captureDescendants(): void {
    if (process.platform === 'win32') return
    try {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
        encoding: 'utf8', timeout: 1_000, maxBuffer: 4 * 1024 * 1024,
      }).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
      const descendants = new Set(this.groups)
      // A group can survive its leader; its remaining members are still roots.
      for (const [pid, , pgid] of rows) {
        if (this.groups.has(pgid!)) descendants.add(pid!)
      }
      let changed = true
      while (changed) {
        changed = false
        for (const [pid, ppid, pgid] of rows) {
          if (!pid || !ppid || !pgid || descendants.has(pid) || !descendants.has(ppid)) continue
          descendants.add(pid)
          changed = true
          // Only isolated groups led by a descendant are ours to signal.
          if (pid === pgid) this.groups.add(pgid)
        }
      }
    } catch {
      // Minimal hosts without ps still get cleanup of explicitly owned groups.
    }
  }

  forceStop(): void {
    this.captureDescendants()
    this.stopping = true
    for (const pid of this.groups) {
      try {
        signalProcessGroup(pid, 'SIGKILL')
      } catch {
        // Still attempt every other owned group.
      }
    }
  }

  async stop({ graceMs = 5_000, killMs = 500 } = {}): Promise<void> {
    this.captureDescendants()
    this.stopping = true
    await Promise.all([...this.groups].map(async (pid) => {
      try {
        await terminateProcessGroup({ pid }, { graceMs, killMs })
      } finally {
        if (!processGroupAlive(pid)) this.groups.delete(pid)
      }
    }))
  }
}

export const childProcesses = new ChildProcessLifecycle()

/** Single-flight shutdown with a deadline even when a cleanup step never resolves. */
export function createShutdown({
  cleanup,
  children = childProcesses,
  exit = (code: number) => process.exit(code),
  deadlineMs = 10_000,
}: {
  cleanup: () => Promise<void>
  children?: ChildProcessLifecycle
  exit?: (code: number) => void
  deadlineMs?: number
}) {
  let pending: Promise<void> | undefined
  return ({ skipExit = false } = {}): Promise<void> => {
    if (pending) return pending
    const watchdog = setTimeout(() => {
      children.forceStop()
      exit(1)
    }, deadlineMs)
    watchdog.unref()
    pending = (async () => {
      let code = 0
      children.captureDescendants()
      try {
        await cleanup()
      } catch {
        code = 1
      } finally {
        // Let cleanup snapshot interrupted runs and stop the backend gracefully
        // first. The watchdog still kills all groups if cleanup hangs.
        try {
          await children.stop()
        } catch {
          children.forceStop()
          code = 1
        }
        if (!skipExit) exit(code)
        clearTimeout(watchdog)
      }
    })()
    return pending
  }
}
