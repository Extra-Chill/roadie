import { describe, expect, test, vi } from 'vitest'
import type { ButtonInteraction, Client } from 'discord.js'
import * as database from '../database.js'
import { createOperatorRequest, expireOperatorRequest, waitForOperatorDecision } from '../operator-requests.js'
import { handleOperatorRequestButton, subscribeToOperatorRequests } from './operator-request.js'

function click(id: string, decision: 'approve' | 'deny', admin: boolean, content = 'Exact argv:\n```json\n["upgrade"]\n```') {
  const reply = vi.fn(async () => undefined)
  const update = vi.fn(async (_payload: { content: string; components: unknown[] }) => undefined)
  const interaction = {
    customId: `operator_request:${decision}:${id}`,
    member: { roles: [], permissions: admin ? '8' : '0', user: { id: 'operator' } },
    guild: { ownerId: 'owner', roles: { cache: new Map() } },
    user: { id: 'operator' },
    message: { content },
    reply,
    update,
  } as unknown as ButtonInteraction
  return { interaction, reply, update }
}

describe('operator request buttons', () => {
  test('posts exact argv and approval buttons in the session thread', async () => {
    const lookup = vi.spyOn(database, 'getThreadIdBySessionId').mockResolvedValue('thread')
    const send = vi.fn(async (_payload: { content: string; components: { toJSON(): { components: { custom_id: string }[] } }[] }) => undefined)
    const client = { channels: { fetch: vi.fn(async () => ({ isSendable: () => true, send })) } } as unknown as Client
    const unsubscribe = subscribeToOperatorRequests(client)
    try {
      const request = createOperatorRequest({ sessionId: 'test', argv: ['credentials', 'list', '--pool', 'shared'] })
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      expect(lookup).toHaveBeenCalledWith('test')
      const payload = send.mock.calls[0]![0]
      expect(payload.content).toContain('["credentials","list","--pool","shared"]')
      expect(payload.components[0]!.toJSON().components.map((button) => button.custom_id)).toEqual([
        `operator_request:approve:${request.id}`, `operator_request:deny:${request.id}`,
      ])
      expireOperatorRequest(request.id)
    } finally {
      unsubscribe()
      lookup.mockRestore()
    }
  })

  test('expires a request without a resolvable thread', async () => {
    const lookup = vi.spyOn(database, 'getThreadIdBySessionId').mockResolvedValue(undefined)
    const client = { channels: { fetch: vi.fn() } } as unknown as Client
    const unsubscribe = subscribeToOperatorRequests(client)
    try {
      const request = createOperatorRequest({ sessionId: 'test', argv: ['upgrade'] })
      const result = waitForOperatorDecision(request.id, { timeoutMs: 1000 })
      expect((await result).state).toBe('expired')
      expect(client.channels.fetch).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
      lookup.mockRestore()
    }
  })

  test('an operator approves and the prompt is disabled', async () => {
    const request = createOperatorRequest({ sessionId: 'test', argv: ['upgrade'] })
    const result = waitForOperatorDecision(request.id, { timeoutMs: 1000 })
    const { interaction, update } = click(request.id, 'approve', true)
    await handleOperatorRequestButton(interaction)
    expect(await result).toMatchObject({ state: 'approved', approverId: 'operator' })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('approved by'), components: [] }))
  })

  test('a non-operator gets an ephemeral refusal while request stays pending', async () => {
    const request = createOperatorRequest({ sessionId: 'test', argv: ['upgrade'] })
    const { interaction, reply, update } = click(request.id, 'approve', false)
    await handleOperatorRequestButton(interaction)
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: 64 }))
    expect(update).not.toHaveBeenCalled()
    const result = waitForOperatorDecision(request.id, { timeoutMs: 1000 })
    expireOperatorRequest(request.id)
    expect((await result).state).toBe('expired')
  })

  test('deny resolves as denied', async () => {
    const request = createOperatorRequest({ sessionId: 'test', argv: ['upgrade'] })
    const result = waitForOperatorDecision(request.id, { timeoutMs: 1000 })
    const { interaction, update } = click(request.id, 'deny', true)
    await handleOperatorRequestButton(interaction)
    expect((await result).state).toBe('denied')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('denied by'), components: [] }))
  })

  test('a click after decision reports the prompt is no longer actionable', async () => {
    const request = createOperatorRequest({ sessionId: 'test', argv: ['upgrade'] })
    const first = click(request.id, 'deny', true)
    await handleOperatorRequestButton(first.interaction)
    const late = click(request.id, 'approve', true, first.update.mock.calls[0]![0].content)
    await handleOperatorRequestButton(late.interaction)
    expect(late.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Already decided or expired'), components: [] }))
  })
})
