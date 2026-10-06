// The OpenCode session adapter: Roadie inputs become OpenCode requests, and
// OpenCode responses become Roadie values or errors.

import { describe, expect, test, vi } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { OpenCodeSdkError } from '../errors.js'
import { openCodeAuthOperations, openCodeCatalogOperations, openCodeSessionOperations, toOpenCodeBackend } from './opencode-sessions.js'
import { AgentRequestError } from './types.js'

function fakeClient(session: Record<string, unknown>, permission: Record<string, unknown> = {}) {
  return { session, permission, provider: {}, config: {}, app: {} } as unknown as OpencodeClient
}

describe('openCodeSessionOperations', () => {
  test('title generation refuses an unconfigured route instead of guessing from provider catalogs', async () => {
    const create = vi.fn()
    const list = vi.fn()
    const client = { session: { create }, config: { get: async () => ({ data: {} }) }, provider: { list } } as unknown as OpencodeClient
    const result = await openCodeSessionOperations(client).generateTitle!({ directory: '/project', prompt: 'Investigate the follow-up' })
    expect(result).toBeInstanceOf(AgentRequestError)
    expect((result as Error).message).toContain('Configure agent.title.model or small_model explicitly')
    expect(create).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })
  test('explicit title-agent routing wins and preserves an API rejection in diagnostics', async () => {
    const prompt = vi.fn(async (_input: unknown) => ({ data: { info: { role: 'assistant', error: { name: 'APIError', data: { message: 'model rejected by auth route' } } }, parts: [] } }))
    const client = { config: { get: async () => ({ data: { small_model: 'unwanted/old-model', agent: { title: { model: 'subrouter/gpt-title-luna' } } } }) },
      session: { create: async () => ({ data: { id: 'internal-title' } }), prompt, abort: async () => ({}), delete: async () => ({}) },
    } as unknown as OpencodeClient
    const result = await openCodeSessionOperations(client).generateTitle!({ directory: '/project', prompt: 'Name this follow-up' })
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ model: { providerID: 'subrouter', modelID: 'gpt-title-luna' } })
    expect(result).toBeInstanceOf(AgentRequestError)
    expect((result as Error).message).toContain('subrouter/gpt-title-luna')
    expect((result as Error).message).toContain('model rejected by auth route')
  })
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

describe('openCodeCatalogOperations', () => {
  function catalogClient(parts: Record<string, unknown>) {
    return { session: {}, permission: {}, provider: {}, config: {}, app: {}, ...parts } as unknown as OpencodeClient
  }

  test('providers translate models, context limits and variants', async () => {
    const ops = openCodeCatalogOperations(catalogClient({
      config: {
        providers: async () => ({
          data: {
            providers: [{
              id: 'anthropic', name: 'Anthropic',
              models: {
                claude: { name: 'Claude', limit: { context: 200000 }, variants: { low: {}, high: {}, ' ': {} } },
                plain: { name: '' },
              },
            }],
            default: { anthropic: 'claude' },
          },
        }),
      },
    }))
    expect(await ops.providers({ directory: '/p' })).toEqual({
      providers: [{
        id: 'anthropic', name: 'Anthropic',
        models: {
          claude: { id: 'claude', name: 'Claude', contextLimit: 200000, variants: ['low', 'high'] },
          plain: { id: 'plain', name: 'plain', variants: [] },
        },
      }],
      connected: ['anthropic'],
      defaults: { anthropic: 'claude' },
    })
  })

  test('provider discovery does not offer models absent from the execution-active catalogue', async () => {
    const discovery = vi.fn(async () => ({ data: { all: [{ id: 'unavailable', models: { advertised: {} } }], connected: ['unavailable'], default: {} } }))
    const active = vi.fn(async () => ({ data: { providers: [], default: {} } }))
    const ops = openCodeCatalogOperations(catalogClient({ provider: { list: discovery }, config: { providers: active } }))
    expect(await ops.providers({ directory: '/fork-worktree' })).toEqual({ providers: [], connected: [], defaults: {} })
    expect(active).toHaveBeenCalledWith({ directory: '/fork-worktree' })
    expect(discovery).not.toHaveBeenCalled()
  })

  test('config and agents translate to Roadie shape', async () => {
    const ops = openCodeCatalogOperations(catalogClient({
      config: { get: async () => ({ data: { model: 'a/b', small_model: 'a/c' } }) },
      app: {
        agents: async () => ({
          data: [
            { name: 'build', mode: 'primary', model: { providerID: 'a', modelID: 'b' } },
            { name: 'explore', mode: 'subagent', hidden: true, description: 'look' },
          ],
        }),
      },
    }))
    expect(await ops.config({})).toEqual({ model: 'a/b', smallModel: 'a/c' })
    expect(await ops.agents({})).toEqual([
      { name: 'build', mode: 'primary', model: { providerId: 'a', modelId: 'b' } },
      { name: 'explore', description: 'look', mode: 'subagent', hidden: true },
    ])
  })
})

describe('openCodeAuthOperations', () => {
  function authClient(parts: Record<string, unknown>, dispose = vi.fn(async () => ({ data: true }))) {
    return {
      client: { session: {}, permission: {}, provider: {}, config: {}, app: {}, auth: {}, instance: { dispose }, ...parts } as unknown as OpencodeClient,
      dispose,
    }
  }

  test('methods pass through per provider', async () => {
    const { client } = authClient({
      provider: { auth: async () => ({ data: { anthropic: [{ type: 'oauth', label: 'Claude Pro' }, { type: 'api', label: 'API key' }] } }) },
    })
    expect(await openCodeAuthOperations(client).methods({ directory: '/p' })).toEqual({
      anthropic: [{ type: 'oauth', label: 'Claude Pro' }, { type: 'api', label: 'API key' }],
    })
  })

  test('setApiKey saves the key and reloads so it takes effect', async () => {
    const set = vi.fn(async () => ({ data: true }))
    const { client, dispose } = authClient({ auth: { set } })
    expect(await openCodeAuthOperations(client).setApiKey({ directory: '/p', providerId: 'openai', key: 'sk' })).toBeUndefined()
    expect(set).toHaveBeenCalledWith({ providerID: 'openai', auth: { type: 'api', key: 'sk' } })
    expect(dispose).toHaveBeenCalledWith({ directory: '/p' })
  })

  test('finishOAuth forwards the code; a rejected code is an error and does not reload', async () => {
    const callback = vi.fn(async ({ code }: { code?: string }) => (
      code === 'bad' ? { error: { data: { message: 'invalid code' } } } : { data: true }
    ))
    const { client, dispose } = authClient({ provider: { oauth: { callback } } })
    const ops = openCodeAuthOperations(client)
    expect(await ops.finishOAuth({ directory: '/p', providerId: 'a', method: 0, code: 'ok' })).toBeUndefined()
    expect(callback).toHaveBeenCalledWith({ providerID: 'a', method: 0, code: 'ok', directory: '/p' })
    expect(dispose).toHaveBeenCalledTimes(1)
    const failed = await ops.finishOAuth({ directory: '/p', providerId: 'a', method: 0, code: 'bad' })
    expect(failed).toBeInstanceOf(AgentRequestError)
    expect((failed as Error).message).toBe('invalid code')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('startOAuth without a running server is an error', async () => {
    const { client } = authClient({})
    expect(await openCodeAuthOperations(client).startOAuth({ directory: '/p', providerId: 'a', method: 0 })).toBeInstanceOf(AgentRequestError)
  })
})
