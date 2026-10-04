import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import {
  cleanupOrphanedAgentServer,
  clearAgentServerPid,
  consumeInterruptedSessions,
  hostUpgradeHandler,
  INTERRUPTED_TTL_MS,
  isManagedInstall,
  looksLikeAgentServer,
  recordAgentServerPid,
  recordInterruptedSessions,
  runHostUpgrade,
} from './service-lifecycle.js'
import { addFilter, resetHooks } from './hooks.js'
import { loadPlugins } from './plugins.js'

const children: ChildProcess[] = []
const savedEnv = { ...process.env }
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  resetHooks()
  for (const key of ['ROADIE_MANAGED', 'ROADIE_RESUME_INTERRUPTED']) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-lifecycle-'))
}

/** A long-lived process whose command line reads like `... opencode serve`. */
function spawnIdle(extraArgs: string[]): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...extraArgs], { stdio: 'ignore' })
  children.push(child)
  return child
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('managed install', () => {
  test('ROADIE_MANAGED turns it on', () => {
    delete process.env.ROADIE_MANAGED
    expect(isManagedInstall()).toBe(false)
    process.env.ROADIE_MANAGED = '1'
    expect(isManagedInstall()).toBe(true)
    process.env.ROADIE_MANAGED = '0'
    expect(isManagedInstall()).toBe(false)
  })
})

describe('host upgrade', () => {
  test('a managed install uses the handler a plugin registers', async () => {
    process.env.ROADIE_MANAGED = '1'
    expect(hostUpgradeHandler()).toBeNull()
    const dir = tempDir()
    const plugin = path.join(dir, 'host.mjs')
    fs.writeFileSync(
      plugin,
      `export function register(roadie) {
        roadie.addFilter('host_upgrade', () => async ({ trigger }) => ({ ok: true, message: 'started via ' + trigger }))
      }`,
    )
    expect(await loadPlugins([plugin])).toEqual([plugin])
    const handler = hostUpgradeHandler()
    expect(handler).not.toBeNull()
    expect(await runHostUpgrade(handler!, 'command')).toEqual({ ok: true, message: 'started via command' })
  })

  test('an unmanaged install never uses a host handler', () => {
    delete process.env.ROADIE_MANAGED
    addFilter('host_upgrade', () => async () => ({ ok: true, message: 'x' }))
    expect(hostUpgradeHandler()).toBeNull()
  })

  test('a non-function filter value means no handler', () => {
    process.env.ROADIE_MANAGED = '1'
    addFilter('host_upgrade', () => 'not a handler' as never)
    expect(hostUpgradeHandler()).toBeNull()
  })

  test('a throwing or malformed handler becomes a failed result', async () => {
    const thrown = await runHostUpgrade(async () => {
      throw new Error('sudo: a password is required')
    }, 'cli')
    expect(thrown).toEqual({ ok: false, message: 'Host upgrade failed: sudo: a password is required' })
    const empty = await runHostUpgrade((async () => undefined) as never, 'cli')
    expect(empty.ok).toBe(false)
  })
})

describe('orphan cleanup', () => {
  test('matches agent server command lines only', () => {
    expect(looksLikeAgentServer('/usr/bin/node /x/opencode-ai/bin/opencode serve --port 4096')).toBe(true)
    expect(looksLikeAgentServer('sleep 100')).toBe(false)
    expect(looksLikeAgentServer(undefined)).toBe(false)
  })

  test('stops a recorded agent server left by a previous run', async () => {
    const dataDir = tempDir()
    const orphan = spawnIdle(['opencode', 'serve'])
    await new Promise((resolve) => setTimeout(resolve, 200))
    recordAgentServerPid(orphan.pid!, dataDir)

    const stopped = await cleanupOrphanedAgentServer({ dataDir, graceMs: 2000 })
    expect(stopped).toBe(orphan.pid)
    expect(alive(orphan.pid!)).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'agent-server.pid'))).toBe(false)
  })

  test('leaves a reused pid that is not an agent server alone', async () => {
    const dataDir = tempDir()
    const unrelated = spawnIdle(['something-else'])
    await new Promise((resolve) => setTimeout(resolve, 200))
    recordAgentServerPid(unrelated.pid!, dataDir)

    expect(await cleanupOrphanedAgentServer({ dataDir })).toBeUndefined()
    expect(alive(unrelated.pid!)).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'agent-server.pid'))).toBe(false)
  })

  test('a dead or missing pid is a no-op', async () => {
    const dataDir = tempDir()
    expect(await cleanupOrphanedAgentServer({ dataDir })).toBeUndefined()
    fs.writeFileSync(path.join(dataDir, 'agent-server.pid'), '999999999\n')
    expect(await cleanupOrphanedAgentServer({ dataDir })).toBeUndefined()
    expect(fs.existsSync(path.join(dataDir, 'agent-server.pid'))).toBe(false)
  })

  test('a clean exit clears only its own pid', () => {
    const dataDir = tempDir()
    recordAgentServerPid(1234, dataDir)
    clearAgentServerPid(5678, dataDir)
    expect(fs.readFileSync(path.join(dataDir, 'agent-server.pid'), 'utf8').trim()).toBe('1234')
    clearAgentServerPid(1234, dataDir)
    expect(fs.existsSync(path.join(dataDir, 'agent-server.pid'))).toBe(false)
  })
})

describe('restart continuation record', () => {
  const session = { threadId: 't1', sessionId: 's1', userId: 'u1', username: 'Team Member' }

  test('a fresh record resumes once', () => {
    const dataDir = tempDir()
    recordInterruptedSessions([session], { dataDir, now: 1000 })
    expect(consumeInterruptedSessions({ dataDir, now: 2000 })).toEqual({ resume: [session], stale: [] })
    expect(consumeInterruptedSessions({ dataDir, now: 2000 })).toEqual({ resume: [], stale: [] })
  })

  test('a record older than the TTL is reported, not resumed', () => {
    const dataDir = tempDir()
    recordInterruptedSessions([session], { dataDir, now: 1000 })
    expect(consumeInterruptedSessions({ dataDir, now: 1000 + INTERRUPTED_TTL_MS + 1 })).toEqual({ resume: [], stale: [session] })
  })

  test('an empty snapshot keeps an unconsumed record', () => {
    const dataDir = tempDir()
    recordInterruptedSessions([session], { dataDir, now: 1000 })
    recordInterruptedSessions([], { dataDir, now: 1500 })
    expect(consumeInterruptedSessions({ dataDir, now: 2000 }).resume).toEqual([session])
  })

  test('ROADIE_RESUME_INTERRUPTED=0 disables resuming', () => {
    const dataDir = tempDir()
    process.env.ROADIE_RESUME_INTERRUPTED = '0'
    recordInterruptedSessions([session], { dataDir, now: 1000 })
    expect(fs.existsSync(path.join(dataDir, 'interrupted-sessions.json'))).toBe(false)
  })

  test('a corrupt record is dropped', () => {
    const dataDir = tempDir()
    fs.writeFileSync(path.join(dataDir, 'interrupted-sessions.json'), '{nope')
    expect(consumeInterruptedSessions({ dataDir })).toEqual({ resume: [], stale: [] })
    expect(fs.existsSync(path.join(dataDir, 'interrupted-sessions.json'))).toBe(false)
  })
})
