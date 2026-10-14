// Retired-backend session migration (#230): with the OpenCode fallback
// disabled, a thread mapped to a retired session id is rebound to a fresh
// session without ever probing the retired id, seeded with the thread's
// recent history, and announced once. A transient sessions.get error never
// reads as retirement.
//
// The runtime is built without its constructor (Object.create, the same
// pattern as payer-change-notice.test.ts), and the agent backend provider is
// swapped with setAgentBackendProvider so ensureSession runs against a stub.

import { afterEach, describe, expect, test } from 'vitest'
import {
  ThreadSessionRuntime,
  boundSeedHistoryLines,
} from './thread-session-runtime.js'
import { setAgentBackendProvider, clearResolvedDefaultProvider } from '../agent-backend/registry.js'
import type { AgentBackend, AgentBackendProvider } from '../agent-backend/types.js'
import { AgentRequestError } from '../agent-backend/types.js'
import {
  getThreadSession,
  setThreadSession,
} from '../database.js'
import { getDb } from '../db.js'

type PromptCall = {
  sessionId: string
  directory: string
  parts: Array<{ kind: string; text: string; synthetic?: boolean }>
  noReply?: boolean
}

type RuntimeInternals = {
  thread: { id: string }
  threadId: string
  channelId?: string
  sdkDirectory: string
  eventBuffer: unknown[]
  state?: Record<string, unknown>
  chat: {
    platform: string
    sendNotice: (content: string) => Promise<Error | { id: string }>
    readRecentMessages?: (limit: number) => Promise<Error | Array<{ author: string; bot: boolean; timestamp: string; content: string }>>
  }
  ensureSession: (input: { prompt: string }) => Promise<
    Error | {
      session: { id: string; title: string }
      createdNewSession: boolean
      migratedFromSessionId?: string
    }
  >
}

function stubBackendWithGet(backend: AgentBackend): AgentBackendProvider {
  return {
    id: 'stub',
    getBackend: () => backend,
    initializeForDirectory: async () => () => backend,
    subscribeEvents: () => null,
    onStarted: () => {},
  }
}

function migrationScenario(options: {
  retiredSessionIds?: (sessionId: string) => boolean
  backend: AgentBackend
}) {
  const provider = stubBackendWithGet(options.backend)
  provider.isRetiredSession = options.retiredSessionIds
  const undo = setAgentBackendProvider(provider)
  clearResolvedDefaultProvider()
  return undo
}

afterEach(() => {
  clearResolvedDefaultProvider()
})

describe('retired-backend session migration (#230)', () => {
  test('a retired id is rebound to a fresh session, seeded and announced, without probing it', async () => {
    const calls: string[] = []
    const prompts: PromptCall[] = []
    const notices: string[] = []
    const backend = {
      sessions: {
        create: async () => {
          calls.push('create')
          return { id: 'pi_migrated', title: 'Fresh' }
        },
        get: async ({ sessionId }: { sessionId: string }) => {
          calls.push(`get:${sessionId}`)
          return undefined
        },
        prompt: async (input: PromptCall) => {
          prompts.push(input)
        },
      },
      catalog: { providers: async () => ({ providers: [], connected: [], defaults: {} }), config: async () => ({}), agents: async () => [] },
      auth: { methods: async () => ({}) },
    } as unknown as AgentBackend
    const undo = migrationScenario({
      retiredSessionIds: (sessionId) => sessionId.startsWith('ses_oc_'),
      backend,
    })

    await setThreadSession('thr-migrate-1', 'ses_oc_old')
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    runtime.thread = { id: 'thr-migrate-1' }
    runtime.threadId = 'thr-migrate-1'
    runtime.channelId = 'chan-migrate-1'
    runtime.sdkDirectory = '/tmp/roadie-migration-project'
    runtime.eventBuffer = []
    runtime.chat = {
      platform: 'discord',
      sendNotice: async (content) => {
        notices.push(content)
        return { id: 'notice-1' }
      },
      readRecentMessages: async (limit) => {
        calls.push(`history:${limit}`)
        return [
          { author: 'alice', bot: false, timestamp: '2026-10-12T10:00:00.000Z', content: 'the build is red' },
          { author: 'roadie', bot: true, timestamp: '2026-10-12T10:01:00.000Z', content: 'working on it' },
        ]
      },
    }

    const result = await runtime.ensureSession({ prompt: 'check the build' })
    undo()
    if (result instanceof Error) throw result
    // The retired id was never probed; the fresh session came from create.
    expect(calls.filter((call) => call.startsWith('get:'))).toEqual([])
    expect(calls).toContain('create')
    expect(result.createdNewSession).toBe(true)
    expect(result.migratedFromSessionId).toBe('ses_oc_old')
    expect(result.session.id).toBe('pi_migrated')
    // The thread rebinds durably, and the predecessor stays linkable.
    expect(await getThreadSession('thr-migrate-1')).toBe('pi_migrated')
    const db = await getDb()
    expect(
      (await db.query.thread_sessions.findFirst({ where: { thread_id: 'thr-migrate-1' } }))?.migrated_from_session_id,
    ).toBe('ses_oc_old')
    // One notice, and one noReply seed holding the note plus the history.
    expect(notices).toEqual(['This thread continued in a new session; the previous one ran on a retired agent backend.'])
    expect(prompts).toEqual([
      {
        sessionId: 'pi_migrated',
        directory: '/tmp/roadie-migration-project',
        noReply: true,
        parts: [
          {
            kind: 'text',
            synthetic: true,
            text: 'This conversation moved from an earlier session (ses_oc_old) to this one for the agent to keep working. Recent thread history (oldest first):\n\n2026-10-12T10:00:00.000Z alice: the build is red\n2026-10-12T10:01:00.000Z roadie [bot]: working on it',
          },
        ],
      },
    ])
  })

  test('a failed history read still migrates, seeding only the note', async () => {
    const prompts: PromptCall[] = []
    const notices: string[] = []
    const backend = {
      sessions: {
        create: async () => ({ id: 'pi_migrated_2', title: 'Fresh' }),
        prompt: async (input: PromptCall) => {
          prompts.push(input)
        },
      },
      catalog: { providers: async () => ({ providers: [], connected: [], defaults: {} }), config: async () => ({}), agents: async () => [] },
      auth: { methods: async () => ({}) },
    } as unknown as AgentBackend
    const undo = migrationScenario({
      retiredSessionIds: (sessionId) => sessionId.startsWith('ses_oc_'),
      backend,
    })

    await setThreadSession('thr-migrate-2', 'ses_oc_old')
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    runtime.thread = { id: 'thr-migrate-2' }
    runtime.threadId = 'thr-migrate-2'
    runtime.channelId = 'chan-migrate-2'
    runtime.sdkDirectory = '/tmp/roadie-migration-project'
    runtime.eventBuffer = []
    runtime.chat = {
      platform: 'discord',
      sendNotice: async (content) => {
        notices.push(content)
        return { id: 'notice-1' }
      },
      readRecentMessages: async () => new Error('history is gone'),
    }

    const result = await runtime.ensureSession({ prompt: 'continue' })
    undo()
    if (result instanceof Error) throw result
    expect(result.migratedFromSessionId).toBe('ses_oc_old')
    expect(await getThreadSession('thr-migrate-2')).toBe('pi_migrated_2')
    expect(notices).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.parts[0]!.text).toContain('Recent thread history')
  })

  test('without the retirement signal a transient sessions.get error never migrates', async () => {
    const calls: string[] = []
    const notices: string[] = []
    const backend = {
      sessions: {
        create: async () => {
          calls.push('create')
          return { id: 'pi_recreated', title: 'New' }
        },
        get: async ({ sessionId }: { sessionId: string }) => {
          calls.push(`get:${sessionId}`)
          return new AgentRequestError({ detail: 'transport blip' })
        },
        prompt: async () => {},
      },
      catalog: { providers: async () => ({ providers: [], connected: [], defaults: {} }), config: async () => ({}), agents: async () => [] },
      auth: { methods: async () => ({}) },
    } as unknown as AgentBackend
    const undo = migrationScenario({ backend })

    await setThreadSession('thr-migrate-3', 'ses_pi_owned')
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    runtime.thread = { id: 'thr-migrate-3' }
    runtime.threadId = 'thr-migrate-3'
    runtime.channelId = 'chan-migrate-3'
    runtime.sdkDirectory = '/tmp/roadie-migration-project'
    runtime.eventBuffer = []
    runtime.chat = {
      platform: 'discord',
      sendNotice: async (content) => {
        notices.push(content)
        return { id: 'notice-1' }
      },
    }

    const result = await runtime.ensureSession({ prompt: 'hello' })
    undo()
    if (result instanceof Error) throw result
    // The get error was probed as usual (recreation, not migration), and no
    // migration bookkeeping appeared.
    expect(calls).toEqual(['get:ses_pi_owned', 'create'])
    expect(result.migratedFromSessionId).toBeUndefined()
    expect(notices).toEqual([])
  })

  test('without the retirement signal and a working get, nothing changes', async () => {
    const calls: string[] = []
    const notices: string[] = []
    const backend = {
      sessions: {
        get: async ({ sessionId }: { sessionId: string }) => {
          calls.push(`get:${sessionId}`)
          return { id: sessionId, title: 'Resumed' }
        },
        prompt: async () => {},
      },
      catalog: { providers: async () => ({ providers: [], connected: [], defaults: {} }), config: async () => ({}), agents: async () => [] },
      auth: { methods: async () => ({}) },
    } as unknown as AgentBackend
    const undo = migrationScenario({ backend })

    await setThreadSession('thr-migrate-4', 'ses_oc_old')
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    runtime.thread = { id: 'thr-migrate-4' }
    runtime.threadId = 'thr-migrate-4'
    runtime.channelId = 'chan-migrate-4'
    runtime.sdkDirectory = '/tmp/roadie-migration-project'
    runtime.eventBuffer = []
    runtime.chat = {
      platform: 'discord',
      sendNotice: async (content) => {
        notices.push(content)
        return { id: 'notice-1' }
      },
    }

    const result = await runtime.ensureSession({ prompt: 'hello' })
    undo()
    if (result instanceof Error) throw result
    expect(result.migratedFromSessionId).toBeUndefined()
    expect(result.createdNewSession).toBe(false)
    expect(calls).toEqual(['get:ses_oc_old'])
    expect(notices).toEqual([])
  })
})

describe('migration seed history bounds (#230)', () => {
  const message = (content: string) => ({ author: 'alice', bot: false, timestamp: '2026-10-12T10:00:00.000Z', content })

  test('oldest lines are dropped, keeping the newest', () => {
    const lines = boundSeedHistoryLines({
      messages: Array.from({ length: 6 }, (_, index) => message(`message ${index}`)),
      maxMessages: 4,
      maxBytes: 24 * 1024,
    })
    expect(lines).toEqual([
      '2026-10-12T10:00:00.000Z alice: message 2',
      '2026-10-12T10:00:00.000Z alice: message 3',
      '2026-10-12T10:00:00.000Z alice: message 4',
      '2026-10-12T10:00:00.000Z alice: message 5',
    ])
  })

  test('newer messages survive the byte bound older ones do not', () => {
    const lines = boundSeedHistoryLines({
      messages: [message('x'.repeat(600)), message('y'.repeat(600)), message('short last')],
      maxMessages: 50,
      maxBytes: 100,
    })
    // A long line plus the overhead over 100 bytes; only the newest fits.
    expect(lines).toEqual(['2026-10-12T10:00:00.000Z alice: short last'])
  })

  test('an empty history renders no lines', () => {
    expect(boundSeedHistoryLines({ messages: [], maxMessages: 50, maxBytes: 1024 })).toEqual([])
  })
})
