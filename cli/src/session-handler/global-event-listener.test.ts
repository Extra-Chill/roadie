// The global listener consumes events through the agent backend seam, so a
// fake provider fully drives it: no OpenCode server involved.

import { afterEach, describe, expect, test } from 'vitest'
import type { AgentBackendEvent, AgentBackendProvider } from '../agent-backend/types.js'
import { setAgentBackendProvider } from '../agent-backend/registry.js'
import {
  disposeGlobalEventListener,
  registerEventListener,
  waitForGlobalEventListener,
} from './global-event-listener.js'

type Stream = {
  push(event: AgentBackendEvent): void
  iterable: AsyncIterable<AgentBackendEvent>
}

/** An event stream that stays open until its signal aborts. */
function openStream(signal: AbortSignal): Stream {
  const queue: AgentBackendEvent[] = []
  let wake: (() => void) | undefined
  signal.addEventListener('abort', () => wake?.(), { once: true })
  return {
    push(event) {
      queue.push(event)
      wake?.()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = queue.shift()
          if (next) {
            yield next
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    },
  }
}

function fakeProvider() {
  const streams: Stream[] = []
  let started: ((info: { description: string }) => void) | undefined
  const provider: AgentBackendProvider = {
    id: 'fake',
    getBackend: () => null,
    initializeForDirectory: async () => new Error('unused'),
    subscribeEvents: ({ signal }) => {
      const stream = openStream(signal)
      streams.push(stream)
      return Promise.resolve(stream.iterable)
    },
    onStarted: (listener) => {
      started = listener
    },
  }
  return { provider, streams, restart: () => started?.({ description: 'fake backend' }) }
}

const event = (id: string) => ({ type: 'session.idle', properties: { sessionID: id } }) as unknown as AgentBackendEvent

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

let restoreProvider: (() => void) | undefined
afterEach(() => {
  disposeGlobalEventListener()
  restoreProvider?.()
})

describe('global event listener over the backend seam', () => {
  test('broadcasts backend events to every registered runtime', async () => {
    const fake = fakeProvider()
    restoreProvider = setAgentBackendProvider(fake.provider)
    const a: AgentBackendEvent[] = []
    const b: AgentBackendEvent[] = []
    registerEventListener('thread-a', (e) => a.push(e))
    registerEventListener('thread-b', (e) => b.push(e))
    await waitForGlobalEventListener()

    fake.streams[0]!.push(event('ses_1'))
    await until(() => a.length === 1 && b.length === 1)
    expect(a[0]).toEqual(event('ses_1'))
  })

  test('reconnects with a fresh stream when the backend restarts', async () => {
    const fake = fakeProvider()
    restoreProvider = setAgentBackendProvider(fake.provider)
    const seen: AgentBackendEvent[] = []
    registerEventListener('thread-a', (e) => seen.push(e))
    await waitForGlobalEventListener()
    expect(fake.streams).toHaveLength(1)

    fake.restart()
    await until(() => fake.streams.length === 2)
    fake.streams[1]!.push(event('ses_after_restart'))
    await until(() => seen.length === 1)
    expect(seen[0]).toEqual(event('ses_after_restart'))
  })
})
