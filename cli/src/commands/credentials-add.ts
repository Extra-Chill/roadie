// /credentials add command: add an account to a credential pool (Anthropic/ChatGPT OAuth
// or an API key for any models.dev provider).
//
// The credential pool is the single owner of the credentials Roadie manages.
// /credentials is registered only when credential pools are enabled. The provider picker lists the models.dev catalog and the
// writes go through the /credentials handlers (startCredentialsApiKeyModal +
// startCredentialsAnthropicOAuth): same target-pool resolution, same
// shared-pool admin rule, ephemeral replies, keys only ever via a modal.
// With --no-credential-pools Pi's own agent-dir auth.json applies and is
// managed with `pi` on the host.
//
// One select handler (`login_select:<hash>`) drives the provider and
// account-type menus and hands off to the credentials_apikey: /
// credentials_oauth_code_* customIds, whose dispatch and gating live in
// interaction-handler.ts and commands/credentials.ts.

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import { createLogger, LogPrefix } from '../logger.js'
import { buildPaginatedOptions, parsePaginationValue } from './paginated-select.js'
import { getDataDir } from '../config.js'
import {
  resolveCatalog,
  type ModelsDevCatalog,
} from '../credentials/provider-catalog.js'
import {
  startCredentialsApiKeyModal,
  startCredentialsAnthropicOAuth,
} from './credentials.js'

const loginLogger = createLogger(LogPrefix.LOGIN)

// ── Login step state machine ────────────────────────────────────

type StepProvider = { type: 'provider' }
/** The account-type menu for a provider (OAuth subscription vs API key). */
type StepPoolMethod = { type: 'pool-method'; provider: string }
type LoginStep = StepProvider | StepPoolMethod

type LoginContext = {
  steps: LoginStep[]
  stepIndex: number
  providerId?: string
  providerPage?: number
  requestShared: boolean
}

// ── Context store ───────────────────────────────────────────────
// Keyed by random hash to stay under Discord's 100-char customId limit.
// TTL prevents unbounded growth when users open /credentials add and never interact.

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
// IDs are models.dev provider ids.
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

// ── Credential-pool flow ────────────────────────────────────────
// /credentials add adds an account to a pool. The provider picker comes from the
// models.dev catalog (#136); the writes reuse the /credentials handlers, so
// target-pool resolution, the shared-pool admin rule, ephemeral replies and
// modal-only keys are identical.

const POOL_LOGIN_PROVIDER_PROMPT = '**Add a provider account to your credential pool**\nSelect a provider:'

/**
 * Provider options for the pool picker: every models.dev provider, popular
 * ids first, then alphabetical. The description shows the catalog id when the display name
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

export async function handleCredentialsAdd(command: ChatInputCommandInteraction): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const catalog = await resolveCatalog({ dataDir: getDataDir() })
  if (catalog instanceof Error) {
    await command.editReply({
      content: `Could not load the models.dev provider catalog: ${catalog.message}`,
    })
    return
  }
  const context: LoginContext = {
    steps: [{ type: 'provider' }],
    stepIndex: 0,
    requestShared: command.options.getString('pool') === 'shared',
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
  if (providerId === 'openai') {
    // OpenAI offers both a ChatGPT subscription (Codex OAuth) and an API key.
    ctx.steps = [{ type: 'pool-method', provider: providerId }]
    ctx.stepIndex = 0
    await interaction.deferUpdate()
    await interaction.editReply({
      content: '**Add an OpenAI account to your credential pool**\nSelect account type:',
      components: [
        buildSelectMenu({
          customId: `login_select:${hash}`,
          placeholder: 'Select account type',
          options: [
            {
              label: 'ChatGPT subscription (OAuth)',
              value: 'oauth',
              description: 'ChatGPT Plus/Pro login for Pi channels — paste the redirect URL',
            },
            {
              label: 'API key',
              value: 'api',
              description: 'Add an OpenAI API key to the pool',
            },
          ],
        }),
      ],
    })
    return
  }
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
  // Every other provider is an API key account, entered through a private
  // modal (never a menu option, never a reply).
  await startCredentialsApiKeyModal({
    command: interaction,
    provider: providerId,
    requestShared: ctx.requestShared,
  })
}

async function handlePoolMethodStep(
  interaction: StringSelectMenuInteraction,
  value: string,
  step: StepPoolMethod,
  requestShared: boolean,
): Promise<void> {
  if (value === 'oauth') {
    // Shared ephemeral authorize-URL + paste-modal flow;
    // OpenAI's is a ChatGPT subscription.
    await startCredentialsAnthropicOAuth({
      command: interaction,
      requestShared,
      provider: step.provider === 'openai' ? 'openai-codex' : 'anthropic',
    })
    return
  }
  await startCredentialsApiKeyModal({
    command: interaction,
    provider: step.provider,
    requestShared,
  })
}

// ── Select handler ──────────────────────────────────────────────
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
      content: 'Selection expired. Please run /credentials add again.',
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
      content: 'Invalid state. Please run /credentials add again.',
      components: [],
    })
    return
  }

  try {
    if (step.type === 'provider') {
      await handlePoolProviderStep(interaction, ctx, hash, value)
    } else if (step.type === 'pool-method') {
      await handlePoolMethodStep(interaction, value, step, ctx.requestShared)
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
