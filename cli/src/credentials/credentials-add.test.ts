// Credential pools: /credentials add adds an account to a
// pool by reusing the /credentials handlers (issue #137 item 4).
//
// The provider picker lists the models.dev catalog (hermetic fixture via
// $XDG_CACHE_HOME, no network), Anthropic offers both a subscription (OAuth)
// and an API key account, and every write goes through the exact /credentials
// pending-context pipeline — the same target-pool resolution, the same
// shared-pool admin rule, ephemeral replies, keys only ever via a modal. The
// flow tests only open menus and modals, they never submit a key.

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
  handleCredentialsAdd,
  handleLoginSelect,
} from '../commands/credentials-add.js'
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
import { clearIdentityCache } from '../identity.js'

let dataDir: string

// Fixture models.dev catalog preset in the catalog memo
// so the picker stays hermetic (no network).
const TEST_CATALOG = {
  'zai-coding-plan': {
    id: 'zai-coding-plan',
    name: 'z.ai',
    api: 'https://api.z.ai/api/coding/paas/v4',
  },
  groq: { id: 'groq' },
  anthropic: { id: 'anthropic', name: 'Anthropic' },
  openai: { id: 'openai', name: 'OpenAI' },
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
  shared = false,
}: {
  userId?: string
  shared?: boolean
} = {}): { interaction: ChatInputCommandInteraction; replies: ReplyOptions[] } {
  const replies: ReplyOptions[] = []
  const interaction = {
    channelId: 'channel-1',
    options: { getString: () => shared ? 'shared' : null },
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
  admin = false,
}: {
  customId: string
  value: string
  userId?: string
  admin?: boolean
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
      permissions: admin ? '8' : '0',
    },
  }
  return {
    interaction: interaction as unknown as StringSelectMenuInteraction,
    replies,
    modals,
  }
}

/** Drive /credentials add and return the provider-select customId hash it showed. */
async function openPoolLoginPicker(shared = false): Promise<{
  hash: string
  replies: ReplyOptions[]
}> {
  const { interaction, replies } = makeLoginCommandInteraction({ shared })
  await handleCredentialsAdd(interaction)
  const customId = firstSelectCustomId(replies[0] ?? {})
  expect(customId).toMatch(/^login_select:[0-9a-f]{16}$/)
  return { hash: customId!.slice('login_select:'.length), replies }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-login-pool-'))
  setDataDir(dataDir)
  clearIdentityCache()
  store.setState({ credentialPoolsEnabled: true, credentialsMode: 'per-person' })
  resetCatalogCacheForTests(TEST_CATALOG)
})

afterEach(() => {
  store.setState({ credentialPoolsEnabled: false, credentialsMode: 'global' })
  clearIdentityCache()
  resetCatalogCacheForTests()
})

describe('/credentials add with credential pools on', () => {
  test.each(['groq', 'anthropic', 'openai'])('pool:shared survives the %s picker and refuses non-admin writes', async (provider) => {
    const { hash } = await openPoolLoginPicker(true)
    const select = makePoolSelectInteraction({ customId: `login_select:${hash}`, value: provider })
    await handleLoginSelect(select.interaction)
    const final = provider === 'groq' ? select : makePoolSelectInteraction({ customId: `login_select:${hash}`, value: 'oauth' })
    if (final !== select) await handleLoginSelect(final.interaction)
    expect(final.replies.map((r) => r.content).join('\n')).toContain('Only server admins')
    expect(final.modals).toHaveLength(0)
  })

  test.each(['groq', 'anthropic', 'openai'])('an admin adds %s to the selected shared pool', async (provider) => {
    const { hash } = await openPoolLoginPicker(true)
    const select = makePoolSelectInteraction({ customId: `login_select:${hash}`, value: provider, admin: true })
    await handleLoginSelect(select.interaction)
    if (provider === 'groq') {
      const customId = modalCustomId(select.modals[0])
      expect(getCredentialsContext(customId.slice(CREDENTIALS_APIKEY_MODAL_PREFIX.length))).toEqual({ kind: 'apikey', provider, shared: true })
    } else {
      const method = makePoolSelectInteraction({ customId: `login_select:${hash}`, value: 'oauth', admin: true })
      await handleLoginSelect(method.interaction)
      expect(replyText(method.replies)).toContain(`pool ${SHARED_POOL_ID}`)
      const customId = firstSelectCustomId(method.replies[0] ?? {})!
      expect(getCredentialsContext(customId.slice(CREDENTIALS_OAUTH_BUTTON_PREFIX.length))).toMatchObject({
        kind: 'oauth', shared: true, provider: provider === 'openai' ? 'openai-codex' : 'anthropic',
      })
    }
  })

  test('lists the models.dev catalog providers in an ephemeral select, without a project directory', async () => {
    const { replies } = await openPoolLoginPicker()
    // The pool flow never asks for a channel project directory: the picker shows up with only bare interaction context.
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

  test('a non-anthropic provider opens the /credentials add modal, never the login modal', async () => {
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

  test('the anthropic OAuth choice reuses the /credentials add flow', async () => {
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
      flowId: expect.any(String),
    })
    expect(readPoolAccounts({ dataDir, poolId: OWN_POOL })).toEqual([])
  })

  test('the anthropic API key choice opens the /credentials add modal', async () => {
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
