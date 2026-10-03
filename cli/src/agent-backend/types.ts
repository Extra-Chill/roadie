// Agent backend seam for the session runtime.
//
// `AgentBackend` lists exactly the agent operations the session runtime calls
// today, derived from the call sites in `session-handler/`. Signatures and
// payloads are still OpenCode-shaped: the seam is the call surface, so a
// second backend can implement it (or adapt to it) later without the runtime
// importing the OpenCode SDK client directly.
//
// Keep this list in sync with real call sites. Add an operation only when the
// runtime starts using it.

import type { Event as OpenCodeEvent, OpencodeClient } from '@opencode-ai/sdk/v2'

export type AgentBackend = {
  session: Pick<
    OpencodeClient['session'],
    | 'abort'
    | 'command'
    | 'create'
    | 'get'
    | 'messages'
    | 'promptAsync'
    | 'status'
    | 'update'
  >
  permission: Pick<OpencodeClient['permission'], 'reply'>
  provider: Pick<OpencodeClient['provider'], 'list'>
  config: Pick<OpencodeClient['config'], 'get'>
  app: Pick<OpencodeClient['app'], 'agents'>
}

/** One event from the backend's stream. OpenCode-shaped, like the rest of the seam. */
export type AgentBackendEvent = OpenCodeEvent

/** Lazily returns the backend for a directory once it has been initialized. */
export type AgentBackendGetter = () => AgentBackend

export type AgentBackendInitializeOptions = {
  originalRepoDirectory?: string
  channelId?: string
}

/**
 * Supplies agent backends to the session runtime, one per project directory.
 * The default provider is OpenCode (see `./opencode.ts`).
 */
export type AgentBackendProvider = {
  /** Name used in logs. */
  readonly id: string
  /** Backend for a directory whose server is already running, or null. */
  getBackend(directory: string): AgentBackend | null
  /** Ensure the backend serving `directory` is running; returns a getter. */
  initializeForDirectory(
    directory: string,
    options?: AgentBackendInitializeOptions,
  ): Promise<Error | AgentBackendGetter>
  /**
   * One stream of events for every session and directory this provider
   * serves. Returns null while no backend is running. The stream ends or
   * throws when the connection drops; callers reconnect.
   */
  subscribeEvents(options: {
    signal: AbortSignal
  }): null | Promise<Error | AsyncIterable<AgentBackendEvent>>
  /** Called whenever the backend (re)starts, so event consumers reconnect. */
  onStarted(listener: (info: { description: string }) => void): void
}
