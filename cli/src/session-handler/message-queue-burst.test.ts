import { afterEach, expect, test, vi } from 'vitest'
import { MessageQueue } from './message-queue.js'
import * as threadState from './thread-runtime-state.js'
import type { QueuedMessage } from './thread-runtime-state.js'
import type { EventBufferEntry } from './event-stream-state.js'
import { deleteThreadQueueItem } from '../database.js'

vi.mock('../database.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../database.js')>(),
  insertThreadQueueItem: vi.fn(async () => undefined),
  deleteThreadQueueItem: vi.fn(async () => undefined),
}))

const threadId = 'queue-burst-test'
afterEach(() => {
  threadState.removeThread(threadId)
  vi.clearAllMocks()
})

async function enqueueBusy(overrides: Partial<QueuedMessage>[] = [{}, {}, {}]) {
  threadState.ensureThread(threadId)
  threadState.setSessionId(threadId, 'session')
  const events: EventBufferEntry[] = [
    { timestamp: 1, event: { type: 'status', sessionId: 'session', status: { state: 'busy' } } },
  ]
  const dispatchPrompt = vi.fn(async (_input: QueuedMessage) => true)
  const queue = new MessageQueue({
    threadId,
    chat: { platform: 'discord', sendNotice: vi.fn(async () => undefined) } as never,
    isBusy: () => true,
    getEventBuffer: () => events,
    dispatchAction: async (action) => action(),
    markQueueDispatchBusy: vi.fn(),
    markQueueDispatchIdle: vi.fn(),
    dispatchPrompt,
  })
  const sentAt = new Date(Date.now() - 12 * 60_000).toISOString()
  const ids: string[] = []
  for (const [index, override] of overrides.entries()) {
    const result = await queue.enqueueViaLocalQueue({
      prompt: `alert ${index}`, userId: 'bot', username: 'alerts',
      sourceMessageId: `message-${index}`, sourceMessageTimestamp: sentAt,
      sourceThreadId: threadId, ...override,
    })
    ids.push(result.queueId!)
  }
  expect(dispatchPrompt).not.toHaveBeenCalled()
  events.push({ timestamp: 2, event: { type: 'idle', sessionId: 'session' } })
  await queue.tryDrainQueue()
  await vi.waitFor(() => expect(queue.getQueueLength()).toBe(0))
  expect(vi.mocked(deleteThreadQueueItem).mock.calls.map(([id]) => id)).toEqual(ids)
  return { dispatchPrompt, sentAt }
}

test('idle drains consecutive same-author alerts in one attributed prompt and acknowledges every item', async () => {
  const { dispatchPrompt, sentAt } = await enqueueBusy()
  expect(dispatchPrompt).toHaveBeenCalledTimes(1)
  const { prompt } = dispatchPrompt.mock.calls[0]![0]
  for (let index = 0; index < 3; index++) {
    expect(prompt).toContain(`message-id="message-${index}" sent-at="${sentAt}" queued-for="12m"`)
  }
  expect(prompt.indexOf('alert 0')).toBeLessThan(prompt.indexOf('message-id="message-1"'))
  expect(prompt.indexOf('alert 1')).toBeLessThan(prompt.indexOf('message-id="message-2"'))
  expect(prompt).toContain('alert 2')
})

test.each([
  { command: { name: 'review', arguments: 'change' } },
  { model: 'other-model' },
  { agent: 'other-agent' },
  { variant: 'high' },
  { permissions: ['bash:deny'] },
  { images: [{ type: 'file' as const, mime: 'image/png', filename: 'image.png', url: 'https://example.com/image.png' }] },
  { userId: 'other-author' },
  { sourceThreadId: 'other-thread' },
])('keeps incompatible items separate and ordered: %j', async (override) => {
  const { dispatchPrompt } = await enqueueBusy([{}, override, {}])
  expect(dispatchPrompt.mock.calls.map(([input]) => input.prompt)).toEqual(['alert 0', 'alert 1', 'alert 2'])
  expect(dispatchPrompt.mock.calls[1]![0]).toMatchObject(override)
})
