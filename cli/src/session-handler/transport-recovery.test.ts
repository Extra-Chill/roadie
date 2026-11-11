import { expect, test, vi } from 'vitest'
import { TransportRecovery } from './transport-recovery.js'

test('notifies each thread once and replays interrupted and queued work on recovery', async () => {
  const gate = new TransportRecovery()
  let recover!: () => void
  const reachable = new Promise<void>((resolve) => { recover = resolve })
  const notices: string[] = []
  const turns: string[] = []
  const failed = vi.fn()
  for (const sessionId of ['one', 'two']) {
    const options = {
      sessionId,
      wait: () => reachable,
      offline: () => { notices.push(`${sessionId}:offline`) },
      online: () => { notices.push(`${sessionId}:online`) },
      resume: async () => { turns.push(`${sessionId}:interrupted`) },
      failed,
    }
    gate.start(options)
    gate.start(options)
    expect(gate.enqueue(sessionId, async () => { turns.push(`${sessionId}:queued`) })).toBe(true)
  }
  expect(notices).toEqual(['one:offline', 'two:offline'])
  expect(turns).toEqual([])
  recover()
  await vi.waitFor(() => expect(turns).toHaveLength(4))
  expect(notices).toEqual(['one:offline', 'two:offline', 'one:online', 'two:online'])
  for (const sessionId of ['one', 'two']) {
    expect(turns.filter((turn) => turn.startsWith(sessionId))).toEqual([`${sessionId}:interrupted`, `${sessionId}:queued`])
    expect(gate.enqueue(sessionId, async () => {})).toBe(false)
  }
  expect(failed).not.toHaveBeenCalled()
  gate.dispose()
})
