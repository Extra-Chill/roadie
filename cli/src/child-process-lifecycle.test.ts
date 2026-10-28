import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { ChildProcessLifecycle, createShutdown } from './child-process-lifecycle.js'
import { PROCESS_GROUP_SPAWN_OPTIONS, processGroupAlive } from './process-group.js'

const owners: ChildProcessLifecycle[] = []
afterEach(() => {
  for (const owner of owners) owner.forceStop()
  owners.length = 0
  vi.useRealTimers()
})

function owner() {
  const children = new ChildProcessLifecycle()
  owners.push(children)
  return children
}

test.skipIf(process.platform === 'win32')('shutdown drains a shell and sleeping grandchild, then exits once', async () => {
  const children = owner()
  // Reap the grandchild on TERM so this test also works without an init reaper.
  const child = children.track(spawn('sh', ['-c', 'sleep 300 & kid=$!; trap "wait $kid; exit 0" TERM; echo $kid; wait'], {
    ...PROCESS_GROUP_SPAWN_OPTIONS,
    stdio: ['ignore', 'pipe', 'ignore'],
  }))
  const [data] = await once(child.stdout!, 'data')
  const grandchild = Number(String(data).trim())
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  try {
    const cleanup = vi.fn(async () => {})
    const shutdown = createShutdown({ cleanup, children })
    const started = Date.now()
    const first = shutdown()
    expect(shutdown()).toBe(first)
    await first
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(processGroupAlive(child.pid!)).toBe(false)
    expect(() => process.kill(grandchild, 0)).toThrow()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  } finally {
    exit.mockRestore()
  }
}, 10_000)

test.skipIf(process.platform === 'win32')('captures detached tool groups before cleanup exits their parent', async () => {
  const children = owner()
  const child = children.track(spawn(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const tool = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    console.log(tool.pid);
    setInterval(() => {}, 1000);
  `], { ...PROCESS_GROUP_SPAWN_OPTIONS, stdio: ['ignore', 'pipe', 'ignore'] }))
  const [data] = await once(child.stdout!, 'data')
  const toolPid = Number(String(data).trim())
  const exit = vi.fn()
  await createShutdown({ children, exit, cleanup: async () => {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
    expect(processGroupAlive(toolPid)).toBe(true)
  } })()
  expect(processGroupAlive(toolPid)).toBe(false)
  expect(exit).toHaveBeenCalledExactlyOnceWith(0)
})

test('deadline force-stops children and exits when cleanup hangs', async () => {
  vi.useFakeTimers()
  const children = owner()
  const force = vi.spyOn(children, 'forceStop')
  const exit = vi.fn()
  const shutdown = createShutdown({ children, exit, cleanup: () => new Promise(() => {}) })
  void shutdown()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(force).toHaveBeenCalledOnce()
  expect(exit).toHaveBeenCalledExactlyOnceWith(1)
})

test('failed cleanup still drains children and exits with failure', async () => {
  const children = owner()
  const stop = vi.spyOn(children, 'stop')
  const exit = vi.fn()
  await createShutdown({ children, exit, cleanup: async () => { throw new Error('failed') } })()
  expect(stop).toHaveBeenCalledOnce()
  expect(exit).toHaveBeenCalledExactlyOnceWith(1)
})

test.skipIf(process.platform === 'win32')('escalates even when a group leader has already exited', async () => {
  const children = owner()
  const child = children.track(spawn('sh', ['-c', "trap '' TERM; sleep 300 & echo $!; exit 0"], {
    ...PROCESS_GROUP_SPAWN_OPTIONS,
    stdio: ['ignore', 'pipe', 'ignore'],
  }))
  await once(child.stdout!, 'data')
  await once(child, 'exit')
  expect(processGroupAlive(child.pid!)).toBe(true)
  await children.stop({ graceMs: 100, killMs: 100 })
  expect(processGroupAlive(child.pid!)).toBe(false)
})
