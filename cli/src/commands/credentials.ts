// /credentials command — manage your own credential pool from Discord
// (credential pools phase 2b). Registered only when --credential-pools is on,
// so servers with pools off see no change and /login is untouched.
//
// Subcommands:
//   /credentials list                        — accounts + rotations (no secrets)
//   /credentials add-key provider:<p>        — modal for the key (never an option)
//                                              and an optional base URL override
//   /credentials login-anthropic             — OAuth: authorize URL + paste modal
//   /credentials remove account:<id>         — remove an account
//
// CustomId patterns:
//   credentials_apikey:<hash>       — API key modal submission
//   credentials_oauth_code_btn:<hash> — button that opens the OAuth paste modal
//   credentials_oauth_code:<hash>   — OAuth paste modal submission
//
// Every reply is ephemeral (MessageFlags.Ephemeral): nothing about credentials
// is ever posted in a channel, and no key, token or key fragment is ever
// included in a reply. Pending state lives in memory keyed by a random hash
// with a 10-minute TTL (same pattern as pendingLoginContexts in login.ts).
// Modal-submit handlers re-resolve the target pool and re-check permissions
// from the interaction; the click only carries intent, never authority.

import {
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import { getDataDir } from '../config.js'
import { store } from '../store.js'
import { createLogger, LogPrefix } from '../logger.js'
import { resolvePerson, type Person } from '../identity.js'
import { hasCredentialPoolAdminPermission } from '../discord-utils.js'
import {
  resolvePersonBillingPool,
  type CredentialsMode,
} from '../credentials/person-pool.js'
import {
  DuplicatePoolAccountError,
  SHARED_POOL_ID,
  addPoolAccount,
  addPoolOAuthAccount,
  readPoolAccounts,
  readPoolRotations,
  readPoolState,
  removePoolAccount,
  seedPoolRotations,
  type PoolAccount,
} from '../credentials/store.js'
import {
  ANTHROPIC_OAUTH_REDIRECT_URI,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePKCE,
  parseManualInput,
} from '../credentials/adapters/anthropic-oauth.js'
import { resolveCatalog, validateCatalogProvider } from '../credentials/provider-catalog.js'

const credentialsLogger = createLogger(LogPrefix.CREDENTIALS)

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
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction
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
      provider: 'anthropic'
      verifier: string
      state: string
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

function describeAccount({
  account,
  cooldownUntil,
  now,
}: {
  account: PoolAccount
  cooldownUntil: number | undefined
  now: number
}): string {
  const parts = [account.provider, account.type]
  if (account.label) parts.push(account.label)
  if (account.type === 'oauth') {
    parts.push(`access expires ${new Date(account.expires).toISOString()}`)
  }
  if (typeof cooldownUntil === 'number' && cooldownUntil > now) {
    parts.push(`cooling ${Math.ceil((cooldownUntil - now) / 1000)}s`)
  }
  return parts.join(' | ')
}

function buildListContent({
  poolId,
  accounts,
  cooldowns,
  rotations,
  now,
}: {
  poolId: string
  accounts: PoolAccount[]
  cooldowns: Record<string, number>
  rotations: Record<string, string[]>
  now: number
}): string {
  const lines: string[] = [`Credentials pool ${poolId}`]
  if (accounts.length === 0) {
    lines.push('No accounts yet. Use /credentials add-key or /credentials login-anthropic.')
  } else {
    for (const account of accounts) {
      lines.push(`${account.id} | ${describeAccount({ account, cooldownUntil: cooldowns[account.id], now })}`)
    }
  }
  const rotationNames = Object.keys(rotations).sort()
  if (rotationNames.length === 0) {
    lines.push('No rotations. Requests only work once this pool has a rotation.')
  } else {
    lines.push('Rotations:')
    for (const name of rotationNames) {
      lines.push(`${name}: ${(rotations[name] ?? []).join(' ')}`)
    }
  }
  return lines.join('\n')
}

// ── Seeding helper ──────────────────────────────────────────────
// A person pool with accounts but no rotation would 401 every request (the
// roadie/<rotation> models are named after the shared pool's rotations), so
// the first account added to a rotationless pool copies the shared rotations
// under the pool lock, never overwriting what is already there.

async function seedRotationsForPersonalPool({
  poolId,
  shared,
}: {
  poolId: string
  shared: boolean
}): Promise<string | undefined> {
  if (shared) return undefined
  const seeded = await seedPoolRotations({ dataDir: getDataDir(), poolId })
  if (seeded instanceof Error) {
    credentialsLogger.warn(
      `[CREDENTIALS] Failed to seed rotations into pool ${poolId}: ${seeded.message}`,
    )
    return `Could not copy the shared rotations into pool ${poolId}: ${seeded.message}`
  }
  return undefined
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
  const dataDir = getDataDir()
  const accounts = readPoolAccounts({ dataDir, poolId: target.poolId })
  if (accounts instanceof Error) {
    await command.editReply({ content: accounts.message })
    return
  }
  const state = readPoolState({ dataDir, poolId: target.poolId })
  if (state instanceof Error) {
    await command.editReply({ content: state.message })
    return
  }
  const rotations = readPoolRotations({ dataDir, poolId: target.poolId })
  if (rotations instanceof Error) {
    await command.editReply({ content: rotations.message })
    return
  }
  await command.editReply({
    content: buildListContent({
      poolId: target.poolId,
      accounts,
      cooldowns: state.cooldowns,
      rotations,
      now: Date.now(),
    }),
  })
}

// ── add-key: modal only, the key is never a slash-command option ──

async function handleCredentialsAddKey(
  command: ChatInputCommandInteraction,
): Promise<void> {
  const provider = command.options.getString('provider', true)
  // Fail fast before the modal; the modal submit re-checks everything.
  const target = await resolveTargetPoolForInteraction({
    interaction: command,
    requestShared: requestSharedOption(command),
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
  // The provider stays free text; unknown names get close matches from the
  // models.dev catalog. When the catalog cannot be loaded, adding proceeds —
  // the account simply routes once the catalog is available.
  if (!baseURL) {
    const catalog = await resolveCatalog({ dataDir: getDataDir() })
    if (catalog instanceof Error) {
      credentialsLogger.warn(
        `[CREDENTIALS] Could not load the models.dev catalog; skipping provider validation: ${catalog.message}`,
      )
    } else {
      const invalid = validateCatalogProvider({ catalog, provider: context.provider })
      if (invalid) {
        deleteCredentialsContext(hash)
        await interaction.editReply({ content: invalid.message })
        return
      }
    }
  }
  const account = await addPoolAccount({
    dataDir: getDataDir(),
    poolId: target.poolId,
    provider: context.provider,
    key,
    ...(baseURL && { baseURL }),
  })
  if (account instanceof DuplicatePoolAccountError) {
    await interaction.editReply({
      content: `That ${context.provider} account is already in pool ${target.poolId} (${account.existing.id}).`,
    })
    return
  }
  if (account instanceof Error) {
    await interaction.editReply({ content: account.message })
    return
  }
  const seedNote = await seedRotationsForPersonalPool({
    poolId: target.poolId,
    shared: target.shared,
  })
  deleteCredentialsContext(hash)
  await interaction.editReply({
    content:
      `Added ${account.provider} account ${account.id} to pool ${target.poolId}.` +
      (seedNote ? `\n${seedNote}` : ''),
  })
}

// ── login-anthropic: authorize URL + paste modal ────────────────

async function handleCredentialsLoginAnthropic(
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
  const pkce = await generatePKCE()
  if (pkce instanceof Error) {
    await command.editReply({ content: pkce.message })
    return
  }
  // The browser redirects to localhost (nothing listens there); the code and
  // state stay visible in the address bar for pasting.
  const state = pkce.verifier
  const authorizeUrl = buildAuthorizeUrl({
    challenge: pkce.challenge,
    state,
    redirectUri: ANTHROPIC_OAUTH_REDIRECT_URI,
  })
  const hash = createCredentialsContext({
    kind: 'oauth',
    provider: 'anthropic',
    verifier: pkce.verifier,
    state,
    shared: target.shared,
  })
  const button = new ButtonBuilder()
    .setCustomId(`${CREDENTIALS_OAUTH_BUTTON_PREFIX}${hash}`)
    .setLabel('Paste code#state')
    .setStyle(ButtonStyle.Primary)
  await command.editReply({
    content:
      `Adding a Claude account to pool ${target.poolId}\n` +
      `Open this URL to authorize:\n${authorizeUrl}\n` +
      `Then click the button and paste the code#state from the redirect (the full redirect URL also works).`,
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
    .setTitle('Anthropic authorization')
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
  const { code, state: pastedState } = parseManualInput(pasted)
  if (!code.trim()) {
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
  const tokens = await exchangeAuthorizationCode({
    code,
    state: pastedState || context.state,
    verifier: context.verifier,
    redirectUri: ANTHROPIC_OAUTH_REDIRECT_URI,
  })
  if (tokens instanceof Error) {
    deleteCredentialsContext(hash)
    await interaction.editReply({
      content: `Authorization failed: ${tokens.message}`,
    })
    return
  }
  const account = await addPoolOAuthAccount({
    dataDir: getDataDir(),
    poolId: target.poolId,
    provider: context.provider,
    refresh: tokens.refresh,
    access: tokens.access,
    expires: tokens.expires,
  })
  if (account instanceof DuplicatePoolAccountError) {
    await interaction.editReply({
      content: `That ${context.provider} account is already in pool ${target.poolId} (${account.existing.id}).`,
    })
    return
  }
  if (account instanceof Error) {
    await interaction.editReply({ content: account.message })
    return
  }
  const seedNote = await seedRotationsForPersonalPool({
    poolId: target.poolId,
    shared: target.shared,
  })
  deleteCredentialsContext(hash)
  await interaction.editReply({
    content:
      `Added ${account.provider} account ${account.id} to pool ${target.poolId}.` +
      (seedNote ? `\n${seedNote}` : ''),
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
  const removed = await removePoolAccount({
    dataDir: getDataDir(),
    poolId: target.poolId,
    accountId,
  })
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
