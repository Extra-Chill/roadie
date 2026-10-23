import { describe, expect, test, vi } from 'vitest'
import { ThreadSessionRuntime } from './thread-session-runtime.js'
import type { IngressInput } from './ingress-input.js'

vi.mock('../agent-backend/registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agent-backend/registry.js')>(),
  getAgentBackendProvider: () => ({ id: 'pi' }),
}))

describe('Pi ingress turn isolation (#340)', () => {
  test('mid-turn ingress queues its speaker policy without touching the running session', async () => {
    const runtime = Object.create(ThreadSessionRuntime.prototype)
    const queued = vi.fn(async () => ({ queued: true, queueId: 'next' }))
    Object.assign(runtime, {
      supersedePendingSleep: async () => {},
      dispatchAction: async (action: () => Promise<void>) => action(),
      isBusy: () => true,
      permissionOwner: 'admin-person',
      enqueueViaLocalQueue: queued,
      ensureSession: () => { throw new Error('Must not mutate the active session') },
    })
    const input: IngressInput = {
      prompt: 'team seat message', username: 'seat', userId: 'seat-user', personId: 'seat-person',
      permissions: ['bash:deny', 'edit:deny', 'roadie_pm_*:deny'],
    }
    expect(await runtime.submitToSession(input)).toEqual({ queued: true, queueId: 'next' })
    expect(queued).toHaveBeenCalledWith(input)
  })

  test('the running turn\'s own speaker steers it instead of queueing', async () => {
    const runtime = Object.create(ThreadSessionRuntime.prototype)
    const queued = vi.fn()
    const ensureSession = vi.fn(async () => new Error('steered into the running session'))
    Object.assign(runtime, {
      supersedePendingSleep: async () => {},
      dispatchAction: async (action: () => Promise<void>) => action(),
      isBusy: () => true,
      permissionOwner: 'admin-person',
      enqueueViaLocalQueue: queued,
      ensureSession,
      typing: { stopTyping: () => {} },
      chat: { sendMessage: async () => {} },
      messageQueue: { tryDrainQueue: async () => {} },
    })
    const input: IngressInput = { prompt: 'follow-up', username: 'admin', userId: 'admin-user', personId: 'admin-person' }
    expect(await runtime.submitToSession(input)).toEqual({ queued: false })
    expect(queued).not.toHaveBeenCalled()
    expect(ensureSession).toHaveBeenCalledOnce()
  })

  test('context-only ingress never replaces the running permission rules', async () => {
    const runtime = Object.create(ThreadSessionRuntime.prototype)
    const setPermissions = vi.fn()
    expect(await runtime.updateExistingSessionPermissions({
      client: { sessions: { setPermissions } }, sessionId: 'admin-turn',
      noReply: true, permissions: ['bash:deny'], owner: 'seat',
    })).toBeNull()
    expect(setPermissions).not.toHaveBeenCalled()
  })

  test('a new session still applies the speaker policy and records its owner', async () => {
    const runtime = Object.create(ThreadSessionRuntime.prototype)
    runtime.sdkDirectory = '/tmp'
    const setPermissions = vi.fn(async () => {})
    expect(await runtime.updateExistingSessionPermissions({
      client: { sessions: { setPermissions } }, sessionId: 'new-session',
      permissions: ['bash:deny'], owner: 'seat',
    })).toBeNull()
    expect(setPermissions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'new-session', owner: 'seat',
      permission: expect.arrayContaining([{ permission: 'bash', pattern: '*', action: 'deny' }]),
    }))
    expect(runtime.permissionOwner).toBe('seat')
  })

  test('an unrestricted turn resets the previous speaker restrictions', async () => {
    const runtime = Object.create(ThreadSessionRuntime.prototype)
    runtime.sdkDirectory = '/tmp'
    const setPermissions = vi.fn(async () => {})
    await runtime.updateExistingSessionPermissions({
      client: { sessions: { setPermissions } }, sessionId: 'shared',
      permissions: [], owner: 'admin',
    })
    expect(setPermissions).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'shared', owner: 'admin' }))
    expect(setPermissions).not.toHaveBeenCalledWith(expect.objectContaining({
      permission: expect.arrayContaining([{ permission: 'bash', pattern: '*', action: 'deny' }]),
    }))
  })
})
