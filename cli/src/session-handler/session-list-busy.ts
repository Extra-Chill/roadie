import { getThreadIdBySessionId } from '../database.js'
import { loadPersistedSessionEvents } from '../wait-session.js'
import { isSessionBusy } from './event-stream-state.js'
import { getRuntime } from './runtime-registry.js'

/** List uses the queue's busy state, including persisted events in CLI children. */
export async function sessionListIsBusy(sessionId: string, backendBusy: boolean): Promise<boolean> {
  const threadId = await getThreadIdBySessionId(sessionId)
  const runtime = threadId ? getRuntime(threadId) : undefined
  if (runtime?.state?.sessionId === sessionId) return runtime.isBusy()
  return backendBusy || isSessionBusy({
    events: await loadPersistedSessionEvents({ sessionId }), sessionId,
  })
}
