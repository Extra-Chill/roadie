// Speaker-billing payer-change notice (credential pools phase 2c, issue #137
// item 6): in `speaker` billing the thread posts exactly one notice when the
// payer first changes, saying earlier messages go to the new payer's provider
// account. The claim lives in sqlite (credential_payer_notices), so the
// notice never reposts on later turns or after a restart.
//
// The runtime is built without its constructor (Object.create, the same
// pattern as thread-session-runtime-summary.test.ts): recordTurnAttribution
// only needs thread, channelId and chat, and the database helpers run against
// the vitest-isolated sqlite database.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { ThreadSessionRuntime } from './thread-session-runtime.js'
import { store } from '../store.js'
import { getSessionTurnAttribution } from '../database.js'

type RuntimeInternals = {
  thread: { id: string }
  channelId?: string
  chat: {
    platform: string
    sendNotice: (content: string) => Promise<Error | { id: string }>
  }
  recordTurnAttribution: (args: {
    sessionId: string
    input: {
      userId: string
      username: string
      actorVia?: 'chat' | 'cli'
      personId?: string
      credentialPool?: string
    }
  }) => Promise<void>
}

function runtimeWithChat(): { runtime: RuntimeInternals; notices: string[] } {
  const notices: string[] = []
  const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
  runtime.thread = { id: 'thr-payer-notice' }
  runtime.channelId = 'chan-payer-notice'
  runtime.chat = {
    platform: 'discord',
    sendNotice: async (content: string) => {
      notices.push(content)
      return { id: `msg-${notices.length}` }
    },
  }
  return { runtime, notices }
}

function enableSpeakerBilling(): void {
  store.setState({
    credentialPoolsEnabled: true,
    credentialsMode: 'per-person',
    threadBilling: 'speaker',
  })
}

const PREVIOUS_STORE_STATE = store.getState()

afterEach(() => {
  store.setState({
    credentialPoolsEnabled: PREVIOUS_STORE_STATE.credentialPoolsEnabled,
    credentialsMode: PREVIOUS_STORE_STATE.credentialsMode,
    threadBilling: PREVIOUS_STORE_STATE.threadBilling,
  })
  vi.restoreAllMocks()
})

describe('speaker billing payer-change notice', () => {
  test('posts the notice once, on the first turn whose payer differs', async () => {
    enableSpeakerBilling()
    const sessionId = 'ses-payer-change-1'
    const { runtime, notices } = runtimeWithChat()

    // Turn 1 (alice): the payer starts here, nothing to announce.
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'alice-id', username: 'alice' },
    })
    expect(notices).toEqual([])
    expect((await getSessionTurnAttribution(sessionId))?.credentialPool).toBe('discord:alice-id')

    // Turn 2 (bob): the payer changes, the thread learns where earlier
    // messages go.
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'bob-id', username: 'bob' },
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('bob')
    expect(notices[0]).toContain('discord:bob-id')
    expect(notices[0]).toContain('Earlier messages in this thread')

    // Turns 3-4 (bob again, then alice): the notice never repeats.
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'bob-id', username: 'bob' },
    })
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'alice-id', username: 'alice' },
    })
    expect(notices).toHaveLength(1)
    // The attribution row still tracks the current speaker.
    expect((await getSessionTurnAttribution(sessionId))?.credentialPool).toBe('discord:alice-id')
  })

  test('identity-hook pool overrides count: the same override pool is not a change', async () => {
    enableSpeakerBilling()
    const sessionId = 'ses-payer-change-2'
    const { runtime, notices } = runtimeWithChat()

    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'alice-id', username: 'alice', credentialPool: 'team' },
    })
    expect(notices).toEqual([])
    // The override, not the derived person pool, is the payer.
    expect((await getSessionTurnAttribution(sessionId))?.credentialPool).toBe('team')

    // bob bills through the same override pool: no payer change, no notice.
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'bob-id', username: 'bob', credentialPool: 'team' },
    })
    expect(notices).toEqual([])

    // bob's override moves to shared: a real change, one notice.
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'bob-id', username: 'bob', credentialPool: 'shared' },
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('(shared)')
  })

  test('no notice in owner billing: the payer never changes', async () => {
    store.setState({
      credentialPoolsEnabled: true,
      credentialsMode: 'per-person',
      threadBilling: 'owner',
    })
    const sessionId = 'ses-payer-owner-1'
    const { runtime, notices } = runtimeWithChat()

    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'alice-id', username: 'alice' },
    })
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'bob-id', username: 'bob' },
    })
    expect(notices).toEqual([])
  })

  test('no notice in global mode: the shared pool bills everything', async () => {
    store.setState({
      credentialPoolsEnabled: true,
      credentialsMode: 'global',
      threadBilling: 'speaker',
    })
    const sessionId = 'ses-payer-global-1'
    const { runtime, notices } = runtimeWithChat()

    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'alice-id', username: 'alice' },
    })
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'bob-id', username: 'bob' },
    })
    expect(notices).toEqual([])
  })

  test('no notice with credential pools off', async () => {
    store.setState({
      credentialPoolsEnabled: false,
      credentialsMode: 'per-person',
      threadBilling: 'speaker',
    })
    const sessionId = 'ses-payer-off-1'
    const { runtime, notices } = runtimeWithChat()

    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'alice-id', username: 'alice' },
    })
    await runtime.recordTurnAttribution({
      sessionId,
      input: { userId: 'bob-id', username: 'bob' },
    })
    expect(notices).toEqual([])
    // Without pools the pool column is never recorded.
    expect((await getSessionTurnAttribution(sessionId))?.credentialPool).toBeUndefined()
  })
})
