import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  decideConversationIntake,
  readConversationAdmission,
  recordConversationAdmission,
  resolveConversationIntake,
  type ConversationIntakeRequest,
} from './conversation-intake.js'
import { addFilter } from './hooks.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { closeDatabase } from './database.js'
import { setDataDir } from './config.js'

const request: ConversationIntakeRequest = {
  actor: { platform: 'slack', id: 'alice' },
  spaceId: 'team',
  channelId: 'channel',
  threadId: 'thread',
  text: '',
  eligible: true,
  isNewConversation: false,
  createsThread: false,
  hasSession: true,
  mentionsBot: false,
  isCommand: false,
  legacyOutcome: 'respond',
}
const admission = { starterActorId: 'alice', participants: ['alice', 'bob'] }
const policy = {
  intake: {
    start: 'mention' as const,
    continue: 'participants' as const,
    join: 'mention' as const,
    other: 'context' as const,
  },
}
afterEach(async () => {
  setChannelsConfigPath(null)
  await closeDatabase()
})

test.each(['discord', 'slack'])(
  '%s uses the same explicit initiation/continuation/admission decisions',
  (platform) => {
    const decide = (input: Partial<ConversationIntakeRequest>) =>
      decideConversationIntake({
        policy,
        admission,
        request: { ...request, actor: { platform, id: 'alice' }, ...input },
      })
    expect(decide({ isNewConversation: true, createsThread: true, hasSession: false })).toEqual({
      outcome: 'ignore',
      admit: false,
    })
    expect(
      decide({
        isNewConversation: true,
        createsThread: true,
        hasSession: false,
        mentionsBot: true,
      }),
    ).toEqual({ outcome: 'respond', admit: true })
    expect(decide({})).toEqual({ outcome: 'respond', admit: true })
    expect(decide({ actor: { platform, id: 'bob' } })).toEqual({ outcome: 'respond', admit: true })
    expect(decide({ actor: { platform, id: 'charlie' } })).toEqual({
      outcome: 'context',
      admit: false,
    })
    expect(decide({ actor: { platform, id: 'charlie' }, mentionsBot: true })).toEqual({
      outcome: 'respond',
      admit: true,
    })
    expect(decide({ eligible: false, mentionsBot: true })).toEqual({
      outcome: 'ignore',
      admit: false,
    })
    expect(decide({ directedElsewhere: true })).toEqual({ outcome: 'context', admit: false })
  },
)

test('starter-only continuation and never-join are independent from channel eligibility', () => {
  const strict = {
    intake: { continue: 'starter' as const, join: 'never' as const, other: 'ignore' as const },
  }
  expect(decideConversationIntake({ policy: strict, admission, request })).toEqual({
    outcome: 'respond',
    admit: true,
  })
  expect(
    decideConversationIntake({
      policy: strict,
      admission,
      request: { ...request, actor: { platform: 'slack', id: 'bob' }, mentionsBot: true },
    }),
  ).toEqual({ outcome: 'ignore', admit: false })
})

test('context cannot establish a backend session and existing-only refers to physical thread creation', () => {
  expect(
    decideConversationIntake({
      policy,
      admission,
      request: { ...request, actor: { platform: 'slack', id: 'charlie' }, hasSession: false },
    }),
  ).toEqual({ outcome: 'ignore', admit: false })
  const existingOnly = { ...policy, threads: 'existing-only' as const }
  expect(
    decideConversationIntake({
      policy: existingOnly,
      admission: null,
      request: { ...request, isNewConversation: true, createsThread: false, mentionsBot: true },
    }),
  ).toEqual({ outcome: 'respond', admit: true })
  expect(
    decideConversationIntake({
      policy: existingOnly,
      admission: null,
      request: { ...request, isNewConversation: true, createsThread: true, mentionsBot: true },
    }),
  ).toEqual({ outcome: 'ignore', admit: false })
})

test('command-only starts accept an explicit command rather than an ordinary mention', () => {
  const commands = { intake: { start: 'command' as const } }
  expect(
    decideConversationIntake({
      policy: commands,
      admission: null,
      request: { ...request, isNewConversation: true, mentionsBot: true },
    }).outcome,
  ).toBe('ignore')
  expect(
    decideConversationIntake({
      policy: commands,
      admission: null,
      request: { ...request, isNewConversation: true, isCommand: true },
    }).outcome,
  ).toBe('respond')
})

test('durable admission preserves the original starter, isolates spaces, and rejects CLI assertions', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-admission-'))
  setDataDir(temp)
  const scope = { platform: 'slack', spaceId: 'team', threadId: 'thread' }
  const decision = { outcome: 'respond' as const, admit: true }
  await recordConversationAdmission({
    scope,
    actor: { platform: 'slack', id: 'alice' },
    starter: true,
    decision,
  })
  await recordConversationAdmission({
    scope,
    actor: { platform: 'slack', id: 'bob' },
    starter: true,
    decision,
  })
  await recordConversationAdmission({
    scope,
    actor: { platform: 'slack', id: 'fake' },
    starter: true,
    decision,
    actorVia: 'cli',
  })
  await closeDatabase()
  expect(await readConversationAdmission(scope)).toEqual({
    starterActorId: 'alice',
    participants: ['alice', 'bob'],
  })
  expect(await readConversationAdmission({ ...scope, spaceId: 'other-team' })).toBeNull()
  await closeDatabase()
  fs.rmSync(temp, { recursive: true, force: true })
})

test('host filter can choose context-only output but cannot override eligibility or establish a session', async () => {
  const remove = addFilter('conversation_intake', () => ({
    outcome: 'context' as const,
    admit: true,
  }))
  try {
    expect(await resolveConversationIntake({ ...request, threadId: undefined })).toEqual({
      outcome: 'context',
      admit: false,
    })
    expect(
      await resolveConversationIntake({ ...request, threadId: undefined, eligible: false }),
    ).toEqual({ outcome: 'ignore', admit: false })
    expect(
      await resolveConversationIntake({ ...request, threadId: undefined, hasSession: false }),
    ).toEqual({ outcome: 'ignore', admit: false })
  } finally {
    remove()
  }
})
