import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { describe, expect, test } from 'vitest'
import { OpenCodeBackend } from './opencode.js'

describe('OpenCodeBackend', () => {
  test('delegates session prompts to its client', async () => {
    let requestedUrl = ''
    const fetch: typeof globalThis.fetch = Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        requestedUrl = input instanceof Request ? input.url : String(input)
        return new Response(JSON.stringify({}), { status: 200 })
      },
      { preconnect: async () => undefined },
    )
    const client = createOpencodeClient({ baseUrl: 'http://localhost:4096', fetch })
    const backend = OpenCodeBackend.fromClient(client)

    await backend.session.promptAsync({ sessionID: 'session-1', parts: [] })

    expect(requestedUrl).toContain('/session/session-1/prompt_async')
  })
})
