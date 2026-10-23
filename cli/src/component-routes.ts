// Route table for Discord message components (buttons, select menus) and
// modal submits. One entry per custom-id prefix holds everything the
// interaction listener needs to know about a component: how it is
// acknowledged, which permission checks it passes, and which handler runs it.

import {
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'
import { handlePermissionButton } from './commands/permissions.js'
import {
  handleProviderSelectMenu,
  handleModelSelectMenu,
  handleModelScopeSelectMenu,
  handleModelVariantSelectMenu,
} from './commands/model.js'
import { handleLoginSelect } from './commands/login.js'
import {
  handleCredentialsApiKeyModalSubmit,
  handleCredentialsOAuthCodeButton,
  handleCredentialsOAuthCodeModalSubmit,
  CREDENTIALS_APIKEY_MODAL_PREFIX,
  CREDENTIALS_OAUTH_BUTTON_PREFIX,
  CREDENTIALS_OAUTH_MODAL_PREFIX,
} from './commands/credentials.js'
import { handleAgentSelectMenu } from './commands/agent.js'
import { handleAskQuestionSelectMenu } from './commands/ask-question.js'
import {
  handleFileUploadButton,
  handleFileUploadModalSubmit,
} from './commands/file-upload.js'
import { handleActionButton } from './commands/action-buttons.js'
import { handleOperatorRequestButton, OPERATOR_REQUEST_PREFIX } from './commands/operator-request.js'
import { handleHtmlActionButton } from './html-actions.js'
import { handleVerbositySelectMenu } from './commands/verbosity.js'
import { handleMcpSelectMenu } from './commands/mcp.js'
import { CONNECT_BUTTON_PREFIX, handleConnectButton } from './commands/connect.js'
import { handleLinkButton, LINK_BUTTON_PREFIX } from './commands/link.js'
import {
  handleVariantQuickSelectMenu,
  handleVariantScopeSelectMenu,
} from './commands/model-variant.js'
import { store } from './store.js'
import { replyOrEditInteraction } from './interaction-reply.js'

export type ComponentKind = 'button' | 'select' | 'modal'

export type ComponentInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction

/**
 * How the listener acknowledges the interaction before the identity lookup,
 * which can outlast Discord's three-second deadline (#306, #307):
 * - `update`: deferUpdate(); the handler edits the clicked message.
 * - `private`: ephemeral deferReply(); the handler answers the clicker only,
 *   because the component can sit on messages other people see.
 * - `modal`: no acknowledgement; the handler gives the first response itself
 *   (showModal() for modal openers, its own reply for modal submits).
 */
export type ComponentAck = 'update' | 'private' | 'modal'

export type ComponentRouteContext = {
  /** False when answered in an unbound channel of a served guild (#301). */
  channelBound: boolean
}

export type ComponentRoute = {
  prefix: string
  kind: ComponentKind
  ack: ComponentAck
  /**
   * Acts only for the clicking user (#301): answered in DMs before any
   * ownership check, and in unbound channels of a guild this machine serves.
   */
  personScoped?: boolean
  /**
   * Self-serve identity linking (#292) is for people Roadie does not admit
   * yet: skips the permission and channel-audience checks.
   */
  selfServe?: boolean
  handle: (interaction: ComponentInteraction, context: ComponentRouteContext) => Promise<void>
}

type RouteOptions = Pick<ComponentRoute, 'prefix' | 'ack' | 'personScoped' | 'selfServe'>

function button(
  options: RouteOptions,
  handle: (interaction: ButtonInteraction, context: ComponentRouteContext) => Promise<void>,
): ComponentRoute {
  return {
    ...options,
    kind: 'button',
    handle: async (interaction, context) => {
      if (interaction.isButton()) await handle(interaction, context)
    },
  }
}

function select(
  options: RouteOptions,
  handle: (interaction: StringSelectMenuInteraction) => Promise<void>,
): ComponentRoute {
  return {
    ...options,
    kind: 'select',
    handle: async (interaction) => {
      if (interaction.isStringSelectMenu()) await handle(interaction)
    },
  }
}

function modal(
  options: RouteOptions,
  handle: (interaction: ModalSubmitInteraction) => Promise<void>,
): ComponentRoute {
  return {
    ...options,
    kind: 'modal',
    handle: async (interaction) => {
      if (interaction.isModalSubmit()) await handle(interaction)
    },
  }
}

const CREDENTIAL_POOLS_DISABLED_MESSAGE = 'Credential pools are not enabled on this server.'

export const COMPONENT_ROUTES: readonly ComponentRoute[] = [
  // Buttons
  button({ prefix: LINK_BUTTON_PREFIX, ack: 'private', personScoped: true, selfServe: true },
    (interaction, { channelBound }) => handleLinkButton(interaction, { channelBound })),
  // Acts only on the clicking user's own person key and servers.
  button({ prefix: CONNECT_BUTTON_PREFIX, ack: 'private', personScoped: true },
    (interaction) => handleConnectButton(interaction)),
  button({ prefix: OPERATOR_REQUEST_PREFIX, ack: 'update' }, handleOperatorRequestButton),
  button({ prefix: 'permission_once:', ack: 'update' }, handlePermissionButton),
  button({ prefix: 'permission_always:', ack: 'update' }, handlePermissionButton),
  button({ prefix: 'permission_reject:', ack: 'update' }, handlePermissionButton),
  button({ prefix: 'file_upload_btn:', ack: 'modal' }, handleFileUploadButton),
  // Per-person command: the handler enforces admin itself when the
  // interaction targets the shared pool.
  button({ prefix: CREDENTIALS_OAUTH_BUTTON_PREFIX, ack: 'modal' }, handleCredentialsOAuthCodeButton),
  button({ prefix: 'action_button:', ack: 'update' }, handleActionButton),
  button({ prefix: 'html_action:', ack: 'update' }, handleHtmlActionButton),

  // Select menus
  select({ prefix: 'model_provider:', ack: 'update' }, handleProviderSelectMenu),
  select({ prefix: 'model_select:', ack: 'update' }, handleModelSelectMenu),
  select({ prefix: 'model_scope:', ack: 'update' }, handleModelScopeSelectMenu),
  select({ prefix: 'model_variant:', ack: 'update' }, handleModelVariantSelectMenu),
  select({ prefix: 'variant_quick:', ack: 'update' }, handleVariantQuickSelectMenu),
  select({ prefix: 'variant_scope:', ack: 'update' }, handleVariantScopeSelectMenu),
  select({ prefix: 'agent_select:', ack: 'update' }, handleAgentSelectMenu),
  select({ prefix: 'verbosity_select:', ack: 'update' }, handleVerbositySelectMenu),
  select({ prefix: 'ask_question:', ack: 'update' }, handleAskQuestionSelectMenu),
  select({ prefix: 'mcp_toggle:', ack: 'update' }, handleMcpSelectMenu),
  // Opens the API key modal for most providers.
  select({ prefix: 'login_select:', ack: 'modal' }, async (interaction) => {
    if (!store.getState().credentialPoolsEnabled) {
      // Stale menu: /login only exists when credential pools are enabled.
      await replyOrEditInteraction(interaction, CREDENTIAL_POOLS_DISABLED_MESSAGE)
      return
    }
    // The pool flow re-checks the shared-pool admin rule at every write
    // (same handlers as /credentials).
    await handleLoginSelect(interaction)
  }),

  // Modal submits. Credential modal handlers re-resolve the target pool and
  // re-check admin from this interaction, never trusting the click.
  modal({ prefix: CREDENTIALS_APIKEY_MODAL_PREFIX, ack: 'modal' }, async (interaction) => {
    if (await rejectDisabledCredentialPools(interaction)) return
    await handleCredentialsApiKeyModalSubmit(interaction)
  }),
  modal({ prefix: CREDENTIALS_OAUTH_MODAL_PREFIX, ack: 'modal' }, async (interaction) => {
    if (await rejectDisabledCredentialPools(interaction)) return
    await handleCredentialsOAuthCodeModalSubmit(interaction)
  }),
  modal({ prefix: 'file_upload_modal:', ack: 'modal' }, handleFileUploadModalSubmit),
]

// Stale registration: /credentials only exists when --credential-pools is
// on. Fail closed rather than touch pools.
async function rejectDisabledCredentialPools(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (store.getState().credentialPoolsEnabled) return false
  await interaction.reply({ content: CREDENTIAL_POOLS_DISABLED_MESSAGE, flags: MessageFlags.Ephemeral })
  return true
}

export const UNKNOWN_COMPONENT_MESSAGE = 'This action is no longer available.'

/** Buttons, string select menus and modal submits: the interactions this table routes. */
export function isComponentInteraction(interaction: Interaction): interaction is ComponentInteraction {
  return interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()
}

function componentKind(interaction: ComponentInteraction): ComponentKind {
  if (interaction.isButton()) return 'button'
  if (interaction.isStringSelectMenu()) return 'select'
  return 'modal'
}

export function findComponentRoute(customId: string, kind: ComponentKind): ComponentRoute | undefined {
  return COMPONENT_ROUTES.find((route) => route.kind === kind && customId.startsWith(route.prefix))
}

/** The route for an interaction, or undefined for unrouted interactions and unknown prefixes. */
export function routeForInteraction(interaction: Interaction): ComponentRoute | undefined {
  if (!isComponentInteraction(interaction)) return undefined
  return findComponentRoute(interaction.customId, componentKind(interaction))
}

/** Acknowledge per the route, before the identity lookup (#307). */
export async function acknowledgeComponent(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  route: ComponentRoute): Promise<void> {
  if (route.ack === 'update') {
    await interaction.deferUpdate()
  } else if (route.ack === 'private') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  }
}
