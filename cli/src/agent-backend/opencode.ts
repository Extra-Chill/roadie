// OpenCode implementation of the agent backend seam.
//
// Session operations are adapted to Roadie types by ./opencode-sessions.ts; the
// catalog passes through the OpenCode client unchanged.

import { createOpencodeClient, type Event as OpenCodeEvent, type GlobalEvent } from '@opencode-ai/sdk/v2'
import {
  getOpencodeClient,
  getOpencodeServerAuthHeaders,
  getOpencodeServerBaseUrl,
  initializeOpencodeForDirectory,
  subscribeOpencodeServerLifecycle,
} from '../opencode.js'
import { OpenCodeSdkError } from '../errors.js'
import { toOpenCodeBackend } from './opencode-sessions.js'
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
    const client = getOpencodeClient(directory)
    return client ? toOpenCodeBackend(client) : null
  },
  async initializeForDirectory(directory, options) {
    const getClient = await initializeOpencodeForDirectory(directory, options)
    if (getClient instanceof Error) return getClient
    return () => toOpenCodeBackend(getClient())
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
