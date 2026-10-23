// Per-thread ingress reservation: keeps Discord arrival order for one-shot
// slash calls and messages that must run behind each other.

import { AsyncLocalStorage } from 'node:async_hooks'

// Per-thread FIFO for Discord arrival order of one-shot slash calls vs messages.
// Covers /plan-agent (no prompt) and /foo-cmd /foo-skill. Pi already
// queues promptAsync. /model, /agent, and /compact are not on this queue.
const threadIngressChains = new Map<string, Promise<void>>()
const threadIngressSlotAls = new AsyncLocalStorage<ThreadIngressSlot | undefined>()

export type ThreadIngressSlot = {
  wait: Promise<void>
  release: () => void
}

export function reserveThreadIngress(threadId: string): ThreadIngressSlot {
  const previous = threadIngressChains.get(threadId) ?? Promise.resolve()
  let released = false
  let releaseHeld = () => {}
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  threadIngressChains.set(
    threadId,
    previous.then(() => held),
  )
  return {
    wait: previous,
    release: () => {
      if (released) {
        return
      }
      released = true
      releaseHeld()
    },
  }
}

export async function runInThreadIngressSlot<T>(
  slot: ThreadIngressSlot | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await threadIngressSlotAls.run(slot, run)
  } finally {
    slot?.release()
  }
}

export async function waitForCurrentThreadIngress(): Promise<void> {
  const slot = threadIngressSlotAls.getStore()
  if (!slot) {
    return
  }
  await slot.wait
}

export function releaseCurrentThreadIngress(): void {
  threadIngressSlotAls.getStore()?.release()
}

export function clearThreadIngress(threadId: string): void {
  threadIngressChains.delete(threadId)
}
