// /login command — authenticate with AI providers (OAuth or API key).
//
// With --credential-pools off (the default) the flow is unchanged: it drives
// the OpenCode auth API, which writes OpenCode's own auth.json.
//
// With --credential-pools on, /login never touches OpenCode auth.json. The
// provider picker lists the models.dev catalog and the writes go through the
// /credentials handlers (startCredentialsApiKeyModal +
// startCredentialsAnthropicOAuth): same target-pool resolution, same
// shared-pool admin rule, ephemeral replies, keys only ever via a modal.
//
// Uses a unified select handler (`login_select:<hash>`) for all sequential
// select menus (provider → method → plugin prompts). The context tracks a
// `step` field so one handler drives the whole flow.
//
// CustomId patterns:
//   login_select:<hash>  — all select menus (provider, method, prompts)
//   login_apikey:<hash>  — API key modal submission
//   login_text:<hash>    — text prompt modal submission
//
// (The pool flow reuses login_select for its provider/method menus but hands
// off to the credentials_apikey:/credentials_oauth_code_* customIds, whose
// dispatch and gating live in interaction-handler.ts and commands/credentials.ts.)

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ChannelType,
  type ThreadChannel,
  type TextChannel,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import type { AgentAuthMethod, AgentAuthPrompt } from '../agent-backend/types.js'
import { resolveTextChannel, getRoadieMetadata } from '../discord-utils.js'
import { clearModelListCache } from '../session-handler/model-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { buildPaginatedOptions, parsePaginationValue } from './paginated-select.js'
import { getDataDir } from '../config.js'
import { store } from '../store.js'
import {
  resolveCatalog,
  type ModelsDevCatalog,
} from '../credentials/provider-catalog.js'
import {
  startCredentialsApiKeyModal,
  startCredentialsAnthropicOAuth,
} from './credentials.js'

const loginLogger = createLogger(LogPrefix.LOGIN)

// ── Types ───────────────────────────────────────────────────────

type AuthPrompt = AgentAuthPrompt
type ProviderAuthMethod = AgentAuthMethod

// ── Login step state machine ────────────────────────────────────
// Each step describes what the next select menu should show.
// Steps are built lazily: provider step is set by /login, method
// and prompt steps are added after the provider is selected.

type StepProvider = { type: 'provider' }
type StepMethod = { type: 'method'; methods: ProviderAuthMethod[] }
type StepPrompt = { type: 'prompt'; prompt: AuthPrompt }
/** Pool flow: the account-type menu for a provider (Anthropic OAuth vs API key). */
type StepPoolMethod = { type: 'pool-method'; provider: string }
type LoginStep = StepProvider | StepMethod | StepPrompt | StepPoolMethod

type LoginContext = {
  dir: string
  channelId: string
  /** Pool flow: writes go to credential pools via the /credentials handlers. */
  pools?: boolean
  providerId?: string
  providerName?: string
  methodIndex?: number
  methodType?: 'oauth' | 'api'
  steps: LoginStep[]
  stepIndex: number
  inputs: Record<string, string>
  providerPage?: number
}

// ── Context store ───────────────────────────────────────────────
// Keyed by random hash to stay under Discord's 100-char customId limit.
// TTL prevents unbounded growth when users open /login and never interact.

const LOGIN_CONTEXT_TTL_MS = 10 * 60 * 1000
const pendingLoginContexts = new Map<string, LoginContext>()

function createContextHash(context: LoginContext): string {
  const hash = crypto.randomBytes(8).toString('hex')
  pendingLoginContexts.set(hash, context)
  setTimeout(() => {
    pendingLoginContexts.delete(hash)
  }, LOGIN_CONTEXT_TTL_MS).unref()
  return hash
}

// ── Provider popularity order ───────────────────────────────────
// Discord select menus cap at 25 options, so we show popular ones first.
// IDs sourced from opencode's provider.list() API (scripts/list-providers.ts).
// `subrouter` leads: it pools every subscription and cycles across them.
const PROVIDER_POPULARITY_ORDER: string[] = [
  'subrouter',
  'anthropic',
  'openai',
  'google',
  'github-copilot',
  'xai',
  'groq',
  'deepseek',
  'opencode',
  'opencode-go',
  'mistral',
  'openrouter',
  'fireworks-ai',
  'togetherai',
  'amazon-bedrock',
  'azure',
  'google-vertex',
  'google-vertex-anthropic',
  // 'cohere',
  'cerebras',
  // 'perplexity',
  'cloudflare-workers-ai',
  // 'novita-ai',
  // 'huggingface',
  'deepinfra',
  'github-models',
  'lmstudio',
  'llama',
]

// ── Helpers ─────────────────────────────────────────────────────

function shouldShowPrompt(
  prompt: AuthPrompt,
  inputs: Record<string, string>,
): boolean {
  if (!prompt.when) {
    return true
  }
  const value = inputs[prompt.when.key]
  if (prompt.when.op === 'eq') {
    return value === prompt.when.value
  }
  if (prompt.when.op === 'neq') {
    return value !== prompt.when.value
  }
  return true
}

function buildSelectMenu({
  customId,
  placeholder,
  options,
}: {
  customId: string
  placeholder: string
  options: Array<{ label: string; value: string; description?: string }>
}): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(options)
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
}

// ── /login command ──────────────────────────────────────────────

export async function handleLoginCommand({
  interaction,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  loginLogger.log('[LOGIN] handleLoginCommand called')

  // Credential pools: /login adds an account to a pool through the
  // /credentials handlers and never touches OpenCode's auth.json. It needs no
  // opencode server or project directory, so the flow below skips all of that.
  if (store.getState().credentialPoolsEnabled) {
    await handlePoolLoginCommand({ command: interaction })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const channel = interaction.channel
  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  let projectDirectory: string | undefined
  let targetChannelId: string

  if (isThread) {
    const thread = channel as ThreadChannel
    const textChannel = await resolveTextChannel(thread)
    const metadata = await getRoadieMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = textChannel?.id || channel.id
  } else if (channel.type === ChannelType.GuildText) {
    const metadata = await getRoadieMetadata(channel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = channel.id
  } else {
    await interaction.editReply({
      content: 'This command can only be used in text channels or threads',
    })
    return
  }

  if (!projectDirectory) {
    await interaction.editReply({
      content: 'This channel is not configured with a project directory',
    })
    return
  }

  try {
    const getClient = await getAgentBackendProvider().initializeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await interaction.editReply({ content: getClient.message })
      return
    }

    const providersResponse = await getClient().catalog.providers({
      directory: projectDirectory,
    })

    if (providersResponse instanceof Error) {
      await interaction.editReply({ content: 'Failed to fetch providers' })
      return
    }

    const { providers: allProviders, connected } = providersResponse

    if (allProviders.length === 0) {
      await interaction.editReply({ content: 'No providers available.' })
      return
    }

    const allProviderOptions = [...allProviders]
      .sort((a, b) => {
        const rankA = PROVIDER_POPULARITY_ORDER.indexOf(a.id)
        const rankB = PROVIDER_POPULARITY_ORDER.indexOf(b.id)
        const posA = rankA === -1 ? Infinity : rankA
        const posB = rankB === -1 ? Infinity : rankB
        if (posA !== posB) {
          return posA - posB
        }
        return a.name.localeCompare(b.name)
      })
      .map((provider) => {
        const isConnected = connected.includes(provider.id)
        return {
          label: `${provider.name}${isConnected ? ' ✓' : ''}`.slice(0, 100),
          value: provider.id,
          description: isConnected
            ? 'Connected - select to re-authenticate'
            : 'Not connected',
        }
      })

    const { options } = buildPaginatedOptions({
      allOptions: allProviderOptions,
      page: 0,
    })

    const context: LoginContext = {
      dir: projectDirectory,
      channelId: targetChannelId,
      steps: [{ type: 'provider' }],
      stepIndex: 0,
      inputs: {},
    }
    const hash = createContextHash(context)

    await interaction.editReply({
      content: '**Authenticate with Provider**\nSelect a provider:',
      components: [
        buildSelectMenu({
          customId: `login_select:${hash}`,
          placeholder: 'Select a provider to authenticate',
          options,
        }),
      ],
    })
  } catch (error) {
    loginLogger.error('Error loading providers:', error)
    await interaction.editReply({
      content: `Failed to load providers: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

// ── Credential-pool flow ────────────────────────────────────────
// With --credential-pools on, /login adds an account to a pool. The provider
// picker comes from the models.dev catalog (#136); the writes reuse the
// /credentials handlers, so target-pool resolution, the shared-pool admin
// rule, ephemeral replies and modal-only keys are identical. OpenCode's
// auth.json is never read or written here.

const POOL_LOGIN_PROVIDER_PROMPT = '**Add a provider account to your credential pool**\nSelect a provider:'

/**
 * Provider options for the pool picker: every models.dev provider, popular
 * ids first (same ordering vocabulary as the auth.json picker), then
 * alphabetical. The description shows the catalog id when the display name
 * differs, since that id is what accounts are stored under.
 */
export function buildPoolLoginProviderOptions(
  catalog: ModelsDevCatalog,
): Array<{ label: string; value: string; description?: string }> {
  return Object.values(catalog)
    .sort((a, b) => {
      const rankA = PROVIDER_POPULARITY_ORDER.indexOf(a.id)
      const rankB = PROVIDER_POPULARITY_ORDER.indexOf(b.id)
      const posA = rankA === -1 ? Number.POSITIVE_INFINITY : rankA
      const posB = rankB === -1 ? Number.POSITIVE_INFINITY : rankB
      if (posA !== posB) {
        return posA - posB
      }
      return (a.name ?? a.id).localeCompare(b.name ?? b.id)
    })
    .map((entry) => ({
      label: (entry.name ?? entry.id).slice(0, 100),
      value: entry.id,
      ...(entry.name && entry.name !== entry.id
        ? { description: entry.id.slice(0, 100) }
        : {}),
    }))
}

async function handlePoolLoginCommand({
  command,
}: {
  command: ChatInputCommandInteraction
}): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const catalog = await resolveCatalog({ dataDir: getDataDir() })
  if (catalog instanceof Error) {
    await command.editReply({
      content: `Could not load the models.dev provider catalog: ${catalog.message}`,
    })
    return
  }
  const context: LoginContext = {
    // The pool flow never talks to the opencode server: dir/channelId stay
    // unused and the target pool is resolved from the interaction instead.
    dir: '',
    channelId: command.channelId ?? '',
    pools: true,
    steps: [{ type: 'provider' }],
    stepIndex: 0,
    inputs: {},
  }
  const hash = createContextHash(context)
  const { options } = buildPaginatedOptions({
    allOptions: buildPoolLoginProviderOptions(catalog),
    page: 0,
  })
  await command.editReply({
    content: POOL_LOGIN_PROVIDER_PROMPT,
    components: [
      buildSelectMenu({
        customId: `login_select:${hash}`,
        placeholder: 'Select a provider to add to your pool',
        options,
      }),
    ],
  })
}

async function handlePoolProviderStep(
  interaction: StringSelectMenuInteraction,
  ctx: LoginContext,
  hash: string,
  providerId: string,
): Promise<void> {
  // Pagination nav — re-render the same provider select from the catalog.
  const navPage = parsePaginationValue(providerId)
  if (navPage !== undefined) {
    await interaction.deferUpdate()
    ctx.providerPage = navPage
    const catalog = await resolveCatalog({ dataDir: getDataDir() })
    if (catalog instanceof Error) {
      await interaction.editReply({
        content: `Could not load the models.dev provider catalog: ${catalog.message}`,
        components: [],
      })
      return
    }
    const { options } = buildPaginatedOptions({
      allOptions: buildPoolLoginProviderOptions(catalog),
      page: navPage,
    })
    await interaction.editReply({
      content: POOL_LOGIN_PROVIDER_PROMPT,
      components: [
        buildSelectMenu({
          customId: `login_select:${hash}`,
          placeholder: 'Select a provider to add to your pool',
          options,
        }),
      ],
    })
    return
  }
  ctx.providerId = providerId
  if (providerId === 'anthropic') {
    // Anthropic offers both a subscription (OAuth) and an API key account.
    ctx.steps = [{ type: 'pool-method', provider: providerId }]
    ctx.stepIndex = 0
    await interaction.deferUpdate()
    await interaction.editReply({
      content: '**Add an Anthropic account to your credential pool**\nSelect account type:',
      components: [
        buildSelectMenu({
          customId: `login_select:${hash}`,
          placeholder: 'Select account type',
          options: [
            {
              label: 'Claude subscription (OAuth)',
              value: 'oauth',
              description: 'Claude Pro/Max login — paste the authorization code',
            },
            {
              label: 'API key',
              value: 'api',
              description: 'Add an Anthropic API key to the pool',
            },
          ],
        }),
      ],
    })
    return
  }
  // Every other provider is an API key account, entered through the same
  // modal /credentials add-key uses (never a menu option, never a reply).
  await startCredentialsApiKeyModal({
    command: interaction,
    provider: providerId,
    requestShared: false,
  })
}

async function handlePoolMethodStep(
  interaction: StringSelectMenuInteraction,
  value: string,
  step: StepPoolMethod,
): Promise<void> {
  if (value === 'oauth') {
    // Same ephemeral authorize-URL + paste-modal flow as
    // /credentials login-anthropic.
    await startCredentialsAnthropicOAuth({
      command: interaction,
      requestShared: false,
    })
    return
  }
  await startCredentialsApiKeyModal({
    command: interaction,
    provider: step.provider,
    requestShared: false,
  })
}

// ── Unified select handler ──────────────────────────────────────
// Handles all select menu interactions for the login flow.
// Reads the current step from context, processes the answer,
// then either shows the next step or proceeds to authorize/API key.

export async function handleLoginSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_select:')) {
    return
  }

  const hash = interaction.customId.replace('login_select:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Selection expired. Please run /login again.',
      components: [],
    })
    return
  }

  const value = interaction.values[0]
  if (!value) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'No option selected.',
      components: [],
    })
    return
  }

  const step = ctx.steps[ctx.stepIndex]
  if (!step) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Invalid state. Please run /login again.',
      components: [],
    })
    return
  }

  try {
    if (step.type === 'provider') {
      if (ctx.pools) {
        await handlePoolProviderStep(interaction, ctx, hash, value)
      } else {
        await handleProviderStep(interaction, ctx, hash, value)
      }
    } else if (step.type === 'pool-method') {
      await handlePoolMethodStep(interaction, value, step)
    } else if (step.type === 'method') {
      await handleMethodStep(interaction, ctx, hash, value, step)
    } else if (step.type === 'prompt') {
      await handlePromptStep(interaction, ctx, hash, value, step)
    }
  } catch (error) {
    loginLogger.error('Error in login select:', error)
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate()
    }
    await interaction.editReply({
      content: `Login error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

// ── Step handlers ───────────────────────────────────────────────

async function handleProviderStep(
  interaction: StringSelectMenuInteraction,
  ctx: LoginContext,
  hash: string,
  providerId: string,
): Promise<void> {
  // Handle pagination nav — re-render the same provider select with new page
  const navPage = parsePaginationValue(providerId)
  if (navPage !== undefined) {
    await interaction.deferUpdate()
    ctx.providerPage = navPage

    const getClient = await getAgentBackendProvider().initializeForDirectory(ctx.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({ content: getClient.message, components: [] })
      return
    }
    const providersResponse = await getClient().catalog.providers({ directory: ctx.dir })
    if (providersResponse instanceof Error) {
      await interaction.editReply({ content: 'Failed to fetch providers', components: [] })
      return
    }
    const { providers: allProviders, connected } = providersResponse
    const allProviderOptions = [...allProviders]
      .sort((a, b) => {
        const rankA = PROVIDER_POPULARITY_ORDER.indexOf(a.id)
        const rankB = PROVIDER_POPULARITY_ORDER.indexOf(b.id)
        const posA = rankA === -1 ? Infinity : rankA
        const posB = rankB === -1 ? Infinity : rankB
        if (posA !== posB) {
          return posA - posB
        }
        return a.name.localeCompare(b.name)
      })
      .map((p) => {
        const isConnected = connected.includes(p.id)
        return {
          label: `${p.name}${isConnected ? ' ✓' : ''}`.slice(0, 100),
          value: p.id,
          description: isConnected ? 'Connected - select to re-authenticate' : 'Not connected',
        }
      })
    const { options } = buildPaginatedOptions({ allOptions: allProviderOptions, page: navPage })
    await interaction.editReply({
      content: '**Authenticate with Provider**\nSelect a provider:',
      components: [
        buildSelectMenu({
          customId: `login_select:${hash}`,
          placeholder: 'Select a provider to authenticate',
          options,
        }),
      ],
    })
    return
  }

  const getClient = await getAgentBackendProvider().initializeForDirectory(ctx.dir)
  if (getClient instanceof Error) {
    await interaction.deferUpdate()
    await interaction.editReply({ content: getClient.message, components: [] })
    return
  }

  const providersResponse = await getClient().catalog.providers({
    directory: ctx.dir,
  })
  const provider = providersResponse instanceof Error
    ? undefined
    : providersResponse.providers.find((p) => p.id === providerId)
  const providerName = provider?.name || providerId

  const authResponse = await getClient().auth.methods({ directory: ctx.dir })
  if (authResponse instanceof Error) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Failed to fetch authentication methods',
      components: [],
    })
    return
  }

  // The server returns prompts in the auth response when the opencode
  // version supports it (dev branch, not yet released as of v1.2.27).
  // Once released, plugin-defined prompts will be collected and passed
  // as inputs to the authorize call automatically.
  const methods: ProviderAuthMethod[] = authResponse[providerId] || [
    { type: 'api', label: 'API Key' },
  ]

  if (methods.length === 0) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: `No authentication methods available for ${providerName}`,
      components: [],
    })
    return
  }

  ctx.providerId = providerId
  ctx.providerName = providerName

  if (methods.length === 1) {
    // Single method — skip method select, go straight to prompts or action
    const method = methods[0]!
    ctx.methodIndex = 0
    ctx.methodType = method.type

    const promptSteps = buildPromptSteps(method)
    if (promptSteps.length > 0) {
      // Has prompts — defer and show first prompt
      ctx.steps = promptSteps
      ctx.stepIndex = 0
      await interaction.deferUpdate()
      await showNextStep(interaction, ctx, hash)
    } else if (method.type === 'api') {
      // API key with no prompts — show modal directly (don't defer)
      await showApiKeyModal(interaction, hash, providerName)
    } else {
      // OAuth with no prompts — defer and authorize
      await interaction.deferUpdate()
      await startOAuthFlow(interaction, ctx, hash)
    }
    return
  }

  // Multiple methods — show method select
  ctx.steps = [
    { type: 'method', methods },
  ]
  ctx.stepIndex = 0
  await interaction.deferUpdate()
  await showNextStep(interaction, ctx, hash)
}

async function handleMethodStep(
  interaction: StringSelectMenuInteraction,
  ctx: LoginContext,
  hash: string,
  value: string,
  step: StepMethod,
): Promise<void> {
  const methodIndex = parseInt(value, 10)
  const method = step.methods[methodIndex]
  if (!method) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Invalid method selected.',
      components: [],
    })
    return
  }

  ctx.methodIndex = methodIndex
  ctx.methodType = method.type

  const promptSteps = buildPromptSteps(method)
  if (promptSteps.length > 0) {
    // Replace remaining steps with prompt steps
    ctx.steps = promptSteps
    ctx.stepIndex = 0
    await interaction.deferUpdate()
    await showNextStep(interaction, ctx, hash)
  } else if (method.type === 'api') {
    // API key with no prompts — show modal directly (don't defer)
    await showApiKeyModal(interaction, hash, ctx.providerName || '')
  } else {
    // OAuth with no prompts
    await interaction.deferUpdate()
    await startOAuthFlow(interaction, ctx, hash)
  }
}

async function handlePromptStep(
  interaction: StringSelectMenuInteraction,
  ctx: LoginContext,
  hash: string,
  value: string,
  step: StepPrompt,
): Promise<void> {
  // Store the answer
  ctx.inputs[step.prompt.key] = value
  ctx.stepIndex++

  // Find the next prompt step that passes its `when` condition
  await interaction.deferUpdate()
  await showNextStep(interaction, ctx, hash)
}

// ── Step rendering ──────────────────────────────────────────────
// Advances through steps, skipping prompts whose `when` condition
// fails, until it finds one to show or reaches the end.

async function showNextStep(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  ctx: LoginContext,
  hash: string,
): Promise<void> {
  // Skip prompts whose `when` condition doesn't match
  while (ctx.stepIndex < ctx.steps.length) {
    const step = ctx.steps[ctx.stepIndex]!
    if (step.type === 'prompt' && !shouldShowPrompt(step.prompt, ctx.inputs)) {
      ctx.stepIndex++
      continue
    }
    break
  }

  if (ctx.stepIndex >= ctx.steps.length) {
    // All steps done — proceed to action
    if (ctx.methodType === 'api') {
      // We're deferred, so show a button that opens the API key modal
      const button = new ButtonBuilder()
        .setCustomId(`login_apikey_btn:${hash}`)
        .setLabel('Enter API Key')
        .setStyle(ButtonStyle.Primary)
      await interaction.editReply({
        content: `**Authenticate with ${ctx.providerName}**\nClick to enter your API key.`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(button),
        ],
      })
    } else {
      await startOAuthFlow(interaction, ctx, hash)
    }
    return
  }

  const step = ctx.steps[ctx.stepIndex]!
  pendingLoginContexts.set(hash, ctx)

  if (step.type === 'method') {
    const options = step.methods.slice(0, 25).map((method, index) => ({
      label: method.label.slice(0, 100),
      value: String(index),
      description:
        method.type === 'oauth'
          ? 'OAuth authentication'
          : 'Enter API key manually',
    }))

    await interaction.editReply({
      content: `**Authenticate with ${ctx.providerName}**\nSelect authentication method:`,
      components: [
        buildSelectMenu({
          customId: `login_select:${hash}`,
          placeholder: 'Select authentication method',
          options,
        }),
      ],
    })
    return
  }

  if (step.type === 'prompt') {
    const prompt = step.prompt
    if (prompt.type === 'select') {
      const options = prompt.options.slice(0, 25).map((opt) => ({
        label: opt.label.slice(0, 100),
        value: opt.value,
        description: opt.hint?.slice(0, 100),
      }))

      await interaction.editReply({
        content: `**Authenticate with ${ctx.providerName}**\n${prompt.message}`,
        components: [
          buildSelectMenu({
            customId: `login_select:${hash}`,
            placeholder: prompt.message.slice(0, 150),
            options,
          }),
        ],
      })
      return
    }

    if (prompt.type === 'text') {
      // Text prompts need a modal, but we're deferred. Show a button.
      const button = new ButtonBuilder()
        .setCustomId(`login_text_btn:${hash}`)
        .setLabel(prompt.message.slice(0, 80))
        .setStyle(ButtonStyle.Primary)

      await interaction.editReply({
        content: `**Authenticate with ${ctx.providerName}**\n${prompt.message}`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(button),
        ],
      })
      return
    }
  }
}

function buildPromptSteps(method: ProviderAuthMethod): StepPrompt[] {
  return (method.prompts || []).map((prompt) => ({
    type: 'prompt' as const,
    prompt,
  }))
}

// ── Text prompt button + modal ──────────────────────────────────
// When a text prompt needs to be shown but we're in a deferred state,
// we show a button. Clicking it opens a modal for text input.

export async function handleLoginTextButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_text_btn:')) {
    return
  }

  const hash = interaction.customId.replace('login_text_btn:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx) {
    await interaction.reply({
      content: 'Selection expired. Please run /login again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const step = ctx.steps[ctx.stepIndex]
  if (!step || step.type !== 'prompt' || step.prompt.type !== 'text') {
    await interaction.reply({
      content: 'Invalid state. Please run /login again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const modal = new ModalBuilder()
    .setCustomId(`login_text:${hash}`)
    .setTitle(`${ctx.providerName || 'Provider'} Login`.slice(0, 45))

  const textInput = new TextInputBuilder()
    .setCustomId('prompt_value')
    .setLabel(step.prompt.message.slice(0, 45))
    .setPlaceholder(
      step.prompt.type === 'text' ? (step.prompt.placeholder || '') : '',
    )
    .setStyle(TextInputStyle.Short)
    .setRequired(true)

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
  )
  await interaction.showModal(modal)
}

export async function handleLoginTextModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_text:')) {
    return
  }

  await interaction.deferUpdate()

  const hash = interaction.customId.replace('login_text:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx) {
    await interaction.editReply({
      content: 'Selection expired. Please run /login again.',
      components: [],
    })
    return
  }

  const step = ctx.steps[ctx.stepIndex]
  if (!step || step.type !== 'prompt' || step.prompt.type !== 'text') {
    await interaction.editReply({
      content: 'Invalid state. Please run /login again.',
      components: [],
    })
    return
  }

  const value = interaction.fields.getTextInputValue('prompt_value')
  if (!value?.trim()) {
    await interaction.editReply({
      content: 'A value is required.',
      components: [],
    })
    return
  }

  ctx.inputs[step.prompt.key] = value.trim()
  ctx.stepIndex++
  await showNextStep(interaction, ctx, hash)
}

// ── API key button + modal ──────────────────────────────────────
// When we're deferred and need an API key modal, show a button first.

export async function handleLoginApiKeyButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_apikey_btn:')) {
    return
  }

  const hash = interaction.customId.replace('login_apikey_btn:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx || !ctx.providerName) {
    await interaction.reply({
      content: 'Selection expired. Please run /login again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await showApiKeyModal(interaction, hash, ctx.providerName)
}

async function showApiKeyModal(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  hash: string,
  providerName: string,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`login_apikey:${hash}`)
    .setTitle(`${providerName} API Key`.slice(0, 45))

  const apiKeyInput = new TextInputBuilder()
    .setCustomId('apikey')
    .setLabel('API Key')
    .setPlaceholder('sk-...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput),
  )
  await interaction.showModal(modal)
}

// ── OAuth code submission (code mode) ───────────────────────────
// When the OAuth flow returns method="code", the user completes login
// in a browser (possibly on a different machine) and pastes the final
// callback URL or authorization code here.

export async function handleOAuthCodeButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_oauth_code_btn:')) {
    return
  }

  const hash = interaction.customId.replace('login_oauth_code_btn:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx || !ctx.providerId || !ctx.providerName) {
    await interaction.reply({
      content: 'Selection expired. Please run /login again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const modal = new ModalBuilder()
    .setCustomId(`login_oauth_code:${hash}`)
    .setTitle(`${ctx.providerName} Authorization`.slice(0, 45))

  const codeInput = new TextInputBuilder()
    .setCustomId('oauth_code')
    .setLabel('Authorization code or callback URL')
    .setPlaceholder('Paste the code or full callback URL')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(codeInput),
  )
  await interaction.showModal(modal)
}

export async function handleOAuthCodeModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_oauth_code:')) {
    return
  }

  await interaction.deferUpdate()

  const hash = interaction.customId.replace('login_oauth_code:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx || !ctx.providerId || !ctx.providerName || ctx.methodIndex === undefined) {
    await interaction.editReply({
      content: 'Session expired. Please run /login again.',
      components: [],
    })
    return
  }

  const code = interaction.fields.getTextInputValue('oauth_code')?.trim()
  if (!code) {
    await interaction.editReply({
      content: 'Authorization code is required.',
      components: [],
    })
    return
  }

  try {
    const getClient = await getAgentBackendProvider().initializeForDirectory(ctx.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({
        content: getClient.message,
        components: [],
      })
      return
    }

    await interaction.editReply({
      content: `**Authenticating with ${ctx.providerName}**\nVerifying authorization...`,
      components: [],
    })

    const finished = await getClient().auth.finishOAuth({
      directory: ctx.dir,
      providerId: ctx.providerId,
      method: ctx.methodIndex,
      code,
    })

    if (finished instanceof Error) {
      pendingLoginContexts.delete(hash)
      await interaction.editReply({
        content: `**Authentication Failed**\n${finished.message || 'Authorization code was invalid or expired'}`,
        components: [],
      })
      return
    }

    clearModelListCache()
    pendingLoginContexts.delete(hash)

    await interaction.editReply({
      content: `✅ **Successfully authenticated with ${ctx.providerName}!**\n\nYou can now use models from this provider.`,
      components: [],
    })
  } catch (error) {
    loginLogger.error('OAuth code submission error:', error)
    pendingLoginContexts.delete(hash)
    await interaction.editReply({
      content: `**Authentication Failed**\n${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

export async function handleApiKeyModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_apikey:')) {
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const hash = interaction.customId.replace('login_apikey:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx || !ctx.providerId || !ctx.providerName) {
    await interaction.editReply({
      content: 'Session expired. Please run /login again.',
    })
    return
  }

  const apiKey = interaction.fields.getTextInputValue('apikey')

  if (!apiKey?.trim()) {
    await interaction.editReply({ content: 'API key is required.' })
    return
  }

  try {
    const getClient = await getAgentBackendProvider().initializeForDirectory(ctx.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({ content: getClient.message })
      return
    }

    const saved = await getClient().auth.setApiKey({
      directory: ctx.dir,
      providerId: ctx.providerId,
      key: apiKey.trim(),
    })
    if (saved instanceof Error) {
      await interaction.editReply({ content: `**Failed to save API key**\n${saved.message}`, components: [] })
      return
    }
    clearModelListCache()

    await interaction.editReply({
      content: `✅ **Successfully authenticated with ${ctx.providerName}!**\n\nYou can now use models from this provider.`,
    })

    pendingLoginContexts.delete(hash)
  } catch (error) {
    loginLogger.error('API key save error:', error)
    await interaction.editReply({
      content: `**Failed to save API key**\n${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

// ── OAuth flow ──────────────────────────────────────────────────

async function startOAuthFlow(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  ctx: LoginContext,
  hash: string,
): Promise<void> {
  if (!ctx.providerId || ctx.methodIndex === undefined) {
    await interaction.editReply({
      content: 'Invalid context for OAuth flow',
      components: [],
    })
    return
  }

  try {
    const getClient = await getAgentBackendProvider().initializeForDirectory(ctx.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({
        content: getClient.message,
        components: [],
      })
      return
    }

    await interaction.editReply({
      content: `**Authenticating with ${ctx.providerName}**\nStarting authorization...`,
      components: [],
    })

    const loginData = await getClient().auth.startOAuth({
      directory: ctx.dir,
      providerId: ctx.providerId,
      method: ctx.methodIndex,
      inputs: ctx.inputs,
    })
    if (loginData instanceof Error) {
      await interaction.editReply({
        content: `Failed to start authorization: ${loginData.message}`,
        components: [],
      })
      return
    }
    const { url, mode: method, instructions } = loginData

    let message = `**Authenticating with ${ctx.providerName}**\n\n`
    message += `Open this URL to authorize:\n${url}\n\n`

    if (instructions) {
      // Match "code: ABC-123" or "code: WXYZ1234" but not natural language
      // like "code will". Require a colon separator and uppercase alphanum code.
      const codeMatch = instructions.match(/code:\s*([A-Z0-9][A-Z0-9-]+)/)
      if (codeMatch) {
        message += `**Code:** \`${codeMatch[1]}\`\n\n`
      } else {
        message += `${instructions}\n\n`
      }
    }

    if (method === 'auto') {
      message += '_Waiting for authorization to complete..._'
    }

    if (method === 'code') {
      // Code mode: show a button to paste the auth code/URL after
      // completing login in a browser (possibly on a different machine).
      const button = new ButtonBuilder()
        .setCustomId(`login_oauth_code_btn:${hash}`)
        .setLabel('Paste authorization code or callback url')
        .setStyle(ButtonStyle.Primary)

      await interaction.editReply({
        content: message,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(button),
        ],
      })
      // Don't delete context — we need it for the code submission
      return
    }

    await interaction.editReply({ content: message, components: [] })

    // Auto mode: poll for completion (device flow / localhost callback)
    const finished = await getClient().auth.finishOAuth({
      directory: ctx.dir,
      providerId: ctx.providerId,
      method: ctx.methodIndex,
    })

    if (finished instanceof Error) {
      pendingLoginContexts.delete(hash)
      await interaction.editReply({
        content: `**Authentication Failed**\n${finished.message || 'Authorization was not completed'}`,
        components: [],
      })
      return
    }

    clearModelListCache()
    pendingLoginContexts.delete(hash)

    await interaction.editReply({
      content: `✅ **Successfully authenticated with ${ctx.providerName}!**\n\nYou can now use models from this provider.`,
      components: [],
    })
  } catch (error) {
    loginLogger.error('OAuth flow error:', error)
    pendingLoginContexts.delete(hash)
    await interaction.editReply({
      content: `**Authentication Failed**\n${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}
