import { afterEach, expect, test, vi } from 'vitest'
import { MessageQueue } from './message-queue.js'
import * as threadState from './thread-runtime-state.js'
import type { EventBufferEntry } from './event-stream-state.js'

const threadId = 'pi-queue-policy-test'
afterEach(() => threadState.removeThread(threadId))

test('a pending question keeps queued speaker input local until Pi is idle', async () => {
  threadState.ensureThread(threadId)
  threadState.setSessionId(threadId, 'session')
  const item = { queueId: 'queued', prompt: 'next speaker', userId: 'next', username: 'next' }
  threadState.enqueueItem(threadId, item)
  const events: EventBufferEntry[] = [
    { timestamp: 1, event: { type: 'status', sessionId: 'session', status: { state: 'busy' } } },
    { timestamp: 2, event: { type: 'question.asked', request: {
      id: 'question', sessionId: 'session', questions: [],
    } } },
  ]
  const dispatchPrompt = vi.fn(async () => false)
  const queue = new MessageQueue({
    threadId,
    chat: {} as never,
    isBusy: () => true,
    getEventBuffer: () => events,
    dispatchAction: async (action) => action(),
    markQueueDispatchBusy: vi.fn(),
    markQueueDispatchIdle: vi.fn(),
    dispatchPrompt,
  })
  await queue.tryDrainQueue()
  expect(dispatchPrompt).not.toHaveBeenCalled()
  expect(threadState.getThreadState(threadId)?.queueItems).toEqual([item])

  events.push({ timestamp: 3, event: { type: 'idle', sessionId: 'session' } })
  await queue.tryDrainQueue()
  expect(dispatchPrompt).toHaveBeenCalledWith(item)
})
