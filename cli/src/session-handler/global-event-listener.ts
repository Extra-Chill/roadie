// Global SSE event listener.
// One persistent connection to /global/event that broadcasts events to all
// registered thread runtimes. Each runtime's handleEvent() filters by
// sessionId internally. Replaces per-thread SSE listeners that each opened
// their own connection, causing reconnect churn with many idle threads.
//
// Architecture mirrors the opencode TUI (packages/app/src/context/global-sdk.tsx)
// which uses a single global.event() SSE stream for all directories.

import { OpenCodeSdkError } from '../errors.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { AgentBackendEvent } from '../agent-backend/types.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'

type OpenCodeEvent = AgentBackendEvent

const logger = createLogger(LogPrefix.SESSION)

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })
}

// ── Types ──────────────────────────────────────────────────────

type EventCallback = (event: OpenCodeEvent) => void

// ── State ──────────────────────────────────────────────────────

const callbacks = new Map<string, EventCallback>()
let loopRunning = false
let disposed = false
let controller: AbortController | null = null
let connected = false
const connectionWaiters = new Set<() => void>()

// ── Public API ─────────────────────────────────────────────────

/**
 * Register a thread runtime to receive global events. Every event from the
 * global SSE stream is broadcast to every callback; the runtime's own
 * handleEvent() filters by sessionId.
 */
export function registerEventListener(
  threadId: string,
  callback: EventCallback,
): void {
  // Allow restart after dispose (e.g. server restart in tests).
  if (disposed) {
    disposed = false
  }
  callbacks.set(threadId, callback)
  ensureListenerRunning()
}

/**
 * Unregister a thread runtime.
 */
export function unregisterEventListener(threadId: string): void {
  callbacks.delete(threadId)
}

/**
 * Stop the global listener entirely. Called during server shutdown.
 * The listener can be restarted by a subsequent registerEventListener() call.
 */
export function disposeGlobalEventListener(): void {
  disposed = true
  loopRunning = false
  connected = false
  controller?.abort()
  controller = null
  callbacks.clear()
}

/**
 * Restart the global listener (e.g. after the opencode server restarts).
 * Aborts the current SSE connection so it reconnects immediately.
 */
export function restartGlobalEventListener(): void {
  if (disposed) return
  connected = false
  controller?.abort()
}

/** Wait until the event stream is connected before starting event-producing work. */
export function waitForGlobalEventListener(): Promise<void> {
  if (callbacks.size === 0 || connected) return Promise.resolve()
  ensureListenerRunning()
  return new Promise((resolve) => {
    connectionWaiters.add(resolve)
  })
}

// ── Internals ──────────────────────────────────────────────────

// Reconnect whenever the backend restarts. Subscribed lazily, once per
// provider, so swapping the provider re-subscribes to the new one.
const lifecycleSubscribed = new WeakSet<object>()

function ensureLifecycleSubscription(): void {
  const provider = getAgentBackendProvider()
  if (lifecycleSubscribed.has(provider)) return
  lifecycleSubscribed.add(provider)
  provider.onStarted(({ description }) => {
    // A listener left on a provider that was swapped out must not restart the stream.
    if (getAgentBackendProvider() !== provider) return
    logger.log(`[GLOBAL LISTENER] ${description} started, reconnecting`)
    restartGlobalEventListener()
  })
}

function ensureListenerRunning(): void {
  if (loopRunning || disposed) return
  ensureLifecycleSubscription()
  loopRunning = true
  void runEventLoop()
}

function dispatchEvent(event: OpenCodeEvent): void {
  for (const callback of callbacks.values()) {
    callback(event)
  }
}

async function runEventLoop(): Promise<void> {

  let backoffMs = 500
  const maxBackoffMs = 30_000

  while (!disposed) {
    controller = new AbortController()
    const signal = controller.signal

    const subscription = getAgentBackendProvider().subscribeEvents({ signal })
    if (!subscription) {
      if (callbacks.size === 0) {
        logger.log('[GLOBAL LISTENER] No registrations, pausing')
        loopRunning = false
        return
      }
      logger.warn(
        `[GLOBAL LISTENER] No agent backend available, retrying in ${backoffMs}ms`,
      )
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    const subscribeResult = await subscription

    if (subscribeResult instanceof Error) {
      if (isAbortError(subscribeResult)) {
        if (disposed) return
        backoffMs = 500
        continue
      }
      logger.warn(
        `[GLOBAL LISTENER] Subscribe failed, retrying in ${backoffMs}ms:`,
        subscribeResult.message,
      )
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    const events = subscribeResult

    connected = true
    for (const resolve of connectionWaiters) resolve()
    connectionWaiters.clear()
    logger.log('[GLOBAL LISTENER] Connected to global event stream')

    let receivedAnyEvent = false
    const iterResult = await (async () => {
      for await (const event of events) {
        receivedAnyEvent = true
        dispatchEvent(event)
      }
    })()
      .catch((e) => new OpenCodeSdkError({ operation: 'event.iterate', cause: e }))

    connected = false

    if (receivedAnyEvent) {
      backoffMs = 500
    }

    if (iterResult instanceof Error) {
      if (isAbortError(iterResult)) {
        if (disposed) return
        backoffMs = 500
        continue
      }
      logger.warn(
        `[GLOBAL LISTENER] Stream broke, reconnecting in ${backoffMs}ms:`,
        iterResult.message,
      )
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    } else {
      if (signal.aborted) {
        backoffMs = 500
        continue
      }
      logger.log(
        `[GLOBAL LISTENER] Stream ended normally, reconnecting in ${backoffMs}ms`,
      )
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    }
  }
}
