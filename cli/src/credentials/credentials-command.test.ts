// Credential pools phase 2b: /credentials command behavior.
//
// Modal key handling (stored in the right pool, never echoed), the OAuth
// paste flow's parsing and pending-PKCE TTL, rotation seeding for new person
// pools, and the registration gating (/credentials only when credential
// pools are on, /login untouched). Uses minimal interaction doubles; the
// only key ever used here is an obviously fake test string.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ModalSubmitInteraction } from 'discord.js'
import {
  CREDENTIALS_APIKEY_MODAL_PREFIX,
  CREDENTIALS_CONTEXT_TTL_MS,
  CREDENTIALS_OAUTH_MODAL_PREFIX,
  createCredentialsContext,
  getCredentialsContext,
  handleCredentialsApiKeyModalSubmit,
  handleCredentialsOAuthCodeModalSubmit,
} from '../commands/credentials.js'
import {
  buildCredentialsSlashCommand,
  buildRegistrableStaticCommands,
  buildStaticSlashCommands,
} from '../discord-command-registration.js'
import { parseManualInput } from './adapters/anthropic-oauth.js'
import {
  SHARED_POOL_ID,
  readPoolAccounts,
  readPoolRotations,
  seedPoolRotations,
  setPoolRotation,
} from './store.js'
import { setDataDir } from '../config.js'
import { store } from '../store.js'
import { setIdentityHookCommand } from '../identity.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-credentials-command-'))
  setDataDir(dataDir)
  setIdentityHookCommand(null)
  store.setState({ credentialsMode: 'per-person' })
})

afterEach(() => {
  store.setState({ credentialsMode: 'global' })
  setIdentityHookCommand(null)
})

// Obviously fake key: the masked suffix (ZZ22) can never appear in a
// lowercase hex account id, so "not in the reply" is assertable.
const TEST_KEY = 'sk-ant-TESTKEYQQ11ZZ22'
const USER_ID = '777000111222333444'
const OWN_POOL = 'discord:777000111222333444'

type EditReplyOptions = { content?: string }

function makeApiKeyModalInteraction({
  hash,
  key,
  userId = USER_ID,
  admin = false,
}: {
  hash: string
  key: string
  userId?: string
  admin?: boolean
}): { interaction: ModalSubmitInteraction; replies: string[] } {
  const replies: string[] = []
  const interaction = {
    customId: `${CREDENTIALS_APIKEY_MODAL_PREFIX}${hash}`,
    fields: { getTextInputValue: (_name: string) => key },
    deferReply: async () => {},
    editReply: async (options: EditReplyOptions) => {
      replies.push(options.content ?? '')
      return {}
    },
    guild: { id: 'guild-1' },
    channelId: 'channel-1',
    user: { id: userId, displayName: 'Tester' },
    member: {
      user: { id: userId },
      roles: [],
      permissions: admin ? '8' : '0',
    },
  }
  return { interaction: interaction as unknown as ModalSubmitInteraction, replies }
}

function makeOAuthModalInteraction({
  hash,
  pasted,
  admin = false,
}: {
  hash: string
  pasted: string
  admin?: boolean
}): { interaction: ModalSubmitInteraction; replies: string[] } {
  const replies: string[] = []
  const interaction = {
    customId: `${CREDENTIALS_OAUTH_MODAL_PREFIX}${hash}`,
    fields: { getTextInputValue: (_name: string) => pasted },
    deferUpdate: async () => {},
    editReply: async (options: EditReplyOptions) => {
      replies.push(options.content ?? '')
      return {}
    },
    guild: { id: 'guild-1' },
    channelId: 'channel-1',
    user: { id: USER_ID, displayName: 'Tester' },
    member: {
      user: { id: USER_ID },
      roles: [],
      permissions: admin ? '8' : '0',
    },
  }
  return { interaction: interaction as unknown as ModalSubmitInteraction, replies }
}

describe('/credentials add-key modal', () => {
  test('stores the key in the caller own pool and never echoes it', async () => {
    const hash = createCredentialsContext({
      kind: 'apikey',
      provider: 'anthropic',
      shared: false,
    })
    const { interaction, replies } = makeApiKeyModalInteraction({ hash, key: TEST_KEY })
    await handleCredentialsApiKeyModalSubmit(interaction)
    expect(replies).toHaveLength(1)
    const accounts = readPoolAccounts({ dataDir, poolId: OWN_POOL })
    expect(accounts).not.toBeInstanceOf(Error)
    if (accounts instanceof Error) return
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ provider: 'anthropic', type: 'api', key: TEST_KEY })
    const replyText = replies.join('\n')
    expect(replyText).not.toContain(TEST_KEY)
    expect(replyText).not.toContain('ZZ22')
    expect(replyText).toContain(OWN_POOL)
  })

  test('an admin can target the shared pool', async () => {
    const hash = createCredentialsContext({
      kind: 'apikey',
      provider: 'openai',
      shared: true,
    })
    const { interaction, replies } = makeApiKeyModalInteraction({
      hash,
      key: TEST_KEY,
      admin: true,
    })
    await handleCredentialsApiKeyModalSubmit(interaction)
    expect(replies.join('\n')).toContain(`pool ${SHARED_POOL_ID}`)
    const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
    expect(accounts).not.toBeInstanceOf(Error)
    if (accounts instanceof Error) return
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ provider: 'openai', key: TEST_KEY })
  })

  test('re-checks shared-pool admin at submit time and refuses a non-admin', async () => {
    // The click context says "shared" (it was created for an admin click);
    // the submit re-checks permissions and must not trust it.
    const hash = createCredentialsContext({
      kind: 'apikey',
      provider: 'anthropic',
      shared: true,
    })
    const { interaction, replies } = makeApiKeyModalInteraction({ hash, key: TEST_KEY })
    await handleCredentialsApiKeyModalSubmit(interaction)
    expect(replies.join('\n')).toContain('Only server admins')
    expect(readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([])
    expect(readPoolAccounts({ dataDir, poolId: OWN_POOL })).toEqual([])
  })

  test('seeds the shared rotations into a new person pool once', async () => {
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
    })
    const hash = createCredentialsContext({
      kind: 'apikey',
      provider: 'anthropic',
      shared: false,
    })
    const { interaction, replies } = makeApiKeyModalInteraction({ hash, key: TEST_KEY })
    await handleCredentialsApiKeyModalSubmit(interaction)
    expect(replies.join('\n')).not.toContain('Could not copy')
    expect(readPoolRotations({ dataDir, poolId: OWN_POOL })).toEqual({
      default: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
    })
  })

  test('an expired or unknown modal context is refused', async () => {
    const { interaction, replies } = makeApiKeyModalInteraction({
      hash: 'deadbeefdeadbeef',
      key: TEST_KEY,
    })
    await handleCredentialsApiKeyModalSubmit(interaction)
    expect(replies.join('\n')).toContain('expired')
    expect(readPoolAccounts({ dataDir, poolId: OWN_POOL })).toEqual([])
  })

  test('an empty key is refused', async () => {
    const hash = createCredentialsContext({
      kind: 'apikey',
      provider: 'anthropic',
      shared: false,
    })
    const { interaction, replies } = makeApiKeyModalInteraction({ hash, key: '   ' })
    await handleCredentialsApiKeyModalSubmit(interaction)
    expect(replies.join('\n')).toContain('API key is required')
    expect(readPoolAccounts({ dataDir, poolId: OWN_POOL })).toEqual([])
  })
})

describe('/credentials login-anthropic paste modal', () => {
  test('parses code#state and a full redirect URL', () => {
    expect(parseManualInput('abc123#state-1')).toEqual({ code: 'abc123', state: 'state-1' })
    expect(
      parseManualInput('http://localhost:53692/callback?code=abc123&state=state-2'),
    ).toEqual({ code: 'abc123', state: 'state-2' })
  })

  test('expired PKCE state is dropped after the TTL', () => {
    const hash = createCredentialsContext({
      kind: 'oauth',
      provider: 'anthropic',
      verifier: 'verifier-1',
      state: 'state-1',
      shared: false,
    })
    const now = Date.now()
    expect(getCredentialsContext(hash, now + CREDENTIALS_CONTEXT_TTL_MS - 1000)).toBeDefined()
    expect(getCredentialsContext(hash, now + CREDENTIALS_CONTEXT_TTL_MS + 1000)).toBeUndefined()
  })

  test('an unknown or expired paste modal hash is refused', async () => {
    const { interaction, replies } = makeOAuthModalInteraction({
      hash: 'deadbeefdeadbeef',
      pasted: 'abc123#state-1',
    })
    await handleCredentialsOAuthCodeModalSubmit(interaction)
    expect(replies.join('\n')).toContain('expired')
  })

  test('an empty paste is refused without touching the network', async () => {
    const hash = createCredentialsContext({
      kind: 'oauth',
      provider: 'anthropic',
      verifier: 'verifier-1',
      state: 'state-1',
      shared: false,
    })
    const { interaction, replies } = makeOAuthModalInteraction({ hash, pasted: '   ' })
    await handleCredentialsOAuthCodeModalSubmit(interaction)
    expect(replies.join('\n')).toContain('Authorization code is required')
  })
})

describe('rotation seeding for new person pools', () => {
  test('copies the shared rotations once under the same names', async () => {
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['anthropic/claude-sonnet-4'],
    })
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'backup',
      entries: ['openai/gpt-5'],
    })
    expect(await seedPoolRotations({ dataDir, poolId: 'alice' })).toBe(2)
    expect(readPoolRotations({ dataDir, poolId: 'alice' })).toEqual({
      default: ['anthropic/claude-sonnet-4'],
      backup: ['openai/gpt-5'],
    })
    // Never overwrites: the second call (and any existing rotation) is a no-op.
    expect(await seedPoolRotations({ dataDir, poolId: 'alice' })).toBe(0)
  })

  test('never overwrites rotations the pool already has', async () => {
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['anthropic/claude-sonnet-4'],
    })
    await setPoolRotation({
      dataDir,
      poolId: 'alice',
      name: 'mine',
      entries: ['openai/gpt-5'],
    })
    expect(await seedPoolRotations({ dataDir, poolId: 'alice' })).toBe(0)
    expect(readPoolRotations({ dataDir, poolId: 'alice' })).toEqual({
      mine: ['openai/gpt-5'],
    })
  })

  test('is a no-op for the shared pool itself and when the source has none', async () => {
    expect(await seedPoolRotations({ dataDir, poolId: 'carol' })).toBe(0)
    expect(readPoolRotations({ dataDir, poolId: 'carol' })).toEqual({})
    await setPoolRotation({
      dataDir,
      poolId: SHARED_POOL_ID,
      name: 'default',
      entries: ['anthropic/claude-sonnet-4'],
    })
    expect(await seedPoolRotations({ dataDir, poolId: SHARED_POOL_ID })).toBe(0)
  })
})

describe('/credentials registration gating', () => {
  test('buildStaticSlashCommands never contains credentials', () => {
    expect(buildStaticSlashCommands().some((c) => c.name === 'credentials')).toBe(false)
  })

  test('not registered when credential pools are off; /login unchanged', () => {
    const commands = buildRegistrableStaticCommands({ credentialPoolsEnabled: false })
    const names = commands.map((c) => c.name)
    expect(names).not.toContain('credentials')
    const login = commands.find((c) => c.name === 'login')
    expect(login?.description).toBe(
      'Authenticate with an AI provider (OAuth or API key). Use this instead of /connect',
    )
  })

  test('registered once when credential pools are on, with the four subcommands', () => {
    const registered = buildRegistrableStaticCommands({ credentialPoolsEnabled: true })
    expect(registered.map((c) => c.name).filter((n) => n === 'credentials')).toHaveLength(1)
    const json = buildCredentialsSlashCommand().toJSON()
    expect((json.options ?? []).map((o) => o.name)).toEqual([
      'list',
      'add-key',
      'login-anthropic',
      'remove',
    ])
  })

  test('the key is never a slash-command option; provider is a required choice', () => {
    type RegisteredOption = {
      name: string
      required?: boolean
      choices?: Array<{ name: string; value: string }>
    }
    const json = buildCredentialsSlashCommand().toJSON()
    for (const sub of (json.options ?? []) as unknown as RegisteredOption[]) {
      for (const option of sub.choices ? [] : ((sub as unknown as { options?: RegisteredOption[] }).options ?? [])) {
        expect(option.name).not.toBe('key')
        expect(option.name).not.toBe('apikey')
      }
    }
    const addKey = (json.options ?? []).find((o) => o.name === 'add-key')
    const provider = ((addKey as unknown as { options?: RegisteredOption[] }).options ?? []).find(
      (o) => o.name === 'provider',
    )
    expect(provider?.required).toBe(true)
    expect(provider?.choices?.map((c) => c.value)).toEqual(['anthropic', 'openai'])
  })
})
