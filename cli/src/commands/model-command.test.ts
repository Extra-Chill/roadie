import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ChannelType, type ChatInputCommandInteraction, type StringSelectMenuInteraction } from 'discord.js'
import type { AgentProviderInfo } from '../agent-backend/types.js'

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  setChannelModel: vi.fn(),
  setGlobalModel: vi.fn(),
  setSessionModel: vi.fn(),
}))
vi.mock('../agent-backend/registry.js', () => ({
  getAgentBackendProvider: () => ({ initializeForDirectory: async () => () => ({ catalog: { providers: mocks.providers } }) }),
}))
vi.mock('../discord-utils.js', () => ({ resolveWorkingDirectory: async () => ({ projectDirectory: '/project', workingDirectory: '/project' }) }))
vi.mock('../database.js', () => ({
  getSessionAgent: vi.fn(), getSessionModel: vi.fn(), getChannelAgent: vi.fn(),
  getChannelModel: vi.fn(), getGlobalModel: vi.fn(), getThreadSession: vi.fn(),
  getVariantCascade: vi.fn(), setSessionAgent: vi.fn(),
  setChannelModel: mocks.setChannelModel, setGlobalModel: mocks.setGlobalModel, setSessionModel: mocks.setSessionModel,
}))
vi.mock('../session-handler/model-utils.js', () => ({ getDefaultModel: async () => undefined }))
import { handleModelCommand, handleModelSelectMenu, handleModelScopeSelectMenu } from './model.js'
import { setPickerHiddenRotations } from '../agent-backend/pi/pool.js'

const pool: AgentProviderInfo = {
  id: 'roadie', name: 'Roadie', models: {
    visible: { id: 'visible', name: 'Visible', variants: [] },
    hidden: { id: 'hidden', name: 'Hidden', variants: [] },
  },
}

async function open(providers: AgentProviderInfo[], connected = providers.map((p) => p.id)) {
  mocks.providers.mockResolvedValue({ providers, connected })
  const editReply = vi.fn()
  await handleModelCommand({
    interaction: {
      deferReply: vi.fn(), editReply, user: { id: 'user' }, channelId: 'channel',
      channel: { id: 'channel', type: ChannelType.GuildText, isThread: () => false },
    } as unknown as ChatInputCommandInteraction,
    appId: 'app',
  })
  return editReply.mock.calls.at(-1)![0]
}

function select(customId: string, value: string) {
  const editReply = vi.fn()
  return { interaction: { customId, values: [value], editReply } as unknown as StringSelectMenuInteraction, editReply }
}

describe('/model entry menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPickerHiddenRotations({ hidden: { entries: ['provider/model'], hidden: true } })
  })

  test('one pickable provider skips provider selection, filters hidden rotations, and retains scope selection', async () => {
    const reply = await open([pool, { id: 'empty', name: 'Empty', models: {} }, { ...pool, id: 'disconnected' }], ['roadie', 'empty'])
    const menu = reply.components[0].components[0].toJSON()
    expect(menu.custom_id).toMatch(/^model_select:/)
    expect(menu.options.map((o: { value: string }) => o.value)).toEqual(['visible'])
    const model = select(menu.custom_id, 'visible')
    await handleModelSelectMenu(model.interaction)
    const scope = model.editReply.mock.calls[0]![0].components[0].components[0].toJSON()
    expect(scope.custom_id).toMatch(/^model_scope:/)
    expect(scope.options.map((o: { value: string }) => o.value)).toEqual(['channel', 'global'])
    await handleModelScopeSelectMenu(select(scope.custom_id, 'global').interaction)
    expect(mocks.setGlobalModel).toHaveBeenCalledWith({ appId: 'app', modelId: 'roadie/visible', variant: null })
    expect(mocks.setChannelModel).toHaveBeenCalledWith({ channelId: 'channel', modelId: 'roadie/visible', variant: null })
  })

  test('single-provider model pagination keeps the provider context', async () => {
    const models = Object.fromEntries(Array.from({ length: 30 }, (_, i) => {
      const id = `model-${String(i).padStart(2, '0')}`
      return [id, { id, name: id, variants: [] }]
    }))
    const reply = await open([{ ...pool, models }])
    const menu = reply.components[0].components[0].toJSON()
    const next = menu.options.at(-1)!
    const page = select(menu.custom_id, next.value)
    await handleModelSelectMenu(page.interaction)
    const paged = page.editReply.mock.calls[0]![0].components[0].components[0].toJSON()
    expect(paged.custom_id).toBe(menu.custom_id)
    expect(paged.options.some((o: { value: string }) => o.value === 'model-29')).toBe(true)
  })

  test('single-provider model selection still offers thinking levels', async () => {
    const reply = await open([{ ...pool, models: { visible: { id: 'visible', name: 'Visible', variants: ['low', 'high'] } } }])
    const model = select(reply.components[0].components[0].data.custom_id, 'visible')
    await handleModelSelectMenu(model.interaction)
    const variants = model.editReply.mock.calls[0]![0].components[0].components[0].toJSON()
    expect(variants.custom_id).toMatch(/^model_variant:/)
    expect(variants.options.map((o: { value: string }) => o.value)).toEqual(['__none__', 'low', 'high'])
  })

  test('several pickable providers retain provider selection', async () => {
    const reply = await open([pool, { ...pool, id: 'other', name: 'Other' }])
    expect(reply.components[0].components[0].data.custom_id).toMatch(/^model_provider:/)
  })

  test('no pickable models produces an explanatory reply without a menu', async () => {
    const reply = await open([{ id: 'empty', name: 'Empty', models: {} }])
    expect(reply.content).toContain('No providers with credentials found')
    expect(reply.components).toBeUndefined()
  })
})
