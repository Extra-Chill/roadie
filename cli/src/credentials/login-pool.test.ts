// Credential pools: /login with --credential-pools on adds an account to a
// pool by reusing the /credentials handlers (issue #137 item 4).
//
// The provider picker lists the models.dev catalog (hermetic fixture via
// $XDG_CACHE_HOME, no network), Anthropic offers both a subscription (OAuth)
// and an API key account, and every write goes through the exact /credentials
// pending-context pipeline — the same target-pool resolution, the same
// shared-pool admin rule, ephemeral replies, keys only ever via a modal. The
// flow tests only open menus and modals, they never submit a key, and the
// opencode auth.json path (project directory, auth API) is never entered.
// With pools off, /login keeps its old behavior.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js'
import {
  buildPoolLoginProviderOptions,
  handleLoginCommand,
  handleLoginSelect,
} from '../commands/login.js'
import {
  CREDENTIALS_APIKEY_MODAL_PREFIX,
  CREDENTIALS_OAUTH_BUTTON_PREFIX,
  getCredentialsContext,
} from '../commands/credentials.js'
import { ANTHROPIC_OAUTH_AUTHORIZE_URL } from './adapters/anthropic-oauth.js'
import { SHARED_POOL_ID, readPoolAccounts } from './store.js'
import { resetCatalogCacheForTests } from './provider-catalog.js'
import { setDataDir } from '../config.js'
import { store } from '../store.js'
import { setIdentityHookCommand } from '../identity.js'

let dataDir: string
let originalXdgCacheHome: string | undefined

// Fixture models.dev catalog served through $XDG_CACHE_HOME/opencode/models.json
// so the picker stays hermetic (no network).
const TEST_CATALOG = {
  'zai-coding-plan': {
    id: 'zai-coding-plan',
    name: 'z.ai',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.z.ai/api/coding/paas/v4',
  },
  groq: { id: 'groq', npm: '@ai-sdk/groq' },
  anthropic: { id: 'anthropic', name: 'Anthropic', npm: '@ai-sdk/anthropic' },
  openai: { id: 'openai', name: 'OpenAI', npm: '@ai-sdk/openai' },
}

const USER_ID = '777000111222333444'
const OWN_POOL = 'discord:777000111222333444'

// ── Interaction doubles ─────────────────────────────────────────

type SelectOptionJSON = { label?: string; value?: string }
type RowJSON = { components?: Array<{ custom_id?: string; options?: SelectOptionJSON[] }> }
type ReplyOptions = { content?: string; components?: unknown }

const replyText = (replies: ReplyOptions[]): string =>
  replies.map((reply) => reply.content ?? '').join('\n')

function firstSelectCustomId(options: ReplyOptions): string | undefined {
  const rows = options.components as Array<{ toJSON: () => RowJSON }> | undefined
  return rows?.[0]?.toJSON().components?.[0]?.custom_id
}

function firstSelectOptions(options: ReplyOptions): SelectOptionJSON[] {
  const rows = options.components as Array<{ toJSON: () => RowJSON }> | undefined
  return rows?.[0]?.toJSON().components?.[0]?.options ?? []
}

function modalCustomId(modal: unknown): string {
  const json = (modal as { toJSON?: () => { custom_id?: string } }).toJSON?.()
  return json?.custom_id ?? (modal as { customId?: string }).customId ?? ''
}

function makeLoginCommandInteraction({
  userId = USER_ID,
}: {
  userId?: string
} = {}): { interaction: ChatInputCommandInteraction; replies: ReplyOptions[] } {
  const replies: ReplyOptions[] = []
  const interaction = {
    channelId: 'channel-1',
    deferReply: async () => {},
    editReply: async (options: ReplyOptions) => {
      replies.push(options)
      return {}
    },
    guild: { id: 'guild-1' },
    user: { id: userId, displayName: 'Tester' },
    member: {
      user: { id: userId },
      roles: [],
      permissions: '0',
    },
  }
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies }
}

function makePoolSelectInteraction({
  customId,
  value,
  userId = USER_ID,
}: {
  customId: string
  value: string
  userId?: string
}): {
  interaction: StringSelectMenuInteraction
  replies: ReplyOptions[]
  modals: unknown[]
} {
  const replies: ReplyOptions[] = []
  const modals: unknown[] = []
  const interaction = {
    customId,
    values: [value],
    deferUpdate: async () => {},
    deferReply: async () => {},
    reply: async (options: ReplyOptions) => {
      replies.push(options)
      return {}
    },
    editReply: async (options: ReplyOptions) => {
      replies.push(options)
      return {}
    },
    showModal: async (modal: unknown) => {
      modals.push(modal)
    },
    guild: { id: 'guild-1' },
    channelId: 'channel-1',
    user: { id: userId, displayName: 'Tester' },
    member: {
      user: { id: userId },
      roles: [],
      permissions: '0',
    },
  }
  return {
    interaction: interaction as unknown as StringSelectMenuInteraction,
    replies,
    modals,
  }
}

/** Drive /login and return the provider-select customId hash it showed. */
async function openPoolLoginPicker(): Promise<{
  hash: string
  replies: ReplyOptions[]
}> {
  const { interaction, replies } = makeLoginCommandInteraction()
  await handleLoginCommand({ interaction, appId: 'app-1' })
  const customId = firstSelectCustomId(replies[0] ?? {})
  expect(customId).toMatch(/^login_select:[0-9a-f]{16}$/)
  return { hash: customId!.slice('login_select:'.length), replies }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-login-pool-'))
  setDataDir(dataDir)
  setIdentityHookCommand(null)
  store.setState({ credentialPoolsEnabled: true, credentialsMode: 'per-person' })
  originalXdgCacheHome = process.env.XDG_CACHE_HOME
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-login-pool-cache-'))
  fs.mkdirSync(path.join(cacheHome, 'opencode'), { recursive: true })
  fs.writeFileSync(path.join(cacheHome, 'opencode', 'models.json'), JSON.stringify(TEST_CATALOG))
  process.env.XDG_CACHE_HOME = cacheHome
  resetCatalogCacheForTests()
})

afterEach(() => {
  store.setState({ credentialPoolsEnabled: false, credentialsMode: 'global' })
  setIdentityHookCommand(null)
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  resetCatalogCacheForTests()
})

describe('/login with credential pools on', () => {
  test('lists the models.dev catalog providers in an ephemeral select, without a project directory', async () => {
    const { replies } = await openPoolLoginPicker()
    // The pool flow never asks for a channel project directory or an opencode
    // server: the picker shows up with only bare interaction context.
    expect(replies[0]?.content).toContain('Add a provider account to your credential pool')
    const options = firstSelectOptions(replies[0] ?? {})
    expect(options.map((option) => option.value)).toEqual([
      'anthropic',
      'openai',
      'groq',
      'zai-coding-plan',
    ])
    expect(options[3]?.label).toBe('z.ai')
  })

  test('a non-anthropic provider opens the /credentials add-key modal, never the login modal', async () => {
    const { hash, replies } = await openPoolLoginPicker()
    const { interaction, modals } = makePoolSelectInteraction({
      customId: `login_select:${hash}`,
      value: 'groq',
    })
    await handleLoginSelect(interaction)
    expect(modals).toHaveLength(1)
    const customId = modalCustomId(modals[0])
    expect(customId.startsWith(CREDENTIALS_APIKEY_MODAL_PREFIX)).toBe(true)
    // The pending context is the exact /credentials one, so the existing
    // modal-submit handler (pool resolution + admin re-check) consumes it.
    const context = getCredentialsContext(customId.slice(CREDENTIALS_APIKEY_MODAL_PREFIX.length))
    expect(context).toEqual({ kind: 'apikey', provider: 'groq', shared: false })
    // No key exists anywhere yet: the modal was opened, nothing was written.
    expect(readPoolAccounts({ dataDir, poolId: OWN_POOL })).toEqual([])
    expect(replies.join('\n')).not.toContain('login_apikey')
  })

  test('anthropic offers subscription (OAuth) and API key account types', async () => {
    const { hash } = await openPoolLoginPicker()
    const { interaction, replies } = makePoolSelectInteraction({
      customId: `login_select:${hash}`,
      value: 'anthropic',
    })
    await handleLoginSelect(interaction)
    const customId = firstSelectCustomId(replies[0] ?? {})
    expect(customId).toMatch(/^login_select:[0-9a-f]{16}$/)
    const options = firstSelectOptions(replies[0] ?? {})
    expect(options.map((option) => option.value)).toEqual(['oauth', 'api'])
    expect(options[0]?.label).toContain('subscription')
    expect(options[1]?.label).toContain('API key')
  })

  test('the anthropic OAuth choice reuses the /credentials login-anthropic flow', async () => {
    const { hash } = await openPoolLoginPicker()
    const provider = makePoolSelectInteraction({
      customId: `login_select:${hash}`,
      value: 'anthropic',
    })
    await handleLoginSelect(provider.interaction)
    const methodCustomId = firstSelectCustomId(provider.replies[0] ?? {})
    const method = makePoolSelectInteraction({
      customId: methodCustomId!,
      value: 'oauth',
    })
    await handleLoginSelect(method.interaction)
    expect(method.replies).toHaveLength(1)
    const content = method.replies[0]?.content ?? ''
    expect(content).toContain(`Adding a Claude account to pool ${OWN_POOL}`)
    expect(content).toContain(ANTHROPIC_OAUTH_AUTHORIZE_URL)
    // The paste button carries the /credentials OAuth context, consumed by
    // the existing button + modal handlers.
    const buttonCustomId = firstSelectCustomId(method.replies[0] ?? {})
    expect(buttonCustomId?.startsWith(CREDENTIALS_OAUTH_BUTTON_PREFIX)).toBe(true)
    const context = getCredentialsContext(buttonCustomId!.slice(CREDENTIALS_OAUTH_BUTTON_PREFIX.length))
    expect(context).toEqual({
      kind: 'oauth',
      provider: 'anthropic',
      shared: false,
      state: expect.any(String),
      verifier: expect.any(String),
    })
    expect(readPoolAccounts({ dataDir, poolId: OWN_POOL })).toEqual([])
  })

  test('the anthropic API key choice opens the /credentials add-key modal', async () => {
    const { hash } = await openPoolLoginPicker()
    const provider = makePoolSelectInteraction({
      customId: `login_select:${hash}`,
      value: 'anthropic',
    })
    await handleLoginSelect(provider.interaction)
    const methodCustomId = firstSelectCustomId(provider.replies[0] ?? {})
    const method = makePoolSelectInteraction({
      customId: methodCustomId!,
      value: 'api',
    })
    await handleLoginSelect(method.interaction)
    expect(method.modals).toHaveLength(1)
    const customId = modalCustomId(method.modals[0])
    expect(customId.startsWith(CREDENTIALS_APIKEY_MODAL_PREFIX)).toBe(true)
    expect(getCredentialsContext(customId.slice(CREDENTIALS_APIKEY_MODAL_PREFIX.length))).toEqual({
      kind: 'apikey',
      provider: 'anthropic',
      shared: false,
    })
  })

  test('in global mode a non-admin is refused by the shared-pool rule, nothing opens', async () => {
    store.setState({ credentialsMode: 'global' })
    const { hash } = await openPoolLoginPicker()
    const { interaction, replies, modals } = makePoolSelectInteraction({
      customId: `login_select:${hash}`,
      value: 'groq',
    })
    await handleLoginSelect(interaction)
    expect(modals).toHaveLength(0)
    expect(replyText(replies)).toContain('Only server admins can manage the shared credential pool')
    expect(readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })).toEqual([])
    expect(readPoolAccounts({ dataDir, poolId: OWN_POOL })).toEqual([])
  })
})

describe('/login with credential pools off', () => {
  test('keeps the auth.json flow: no pool picker, unchanged channel requirement', async () => {
    store.setState({ credentialPoolsEnabled: false })
    const { interaction, replies } = makeLoginCommandInteraction()
    await handleLoginCommand({ interaction, appId: 'app-1' })
    expect(replyText(replies)).not.toContain('credential pool')
    // The unchanged flow still requires a configured channel before anything
    // opencode-related happens.
    expect(replyText(replies)).toContain('This command can only be used in a channel')
  })
})

describe('buildPoolLoginProviderOptions', () => {
  test('popular catalog ids first, then alphabetical, labels from the catalog', () => {
    const options = buildPoolLoginProviderOptions({
      'zzz-tail': { id: 'zzz-tail' },
      'zai-coding-plan': { id: 'zai-coding-plan', name: 'z.ai' },
      groq: { id: 'groq' },
      openai: { id: 'openai', name: 'OpenAI' },
      anthropic: { id: 'anthropic', name: 'Anthropic' },
    })
    expect(options.map((option) => option.value)).toEqual([
      'anthropic',
      'openai',
      'groq',
      'zai-coding-plan',
      'zzz-tail',
    ])
    expect(options[0]?.label).toBe('Anthropic')
    expect(options[0]?.description).toBe('anthropic')
    expect(options[2]?.label).toBe('groq')
    expect(options[2]?.description).toBeUndefined()
    expect(options[3]?.description).toBe('zai-coding-plan')
  })
})
