// OpenCode implementation of the agent backend seam.
//
// The OpenCode SDK client already satisfies `AgentBackend` structurally, so
// this provider hands the runtime the exact same client objects as before.
// Behavior is unchanged; only the import path the runtime depends on moves.

import { createOpencodeClient, type Event as OpenCodeEvent, type GlobalEvent } from '@opencode-ai/sdk/v2'
import {
  getOpencodeClient,
  getOpencodeServerAuthHeaders,
  getOpencodeServerBaseUrl,
  initializeOpencodeForDirectory,
  subscribeOpencodeServerLifecycle,
} from '../opencode.js'
import { OpenCodeSdkError } from '../errors.js'
import type { AgentBackendEvent, AgentBackendProvider } from './types.js'

// OpenCode wraps every event in a { directory, payload } envelope on the
// global stream; the runtime only needs the payload.
async function* unwrapGlobalEvents(stream: AsyncIterable<GlobalEvent>): AsyncIterable<AgentBackendEvent> {
  for await (const event of stream) {
    yield event.payload as OpenCodeEvent
  }
}

export const openCodeBackendProvider: AgentBackendProvider = {
  id: 'opencode',
  getBackend(directory) {
    return getOpencodeClient(directory)
  },
  initializeForDirectory(directory, options) {
    return initializeOpencodeForDirectory(directory, options)
  },
  subscribeEvents({ signal }) {
    const baseUrl = getOpencodeServerBaseUrl()
    if (!baseUrl) return null
    const client = createOpencodeClient({ baseUrl, headers: getOpencodeServerAuthHeaders() })
    return client.global.event({ signal })
      .then((result) => unwrapGlobalEvents(result.stream))
      .catch((e: unknown) => new OpenCodeSdkError({ operation: 'event.subscribe', cause: e }))
  },
  onStarted(listener) {
    subscribeOpencodeServerLifecycle((event) => {
      if (event.type === 'started') listener({ description: `OpenCode server on port ${event.port}` })
    })
  },
}
