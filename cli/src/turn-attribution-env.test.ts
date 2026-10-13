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
  applyShellEnvTemplates,
  applyTurnAttributionEnv,
  parseShellEnvTemplates,
  resolveTurnAttribution,
  SHELL_ENV_TEMPLATE_FIELDS,
  SHELL_ENV_TEMPLATES_ENV,
} from './turn-attribution-env.js'

afterAll(async () => {
  await closeDb()
})

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

describe('applyTurnAttributionEnv', () => {
  test('exports thread, channel and actor as ROADIE_ variables', () => {
    const env: Record<string, string> = {}
    applyTurnAttributionEnv({
      env,
      attribution: {
        sessionId: 'ses_1',
        threadId: 'thread-1',
        channelId: 'channel-1',
        actor: { platform: 'discord', id: '38', name: 'Team Member', via: 'chat' },
      },
    })
    expect(env).toEqual({
      ROADIE_THREAD_ID: 'thread-1',
      ROADIE_CHANNEL_ID: 'channel-1',
      ROADIE_ACTOR_PLATFORM: 'discord',
      ROADIE_ACTOR_ID: '38',
      ROADIE_ACTOR_NAME: 'Team Member',
      ROADIE_ACTOR_VIA: 'chat',
    })
  })

  test('removes inherited or previous values when there is no actor', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      ROADIE_ACTOR_ID: 'stale',
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
    })

    applyTurnAttributionEnv({ env, attribution: undefined })
    expect(env).toEqual({ PATH: '/usr/bin', ROADIE_SESSION_ID: 'ses_keep' })
  })
})

describe('parseShellEnvTemplates', () => {
  test('parses repeatable NAME=template flag entries', () => {
    expect(parseShellEnvTemplates({
      flag: ['ROADIE_HOOK=https://ops.example/{session_id}', 'ROADIE_LABEL={platform}:{thread_id}'],
    })).toEqual({
      ROADIE_HOOK: 'https://ops.example/{session_id}',
      ROADIE_LABEL: '{platform}:{thread_id}',
    })
  })

  test('a template may contain = signs; the first one separates the name', () => {
    expect(parseShellEnvTemplates({ flag: ['FOO=a=b'] })).toEqual({ FOO: 'a=b' })
  })

  test('parses ROADIE_SHELL_ENV as a JSON object', () => {
    expect(parseShellEnvTemplates({ json: '{"FOO":"{session_id}"}' })).toEqual({ FOO: '{session_id}' })
    expect(parseShellEnvTemplates({ json: '   ' })).toEqual({})
    expect(parseShellEnvTemplates({})).toEqual({})
  })

  test('flag entries win over the same name from ROADIE_SHELL_ENV', () => {
    expect(
      parseShellEnvTemplates({ flag: ['FOO=from-flag'], json: '{"FOO":"from-env","BAR":"{session_id}"}' }),
    ).toEqual({ FOO: 'from-flag', BAR: '{session_id}' })
  })

  test('rejects entries without NAME=template, with empty names or templates', () => {
    expect(parseShellEnvTemplates({ flag: ['NO-SEPARATOR'] })).toBeInstanceOf(Error)
    expect(parseShellEnvTemplates({ flag: ['=value'] })).toBeInstanceOf(Error)
    expect(parseShellEnvTemplates({ flag: ['FOO='] })).toBeInstanceOf(Error)
  })

  test('rejects invalid variable names as a startup error', () => {
    for (const name of ['1BAD', 'HAS-DASH', 'HAS SPACE', 'WITH.DOT']) {
      expect(parseShellEnvTemplates({ flag: [`${name}={session_id}`] })).toBeInstanceOf(Error)
      expect(parseShellEnvTemplates({ json: `{"${name}":"{session_id}"}` })).toBeInstanceOf(Error)
    }
    expect(parseShellEnvTemplates({ flag: ['GOOD_NAME_1={session_id}'] })).toEqual({
      GOOD_NAME_1: '{session_id}',
    })
  })

  test('rejects unknown template fields, including {thread_url}', () => {
    for (const field of ['thread_url', 'bogus', 'SESSION_ID']) {
      const parsed = parseShellEnvTemplates({ flag: [`FOO={${field}}`] })
      expect(parsed).toBeInstanceOf(Error)
      expect((parsed as Error).message).toContain(`{${field}}`)
    }
    expect(SHELL_ENV_TEMPLATE_FIELDS).not.toContain('thread_url')
    expect(parseShellEnvTemplates({ json: '{"FOO":"{thread_url}"}' })).toBeInstanceOf(Error)
  })

  test('rejects malformed ROADIE_SHELL_ENV JSON and non-string values', () => {
    expect(parseShellEnvTemplates({ json: '{nope' })).toBeInstanceOf(Error)
    expect(parseShellEnvTemplates({ json: '["FOO"]' })).toBeInstanceOf(Error)
    expect(parseShellEnvTemplates({ json: '"str"' })).toBeInstanceOf(Error)
    expect(parseShellEnvTemplates({ json: 'null' })).toBeInstanceOf(Error)
    expect(parseShellEnvTemplates({ json: '{"FOO":1}' })).toBeInstanceOf(Error)
    expect(parseShellEnvTemplates({ json: '{"FOO":null}' })).toBeInstanceOf(Error)
  })
})

describe('applyShellEnvTemplates', () => {
  const attribution = {
    sessionId: 'ses_1',
    threadId: 'thread-1',
    channelId: 'channel-1',
    actor: { platform: 'discord', id: '38', name: 'Team Member', via: 'chat' as const },
    personId: 'host:38',
  }

  test('renders every supported field into the configured variables', () => {
    const env: Record<string, string> = {}
    applyShellEnvTemplates({
      env,
      sessionId: 'ses_1',
      attribution,
      templates: {
        SESSION: '{session_id}',
        THREAD: 'thread:{thread_id}',
        CHANNEL: '{channel_id}',
        PLATFORM: '{platform}',
        ACTOR: '{actor_id}',
        PERSON: '{person_id}',
        MIXED: '{platform}:{actor_id}@{session_id}',
      },
    })
    expect(env).toEqual({
      SESSION: 'ses_1',
      THREAD: 'thread:thread-1',
      CHANNEL: 'channel-1',
      PLATFORM: 'discord',
      ACTOR: '38',
      PERSON: 'host:38',
      MIXED: 'discord:38@ses_1',
    })
  })

  test('leaves a variable unset when a referenced field has no value for the turn', () => {
    const env: Record<string, string> = { CHANNEL: 'stale' }
    applyShellEnvTemplates({
      env,
      sessionId: 'ses_2',
      attribution: { sessionId: 'ses_2', threadId: 'thread-2' },
      templates: { THREAD: '{thread_id}', CHANNEL: '{channel_id}', SPEAKER: '{actor_id}', SESSION: '{session_id}' },
    })
    // No channel and no actor on this turn: those variables are unset, and a
    // stale value from an earlier turn cannot survive.
    expect(env).toEqual({ THREAD: 'thread-2', SESSION: 'ses_2' })
  })

  test('with no attribution at all only {session_id} templates resolve', () => {
    const env: Record<string, string> = {}
    applyShellEnvTemplates({
      env,
      sessionId: 'ses_3',
      attribution: undefined,
      templates: { SESSION: '{session_id}', THREAD: '{thread_id}' },
    })
    expect(env).toEqual({ SESSION: 'ses_3' })
  })

  test('applies nothing without templates', () => {
    const env: Record<string, string> = { KEEP: '1' }
    applyShellEnvTemplates({ env, sessionId: 'ses_4', attribution, templates: undefined })
    expect(env).toEqual({ KEEP: '1' })
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
      actor: { platform: 'discord', id: 'user-2', name: 'Team Member', via: 'chat' },
    })
    expect(await getSessionTurnAttribution(sessionId)).toEqual({
      sessionId,
      threadId: 'thread-a',
      channelId: 'channel-a',
      actor: { platform: 'discord', id: 'user-2', name: 'Team Member', via: 'chat' },
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
      personId: 'host:38',
    })
    const recorded = await getSessionTurnAttribution(sessionId)
    expect(recorded?.personId).toBe('host:38')
    const env: Record<string, string> = {}
    applyTurnAttributionEnv({ env, attribution: recorded })
    expect(env.ROADIE_PERSON_ID).toBe('host:38')

    await setSessionTurnAttribution({ sessionId, threadId: 'thread-p', personId: 'host:38' })
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
