// The OpenCode session adapter: Roadie inputs become OpenCode requests, and
// OpenCode responses become Roadie values or errors.

import { describe, expect, test, vi } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { OpenCodeSdkError } from '../errors.js'
import { openCodeSessionOperations, toOpenCodeBackend } from './opencode-sessions.js'
import { AgentRequestError } from './types.js'

function fakeClient(session: Record<string, unknown>, permission: Record<string, unknown> = {}) {
  return { session, permission, provider: {}, config: {}, app: {} } as unknown as OpencodeClient
}

describe('openCodeSessionOperations', () => {
  test('prompt maps parts, model and variant to OpenCode shape', async () => {
    const promptAsync = vi.fn(async () => ({ data: undefined }))
    const ops = openCodeSessionOperations(fakeClient({ promptAsync }))
    const result = await ops.prompt({
      sessionId: 's1',
      directory: '/p',
      parts: [
        { kind: 'text', text: 'hi' },
        { kind: 'text', text: 'ctx', synthetic: true },
        { kind: 'file', mime: 'image/png', url: 'file:///a.png', filename: 'a.png' },
      ],
      system: 'sys',
      agent: 'build',
      model: { providerId: 'anthropic', modelId: 'claude' },
      variant: 'high',
    })
    expect(result).toBeUndefined()
    expect(promptAsync).toHaveBeenCalledWith({
      sessionID: 's1',
      directory: '/p',
      parts: [
        { type: 'text', text: 'hi' },
        { type: 'text', text: 'ctx', synthetic: true },
        { type: 'file', mime: 'image/png', url: 'file:///a.png', filename: 'a.png' },
      ],
      system: 'sys',
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
      variant: 'high',
    })
  })

  test('command sends the model as provider/model and forwards the signal', async () => {
    const command = vi.fn(async () => ({ data: {} }))
    const ops = openCodeSessionOperations(fakeClient({ command }))
    const signal = new AbortController().signal
    await ops.command(
      { sessionId: 's1', directory: '/p', command: 'review', arguments: 'x', model: { providerId: 'a', modelId: 'b' } },
      { signal },
    )
    expect(command).toHaveBeenCalledWith(
      { sessionID: 's1', directory: '/p', command: 'review', arguments: 'x', model: 'a/b' },
      { signal },
    )
  })

  test('an OpenCode error response becomes AgentRequestError with its message', async () => {
    const ops = openCodeSessionOperations(fakeClient({
      promptAsync: async () => ({ error: { name: 'BadRequest', data: { message: 'nope' } } }),
    }))
    const result = await ops.prompt({ sessionId: 's1', directory: '/p', parts: [] })
    expect(result).toBeInstanceOf(AgentRequestError)
    expect((result as Error).message).toBe('BadRequest: nope')
  })

  test('a thrown request becomes OpenCodeSdkError', async () => {
    const ops = openCodeSessionOperations(fakeClient({
      abort: async () => { throw new Error('socket hang up') },
    }))
    expect(await ops.abort({ sessionId: 's1', directory: '/p' })).toBeInstanceOf(OpenCodeSdkError)
  })

  test('get returns a Roadie session, or undefined when absent', async () => {
    const ops = openCodeSessionOperations(fakeClient({
      get: async ({ sessionID }: { sessionID: string }) => (
        sessionID === 's1' ? { data: { id: 's1', title: 'T', parentID: 'p0' } } : { data: undefined }
      ),
    }))
    expect(await ops.get({ sessionId: 's1', directory: '/p' })).toEqual({ id: 's1', title: 'T', parentId: 'p0' })
    expect(await ops.get({ sessionId: 's2', directory: '/p' })).toBeUndefined()
  })

  test('status maps every session to busy, idle or retry', async () => {
    const ops = openCodeSessionOperations(fakeClient({
      status: async () => ({
        data: { a: { type: 'busy' }, b: { type: 'idle' }, c: { type: 'retry', attempt: 2, message: 'm', next: 9 } },
      }),
    }))
    expect(await ops.status({ directory: '/p' })).toEqual({
      a: { state: 'busy' },
      b: { state: 'idle' },
      c: { state: 'retry', attempt: 2, message: 'm', nextAt: 9 },
    })
  })

  test('messages translate info and parts', async () => {
    const ops = openCodeSessionOperations(fakeClient({
      messages: async () => ({
        data: [{
          info: {
            id: 'm1', sessionID: 's1', role: 'assistant', parentID: 'u1', modelID: 'x', providerID: 'y',
            mode: 'build', agent: 'build', time: { created: 1 }, cost: 0,
            tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 1, write: 0 } },
          },
          parts: [{ id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: 'hello' }],
        }],
      }),
    }))
    const result = await ops.messages({ sessionId: 's1', directory: '/p' })
    if (result instanceof Error) throw result
    expect(result[0]?.message.usage).toEqual({ input: 3, output: 4, reasoning: 0, cacheRead: 1, cacheWrite: 0 })
    expect(result[0]?.parts[0]).toMatchObject({ kind: 'text', text: 'hello' })
  })

  test('replyPermission and create map ids and permissions', async () => {
    const reply = vi.fn(async () => ({ data: true }))
    const create = vi.fn(async () => ({ data: { id: 'new', title: '' } }))
    const ops = openCodeSessionOperations(fakeClient({ create }, { reply }))
    await ops.replyPermission({ requestId: 'r1', directory: '/p', reply: 'reject' })
    expect(reply).toHaveBeenCalledWith({ requestID: 'r1', directory: '/p', reply: 'reject' })
    const rule = { permission: 'edit', pattern: '*', action: 'allow' as const }
    expect(await ops.create({ directory: '/p', permission: [rule] })).toEqual({ id: 'new', title: '' })
    expect(create).toHaveBeenCalledWith({ directory: '/p', permission: [rule] })
  })
})

test('toOpenCodeBackend caches one backend per client', () => {
  const client = fakeClient({})
  expect(toOpenCodeBackend(client)).toBe(toOpenCodeBackend(client))
})
