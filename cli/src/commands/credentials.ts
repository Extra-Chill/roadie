// /credentials command — manage your own credential pool from Discord
// (credential pools phase 2b). Registered only when --credential-pools is on,
// so servers with pools off see no change.
//
// Subcommands:
//   /credentials list                        — accounts + rotations (no secrets)
//   /credentials add-key provider:<p>        — modal for the key (never an option)
//                                              and an optional base URL override
//   /credentials login-anthropic             — OAuth: authorize URL + paste modal
//   /credentials remove account:<id>         — remove an account
//   /credentials reorder account:<id> position:<n> — move an account in the
//                                              pool order (router tiebreaker)
//
// /login (also registered only with credential pools on) reuses the two write flows
// (startCredentialsApiKeyModal + startCredentialsAnthropicOAuth): same
// target-pool resolution, same shared-pool admin rule, same ephemeral replies.
//
// CustomId patterns:
//   credentials_apikey:<hash>       — API key modal submission
//   credentials_oauth_code_btn:<hash> — button that opens the OAuth paste modal
//   credentials_oauth_code:<hash>   — OAuth paste modal submission
//
// Accounts are read and written through the PoolAccounts seam
// (credentials/pool-accounts.ts): the local pool, or the pool host's admin API
// when this bot uses a remote pool (ROADIE_POOL_URL, #238).
//
// Every reply is ephemeral (MessageFlags.Ephemeral): nothing about credentials
// is ever posted in a channel, and no key, token or key fragment is ever
// included in a reply. Pending state lives in memory keyed by a random hash
// with a 10-minute TTL (same pattern as pendingLoginContexts in login.ts); the
// OAuth PKCE verifier stays inside the PoolAccounts flow, on the pool host
// when the pool is remote.
// Modal-submit handlers re-resolve the target pool and re-check permissions
// from the interaction; the click only carries intent, never authority.

import {
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import { getDataDir } from '../config.js'
import { store } from '../store.js'
import { resolvePerson, type Person } from '../identity.js'
import { hasCredentialPoolAdminPermission } from '../discord-utils.js'
import {
  resolvePersonBillingPool,
  type CredentialsMode,
} from '../credentials/person-pool.js'
import { SHARED_POOL_ID, type PoolRotations } from '../credentials/store.js'
import {
  resolvePoolAccounts,
  type PoolAccountAdded,
  type PoolAccountView,
  type PoolAccounts,
  type PoolOAuthProvider,
} from '../credentials/pool-accounts.js'

// ── Target pool resolution ──────────────────────────────────────

export type CredentialsTargetPool = { poolId: string; shared: boolean }

/**
 * Pool a /credentials invocation writes to or reads from. `pool:shared` — and
 * the default target in `global` mode — is the shared pool and requires the
 * credential-pool admin; every other target is the caller's own pool, resolved
 * by the same resolvePersonBillingPool helper turn routing uses, so the
 * command and routing can never disagree. A non-admin can never target any
 * pool except their own.
 */
export function resolveCredentialsTargetPool({
  requestShared,
  isAdmin,
  billing,
  mode,
}: {
  requestShared: boolean
  isAdmin: boolean
  billing: { personKey: string; poolId: string } | undefined
  mode: CredentialsMode
}): CredentialsTargetPool | Error {
  if (requestShared || mode === 'global') {
    if (!isAdmin) {
      return new Error('Only server admins can manage the shared credential pool.')
    }
    return { poolId: SHARED_POOL_ID, shared: true }
  }
  if (!billing) {
    return new Error('Could not resolve your credential pool.')
  }
  return { poolId: billing.poolId, shared: false }
}

/**
 * Resolve the identity person for the interaction (cached after the
 * interaction handler's resolvePerson; a re-read keeps TTL expiry honest)
 * and derive the target pool from it.
 */
async function resolveTargetPoolForInteraction({
  interaction,
  requestShared,
}: {
  interaction:
    | ChatInputCommandInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction
  requestShared: boolean
}): Promise<CredentialsTargetPool | Error> {
  let person: Person | undefined
  if (interaction.guild) {
    const resolved = await resolvePerson({
      actor: {
        platform: 'discord',
        id: interaction.user.id,
        name: interaction.user.displayName,
      },
      context: {
        guildId: interaction.guild.id,
        ...(interaction.channelId ? { channelId: interaction.channelId } : {}),
      },
    })
    person = resolved ?? undefined
  }
  const billing = resolvePersonBillingPool({
    person,
    platform: 'discord',
    actorId: interaction.user.id,
  })
  return resolveCredentialsTargetPool({
    requestShared,
    isAdmin: hasCredentialPoolAdminPermission(
      interaction.member,
      interaction.guild,
      interaction.channelId,
    ),
    billing,
    mode: store.getState().credentialsMode,
  })
}

// ── Pending context store ───────────────────────────────────────
// Keyed by random hash to stay under Discord's 100-char customId limit.
// TTL prevents unbounded growth when users open a modal and never submit.

export const CREDENTIALS_CONTEXT_TTL_MS = 10 * 60 * 1000

export type CredentialsPendingContext =
  | { kind: 'apikey'; provider: string; shared: boolean }
  | {
      kind: 'oauth'
      provider: PoolOAuthProvider
      /** The PoolAccounts OAuth flow holding the PKCE verifier and state. */
      flowId: string
      shared: boolean
    }

const pendingCredentialsContexts = new Map<
  string,
  { context: CredentialsPendingContext; createdAt: number }
>()

export function createCredentialsContext(context: CredentialsPendingContext): string {
  const hash = crypto.randomBytes(8).toString('hex')
  pendingCredentialsContexts.set(hash, { context, createdAt: Date.now() })
  setTimeout(() => {
    pendingCredentialsContexts.delete(hash)
  }, CREDENTIALS_CONTEXT_TTL_MS).unref()
  return hash
}

export function getCredentialsContext(
  hash: string,
  now = Date.now(),
): CredentialsPendingContext | undefined {
  const entry = pendingCredentialsContexts.get(hash)
  if (!entry) return undefined
  if (now - entry.createdAt >= CREDENTIALS_CONTEXT_TTL_MS) {
    pendingCredentialsContexts.delete(hash)
    return undefined
  }
  return entry.context
}

export function deleteCredentialsContext(hash: string): void {
  pendingCredentialsContexts.delete(hash)
}

// ── CustomId prefixes ───────────────────────────────────────────

export const CREDENTIALS_APIKEY_MODAL_PREFIX = 'credentials_apikey:'
export const CREDENTIALS_OAUTH_BUTTON_PREFIX = 'credentials_oauth_code_btn:'
export const CREDENTIALS_OAUTH_MODAL_PREFIX = 'credentials_oauth_code:'

// ── Listing (never shows keys or tokens) ────────────────────────

function describeAccount({ account, now }: { account: PoolAccountView; now: number }): string {
  const parts: string[] = [account.provider, account.type]
  if (account.label) parts.push(account.label)
  if (account.expiresAt) parts.push(`access expires ${account.expiresAt}`)
  if (typeof account.coolingUntil === 'number' && account.coolingUntil > now) {
    parts.push(`cooling ${Math.ceil((account.coolingUntil - now) / 1000)}s`)
  }
  return parts.join(' | ')
}

function buildListContent({
  poolId,
  location,
  accounts,
  rotations,
  now,
}: {
  poolId: string
  location: string
  accounts: PoolAccountView[]
  rotations: PoolRotations
  now: number
}): string {
  const lines: string[] = [`Credentials pool ${poolId}${location === 'local' ? '' : ` on ${location}`}`]
  if (accounts.length === 0) {
    lines.push('No accounts yet. Use /credentials add-key or /credentials login-anthropic.')
  } else {
    for (const account of accounts) {
      lines.push(`${account.position}. ${account.id} | ${describeAccount({ account, now })}`)
    }
  }
  const rotationNames = Object.keys(rotations).sort()
  if (rotationNames.length === 0) {
    lines.push('No rotations. Requests only work once this pool has a rotation.')
  } else {
    lines.push('Rotations:')
    for (const name of rotationNames) {
      const rotation = rotations[name]!
      lines.push(`${name}: ${rotation.entries.join(' ')}${rotation.description ? ` — ${rotation.description}` : ''}${rotation.hidden ? ' (hidden)' : ''}`)
    }
  }
  return lines.join('\n')
}

/** The account seam for this bot: local pool, or the pool host (#238). */
function poolAccounts(): PoolAccounts | Error {
  return resolvePoolAccounts({ env: process.env, dataDir: getDataDir() })
}

function addedContent({ added, poolId }: { added: PoolAccountAdded; poolId: string }): string {
  return (
    `Added ${added.account.provider} account ${added.account.id} to pool ${poolId}.` +
    (added.note ? `\n${added.note}` : '')
  )
}

// ── /credentials command ────────────────────────────────────────

export async function handleCredentialsCommand({
  command,
}: {
  command: ChatInputCommandInteraction
}): Promise<void> {
  const subcommand = command.options.getSubcommand(false)
  switch (subcommand) {
    case 'list':
      await handleCredentialsList(command)
      return
    case 'add-key':
      await handleCredentialsAddKey(command)
      return
    case 'login-anthropic':
      await handleCredentialsLoginAnthropic(command)
      return
    case 'remove':
      await handleCredentialsRemove(command)
      return
    case 'reorder':
      await handleCredentialsReorder(command)
      return
    default:
      await command.reply({
        content: 'Unknown subcommand.',
        flags: MessageFlags.Ephemeral,
      })
  }
}

function requestSharedOption(command: ChatInputCommandInteraction): boolean {
  return command.options.getString('pool') === 'shared'
}

async function handleCredentialsList(
  command: ChatInputCommandInteraction,
): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const target = await resolveTargetPoolForInteraction({
    interaction: command,
    requestShared: requestSharedOption(command),
  })
  if (target instanceof Error) {
    await command.editReply({ content: target.message })
    return
  }
  const accounts = poolAccounts()
  if (accounts instanceof Error) {
    await command.editReply({ content: accounts.message })
    return
  }
  const listing = await accounts.list({ poolId: target.poolId })
  if (listing instanceof Error) {
    await command.editReply({ content: listing.message })
    return
  }
  await command.editReply({
    content: buildListContent({
      poolId: target.poolId,
      location: accounts.location,
      accounts: listing.accounts,
      rotations: listing.rotations,
      now: Date.now(),
    }),
  })
}

// ── add-key: modal only, the key is never a slash-command option ──

async function handleCredentialsAddKey(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const provider = command.options.getString('provider', true)
  await startCredentialsApiKeyModal({
    command,
    provider,
    requestShared: requestSharedOption(command),
  })
}

/**
 * The /credentials add-key flow, shared with /login when credential pools are
 * on: resolve the target pool (fail fast before the modal; the modal submit
 * re-checks everything), then collect the key in a modal — never as an option
 * and never in a reply.
 */
export async function startCredentialsApiKeyModal({
  command,
  provider,
  requestShared,
}: {
  command: ChatInputCommandInteraction | StringSelectMenuInteraction
  provider: string
  requestShared: boolean
}): Promise<void> {
  const target = await resolveTargetPoolForInteraction({
    interaction: command,
    requestShared,
  })
  if (target instanceof Error) {
    await command.reply({ content: target.message, flags: MessageFlags.Ephemeral })
    return
  }
  const hash = createCredentialsContext({
    kind: 'apikey',
    provider,
    shared: target.shared,
  })
  const modal = new ModalBuilder()
    .setCustomId(`${CREDENTIALS_APIKEY_MODAL_PREFIX}${hash}`)
    .setTitle(`${provider} API key`.slice(0, 45))
  const apiKeyInput = new TextInputBuilder()
    .setCustomId('apikey')
    .setLabel('API key')
    .setPlaceholder('sk-...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
  const baseURLInput = new TextInputBuilder()
    .setCustomId('baseurl')
    .setLabel('Base URL (optional, for custom endpoints)')
    .setPlaceholder('https://self-hosted.example.com/v1')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(baseURLInput),
  )
  await command.showModal(modal)
}

export async function handleCredentialsApiKeyModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith(CREDENTIALS_APIKEY_MODAL_PREFIX)) {
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const hash = interaction.customId.slice(CREDENTIALS_APIKEY_MODAL_PREFIX.length)
  const context = getCredentialsContext(hash)
  if (!context || context.kind !== 'apikey') {
    await interaction.editReply({
      content: 'This request expired. Run /credentials add-key again.',
    })
    return
  }
  const key = interaction.fields.getTextInputValue('apikey')?.trim()
  if (!key) {
    await interaction.editReply({ content: 'API key is required.' })
    return
  }
  // Optional base URL override for custom or self-hosted endpoints; it wins
  // over the models.dev catalog and is the one case that skips provider
  // validation (a custom endpoint is exactly what the catalog cannot know).
  const baseURL = interaction.fields.getTextInputValue('baseurl')?.trim() || undefined
  // Re-check the target pool and permissions at submit time; the intent from
  // the click is re-validated, never trusted.
  const target = await resolveTargetPoolForInteraction({
    interaction,
    requestShared: context.shared,
  })
  if (target instanceof Error) {
    deleteCredentialsContext(hash)
    await interaction.editReply({ content: target.message })
    return
  }
  // The seam validates the provider against the models.dev catalog (unknown
  // names get close matches) unless a base URL is given.
  const accounts = poolAccounts()
  if (accounts instanceof Error) {
    deleteCredentialsContext(hash)
    await interaction.editReply({ content: accounts.message })
    return
  }
  const added = await accounts.addApiKey({
    poolId: target.poolId,
    provider: context.provider,
    key,
    ...(baseURL && { baseURL }),
  })
  deleteCredentialsContext(hash)
  await interaction.editReply({
    content: added instanceof Error ? added.message : addedContent({ added, poolId: target.poolId }),
  })
}

// ── login-anthropic: authorize URL + paste modal ────────────────

async function handleCredentialsLoginAnthropic(
  command: ChatInputCommandInteraction,
): Promise<void> {
  await startCredentialsAnthropicOAuth({
    command,
    requestShared: requestSharedOption(command),
  })
}

/**
 * The /credentials login-anthropic flow, shared with /login when credential
 * pools are on: everything runs in an ephemeral reply so codes never land in a
 * public channel, and the paste modal goes through the same pending-PKCE
 * context and button/modal handlers as the command.
 */
export async function startCredentialsAnthropicOAuth({
  command,
  requestShared,
  provider = 'anthropic',
}: {
  command: ChatInputCommandInteraction | StringSelectMenuInteraction
  requestShared: boolean
  /** `openai-codex` adds a ChatGPT subscription through the same paste flow. */
  provider?: PoolOAuthProvider
}): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const target = await resolveTargetPoolForInteraction({
    interaction: command,
    requestShared,
  })
  if (target instanceof Error) {
    await command.editReply({ content: target.message })
    return
  }
  const accounts = poolAccounts()
  if (accounts instanceof Error) {
    await command.editReply({ content: accounts.message })
    return
  }
  const flow = await accounts.startOAuth({ poolId: target.poolId, provider })
  if (flow instanceof Error) {
    await command.editReply({ content: flow.message })
    return
  }
  const { authorizeUrl } = flow
  const hash = createCredentialsContext({
    kind: 'oauth',
    provider,
    flowId: flow.flowId,
    shared: target.shared,
  })
  const button = new ButtonBuilder()
    .setCustomId(`${CREDENTIALS_OAUTH_BUTTON_PREFIX}${hash}`)
    .setLabel(provider === 'openai-codex' ? 'Paste redirect URL' : 'Paste code#state')
    .setStyle(ButtonStyle.Primary)
  await command.editReply({
    content:
      (provider === 'openai-codex'
        ? `Adding a ChatGPT account to pool ${target.poolId}\n` +
          `Open this URL to authorize:\n${authorizeUrl}\n` +
          `Your browser ends on a localhost:1455 page that does not load. Click the button and paste that page's full URL.`
        : `Adding a Claude account to pool ${target.poolId}\n` +
          `Open this URL to authorize:\n${authorizeUrl}\n` +
          `Then click the button and paste the code#state from the redirect (the full redirect URL also works).`),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
  })
}

export async function handleCredentialsOAuthCodeButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith(CREDENTIALS_OAUTH_BUTTON_PREFIX)) {
    return
  }
  const hash = interaction.customId.slice(CREDENTIALS_OAUTH_BUTTON_PREFIX.length)
  const context = getCredentialsContext(hash)
  if (!context || context.kind !== 'oauth') {
    await interaction.reply({
      content: 'This request expired. Run /credentials login-anthropic again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  const modal = new ModalBuilder()
    .setCustomId(`${CREDENTIALS_OAUTH_MODAL_PREFIX}${hash}`)
    .setTitle(context.provider === 'openai-codex' ? 'ChatGPT authorization' : 'Anthropic authorization')
  const codeInput = new TextInputBuilder()
    .setCustomId('oauth_code')
    .setLabel('Authorization code or callback URL')
    .setPlaceholder('code#state or the full redirect URL')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(codeInput),
  )
  await interaction.showModal(modal)
}

export async function handleCredentialsOAuthCodeModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith(CREDENTIALS_OAUTH_MODAL_PREFIX)) {
    return
  }
  // The modal came from a button on our ephemeral reply: deferUpdate resolves
  // there, so the result replaces the authorize URL message.
  await interaction.deferUpdate()
  const hash = interaction.customId.slice(CREDENTIALS_OAUTH_MODAL_PREFIX.length)
  const context = getCredentialsContext(hash)
  if (!context || context.kind !== 'oauth') {
    await interaction.editReply({
      content: 'This request expired. Run /credentials login-anthropic again.',
    })
    return
  }
  const pasted = interaction.fields.getTextInputValue('oauth_code')?.trim()
  if (!pasted) {
    await interaction.editReply({ content: 'Authorization code is required.' })
    return
  }
  // Re-check the target pool and permissions at submit time.
  const target = await resolveTargetPoolForInteraction({
    interaction,
    requestShared: context.shared,
  })
  if (target instanceof Error) {
    deleteCredentialsContext(hash)
    await interaction.editReply({ content: target.message })
    return
  }
  const accounts = poolAccounts()
  if (accounts instanceof Error) {
    deleteCredentialsContext(hash)
    await interaction.editReply({ content: accounts.message })
    return
  }
  const added = await accounts.completeOAuth({ poolId: target.poolId, flowId: context.flowId, input: pasted })
  deleteCredentialsContext(hash)
  await interaction.editReply({
    content: added instanceof Error ? added.message : addedContent({ added, poolId: target.poolId }),
  })
}

// ── remove ──────────────────────────────────────────────────────

async function handleCredentialsRemove(
  command: ChatInputCommandInteraction,
): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const accountId = command.options.getString('account', true)
  const target = await resolveTargetPoolForInteraction({
    interaction: command,
    requestShared: requestSharedOption(command),
  })
  if (target instanceof Error) {
    await command.editReply({ content: target.message })
    return
  }
  const accounts = poolAccounts()
  if (accounts instanceof Error) {
    await command.editReply({ content: accounts.message })
    return
  }
  const removed = await accounts.remove({ poolId: target.poolId, accountId })
  if (removed instanceof Error) {
    await command.editReply({ content: removed.message })
    return
  }
  if (!removed) {
    await command.editReply({
      content: `Account ${accountId} not found in pool ${target.poolId}.`,
    })
    return
  }
  await command.editReply({
    content: `Removed account ${accountId} from pool ${target.poolId}.`,
  })
}

// ── reorder ──────────────────────────────────────────────────────

async function handleCredentialsReorder(
  command: ChatInputCommandInteraction,
): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const accountId = command.options.getString('account', true)
  const position = command.options.getInteger('position', true)
  const target = await resolveTargetPoolForInteraction({
    interaction: command,
    requestShared: requestSharedOption(command),
  })
  if (target instanceof Error) {
    await command.editReply({ content: target.message })
    return
  }
  const accounts = poolAccounts()
  if (accounts instanceof Error) {
    await command.editReply({ content: accounts.message })
    return
  }
  const ordered = await accounts.move({ poolId: target.poolId, accountId, position })
  if (ordered instanceof Error) {
    await command.editReply({ content: ordered.message })
    return
  }
  await command.editReply({
    content:
      `Moved account ${accountId} to position ${position} in pool ${target.poolId}.\n` +
      `Pool order: ${ordered.map((account) => account.id).join(' ')}`,
  })
}
