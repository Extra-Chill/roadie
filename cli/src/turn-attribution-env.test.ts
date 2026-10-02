// Per-turn attribution: DB round-trip, env export, no stale actors.
// Auto-isolated via VITEST guards in config.ts (temp data dir) and db.ts.

import crypto from 'node:crypto'
import { afterAll, describe, expect, test } from 'vitest'
import { closeDb } from './db.js'
import {
  getSessionTurnAttribution,
  setSessionTurnAttribution,
  setThreadSession,
} from './database.js'
import {
  applyTurnAttributionEnv,
  resolveTurnAttribution,
} from './turn-attribution-env.js'

afterAll(async () => {
  await closeDb()
})

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

describe('applyTurnAttributionEnv', () => {
  test('exports thread, channel and actor under ROADIE_ and KIMAKI_ names', () => {
    const env: Record<string, string> = {}
    applyTurnAttributionEnv({
      env,
      attribution: {
        sessionId: 'ses_1',
        threadId: 'thread-1',
        channelId: 'channel-1',
        actor: { platform: 'discord', id: '38', name: 'Chris G', via: 'chat' },
      },
    })
    expect(env).toEqual({
      ROADIE_THREAD_ID: 'thread-1',
      KIMAKI_THREAD_ID: 'thread-1',
      ROADIE_CHANNEL_ID: 'channel-1',
      KIMAKI_CHANNEL_ID: 'channel-1',
      ROADIE_ACTOR_PLATFORM: 'discord',
      KIMAKI_ACTOR_PLATFORM: 'discord',
      ROADIE_ACTOR_ID: '38',
      KIMAKI_ACTOR_ID: '38',
      ROADIE_ACTOR_NAME: 'Chris G',
      KIMAKI_ACTOR_NAME: 'Chris G',
      ROADIE_ACTOR_VIA: 'chat',
      KIMAKI_ACTOR_VIA: 'chat',
    })
  })

  test('removes inherited or previous values when there is no actor', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      ROADIE_ACTOR_ID: 'stale',
      KIMAKI_ACTOR_ID: 'stale',
      KIMAKI_THREAD_ID: 'stale-thread',
      ROADIE_SESSION_ID: 'ses_keep',
    }
    applyTurnAttributionEnv({
      env,
      attribution: { sessionId: 'ses_2', threadId: 'thread-2' },
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      ROADIE_SESSION_ID: 'ses_keep',
      ROADIE_THREAD_ID: 'thread-2',
      KIMAKI_THREAD_ID: 'thread-2',
    })

    applyTurnAttributionEnv({ env, attribution: undefined })
    expect(env).toEqual({ PATH: '/usr/bin', ROADIE_SESSION_ID: 'ses_keep' })
  })
})

describe('session turn attribution', () => {
  test('each turn replaces the previous speaker; a turn without one clears it', async () => {
    const sessionId = id('ses')
    await setSessionTurnAttribution({
      sessionId,
      threadId: 'thread-a',
      channelId: 'channel-a',
      actor: { platform: 'discord', id: 'user-1', name: 'Chubes', via: 'chat' },
    })
    await setSessionTurnAttribution({
      sessionId,
      threadId: 'thread-a',
      channelId: 'channel-a',
      actor: { platform: 'discord', id: 'user-2', name: 'Chris G', via: 'chat' },
    })
    expect(await getSessionTurnAttribution(sessionId)).toEqual({
      sessionId,
      threadId: 'thread-a',
      channelId: 'channel-a',
      actor: { platform: 'discord', id: 'user-2', name: 'Chris G', via: 'chat' },
    })

    // e.g. an automatic retry with no human speaker
    await setSessionTurnAttribution({ sessionId, threadId: 'thread-a', channelId: 'channel-a' })
    expect(await getSessionTurnAttribution(sessionId)).toEqual({
      sessionId,
      threadId: 'thread-a',
      channelId: 'channel-a',
    })
  })

  test('concurrent sessions keep their own speakers', async () => {
    const first = id('ses')
    const second = id('ses')
    await Promise.all([
      setSessionTurnAttribution({
        sessionId: first,
        threadId: 'thread-1',
        actor: { platform: 'discord', id: 'user-1', via: 'chat' },
      }),
      setSessionTurnAttribution({
        sessionId: second,
        threadId: 'thread-2',
        actor: { platform: 'discord', id: 'user-2', via: 'cli' },
      }),
    ])
    expect((await getSessionTurnAttribution(first))?.actor).toEqual({
      platform: 'discord',
      id: 'user-1',
      via: 'chat',
    })
    expect((await getSessionTurnAttribution(second))?.actor).toEqual({
      platform: 'discord',
      id: 'user-2',
      via: 'cli',
    })
  })

  test('stores the person id with the actor, and clears it with the actor', async () => {
    const sessionId = id('ses')
    await setSessionTurnAttribution({
      sessionId,
      threadId: 'thread-p',
      actor: { platform: 'discord', id: 'user-38', via: 'chat' },
      personId: 'wp:38',
    })
    const recorded = await getSessionTurnAttribution(sessionId)
    expect(recorded?.personId).toBe('wp:38')
    const env: Record<string, string> = {}
    applyTurnAttributionEnv({ env, attribution: recorded })
    expect(env.ROADIE_PERSON_ID).toBe('wp:38')
    expect(env.KIMAKI_PERSON_ID).toBe('wp:38')

    await setSessionTurnAttribution({ sessionId, threadId: 'thread-p', personId: 'wp:38' })
    expect((await getSessionTurnAttribution(sessionId))?.personId).toBeUndefined()
  })

  test('falls back to the thread binding when no turn has been recorded', async () => {
    const sessionId = id('ses')
    const threadId = id('thread')
    await setThreadSession(threadId, sessionId)
    expect(await resolveTurnAttribution(sessionId)).toEqual({ sessionId, threadId })
    expect(await resolveTurnAttribution(id('unknown'))).toBeUndefined()
  })
})
