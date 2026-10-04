import { spawn } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import {
  PROCESS_GROUP_SPAWN_OPTIONS,
  processGroupAlive,
  terminateProcessGroup,
} from './process-group.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Spawn a leader that starts a long-lived child and prints its pid, the shape
// of an agent server that launched a plugin or tool process.
async function spawnLeaderWithChild(script: string) {
  const leader = spawn('sh', ['-c', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    ...PROCESS_GROUP_SPAWN_OPTIONS,
  })
  const childPid = await new Promise<number>((resolve, reject) => {
    let out = ''
    leader.stdout!.on('data', (chunk) => {
      out += chunk
      const line = out.split('\n')[0]
      if (line !== undefined && out.includes('\n')) resolve(Number.parseInt(line, 10))
    })
    leader.once('error', reject)
  })
  return { leader, childPid }
}

describe.skipIf(process.platform === 'win32')('terminateProcessGroup', () => {
  test('stops the leader and the children it spawned', async () => {
    const { leader, childPid } = await spawnLeaderWithChild('sleep 300 & echo $!; wait')
    expect(isAlive(leader.pid!)).toBe(true)
    expect(isAlive(childPid)).toBe(true)

    await expect(terminateProcessGroup(leader)).resolves.toBe(true)

    expect(processGroupAlive(leader.pid!)).toBe(false)
    expect(isAlive(childPid)).toBe(false)
  })

  test('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const { leader, childPid } = await spawnLeaderWithChild(
      "trap '' TERM; sh -c \"trap '' TERM; sleep 300\" & echo $!; wait",
    )

    const started = Date.now()
    await expect(
      terminateProcessGroup(leader, { graceMs: 200, killMs: 2_000 }),
    ).resolves.toBe(true)

    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(isAlive(childPid)).toBe(false)
    expect(processGroupAlive(leader.pid!)).toBe(false)
  })

  // The case stopOpencodeServer relies on: the leader was already stopped (and
  // reaped) by stopOwnedChild, but something it spawned is still running.
  test('stops surviving group members after the leader exited', async () => {
    const { leader, childPid } = await spawnLeaderWithChild(
      'sleep 300 & echo $!; exec sleep 300',
    )
    leader.kill('SIGTERM')
    await new Promise((resolve) => leader.once('exit', resolve))
    expect(isAlive(childPid)).toBe(true)

    await expect(terminateProcessGroup(leader)).resolves.toBe(true)
    expect(isAlive(childPid)).toBe(false)
  })

  test('is a no-op for a process that already exited', async () => {
    const leader = spawn('sh', ['-c', 'exit 0'], { ...PROCESS_GROUP_SPAWN_OPTIONS })
    await new Promise((resolve) => leader.once('exit', resolve))
    await expect(terminateProcessGroup(leader)).resolves.toBe(true)
  })
})
