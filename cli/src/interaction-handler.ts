// Discord slash command and interaction handler.
// Processes all slash commands (/session, /resume, /fork, /model, /abort, etc.)
// and manages autocomplete, select menu interactions for the bot.

import {
  Events,
  MessageFlags,
  type Client,
  type Interaction,
} from 'discord.js'
import {
  handleSessionCommand,
  handleSessionAutocomplete,
} from './commands/session.js'
import { handleTasksCommand } from './commands/tasks.js'
import { handleLastSessionsCommand } from './commands/last-sessions.js'

import {
  handleRemoveProjectCommand,
  handleRemoveProjectAutocomplete,
} from './commands/remove-project.js'
import { handleChannelAutocomplete, handleChannelCommand, isApplicationGuild } from './commands/channel.js'
import { handleAbortCommand } from './commands/abort.js'
import { handleCompactCommand } from './commands/compact.js'
import {
  handleForkCommand,
  handleForkAutocomplete,
} from './commands/fork.js'
import { handleModelCommand } from './commands/model.js'
import { handleCredentialsCommand } from './commands/credentials.js'
import {
  handleAgentCommand,
  handleQuickAgentCommand,
  handleQuickAgentAutocomplete,
} from './commands/agent.js'
import { handleUserCommand } from './commands/user-command.js'
import { handleVerbosityCommand } from './commands/verbosity.js'
import { handleRunCommand } from './commands/run-command.js'
import { handleContextUsageCommand } from './commands/context-usage.js'
import { handleSessionIdCommand } from './commands/session-id.js'

import { handleUpgradeAndRestartCommand } from './commands/upgrade.js'
import { handleMcpCommand } from './commands/mcp.js'
import { handleConnectCommand } from './commands/connect.js'
import { handleStartCommand, welcomeDiscordUser } from './commands/start.js'
import {
  acknowledgeComponent,
  isComponentInteraction,
  routeForInteraction,
  UNKNOWN_COMPONENT_MESSAGE,
} from './component-routes.js'
import {
  hasRoadieBotPermission,
  hasRoadieShellPermission,
} from './discord-utils.js'
import { getCachedPerson, IDENTITY_LOOKUP_FAILED_MESSAGE, resolvePerson } from './identity.js'
import {
  channelAllowsCapability,
  channelAllowsSpeaker,
  decideRespond,
  applicationBinding,
  configuredChannelIds,
  resolveSendChannel,
  resolveChannelPolicy,
} from './channel-policy.js'
import { createLogger, LogPrefix } from './logger.js'
import { store } from './store.js'
import { replyOrEditInteraction } from './interaction-reply.js'
import { notifyError } from './sentry.js'
import { findChannelsByDirectory, getChannelDirectory, getThreadSession } from './database.js'
import { readConversationAdmission, resolveConversationIntake, recordConversationAdmission } from './conversation-intake.js'
import {
  reserveThreadIngress,
  runInThreadIngressSlot,
} from './session-handler/thread-ingress.js'

const interactionLogger = createLogger(LogPrefix.INTERACTION)

function serialIngressChannelId(interaction: Interaction): string | undefined {
  if (!interaction.isChatInputCommand()) {
    return undefined
  }
  const name = interaction.commandName
  if (name.endsWith('-cmd') || name.endsWith('-skill') || name.endsWith('-mcp-prompt')) {
    return interaction.channelId ?? undefined
  }
  if (!name.endsWith('-agent') || name === 'agent') {
    return undefined
  }
  if (interaction.options.getString('prompt')) {
    return undefined
  }
  return interaction.channelId ?? undefined
}

/**
 * Check if the interaction's channel is owned by this machine (has a project
 * directory configured in the local sqlite db). For threads, checks the parent
 * channel. Returns true if owned, false if not (another machine should handle it).
 */
async function isInteractionOwnedByThisMachine(
  interaction: Interaction,
): Promise<boolean> {
  const channelId = interaction.channelId
  if (!channelId) return false
  if (applicationBinding() && !(resolveSendChannel(channelId) instanceof Error)) return true

  // Direct channel lookup
  const channelConfig = await getChannelDirectory(channelId)
  if (channelConfig) return true

  // If in a thread, check the parent channel
  const cachedParentId = interaction.channel?.isThread()
    ? interaction.channel.parentId
    : null
  if (cachedParentId) {
    if (applicationBinding() && !(resolveSendChannel(cachedParentId) instanceof Error)) return true
    const parentConfig = await getChannelDirectory(cachedParentId)
    if (parentConfig) return true
  }

  // When channel isn't cached (common with gateway-proxy), fetch it to get parentId
  if (!cachedParentId) {
    const fetched = await interaction.client.channels
      .fetch(channelId)
      .catch(() => null)
    if (fetched?.isThread() && fetched.parentId) {
      if (applicationBinding() && !(resolveSendChannel(fetched.parentId) instanceof Error)) return true
      const parentConfig = await getChannelDirectory(fetched.parentId)
      if (parentConfig) return true
    }
  }

  return false
}

// Slash commands that act only on the calling user's own account and need no
// project. They are answered in any channel of a guild this machine serves.
const PERSON_SCOPED_COMMANDS = new Set(['connect', 'start'])

/**
 * Person-scoped interactions (#301): /connect, /start and the Link and
 * Connect/Disconnect buttons. Each acts only for the clicking user.
 */
export function isPersonScopedInteraction(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand()) return PERSON_SCOPED_COMMANDS.has(interaction.commandName)
  return routeForInteraction(interaction)?.personScoped ?? false
}

async function channelGuildId(client: Client, channelId: string, fetch: boolean): Promise<string | undefined> {
  const channel = client.channels.cache.get(channelId)
    ?? (fetch ? await client.channels.fetch(channelId).catch(() => null) : null)
  if (!channel || !('guildId' in channel)) return undefined
  return channel.guildId ?? undefined
}

/**
 * Whether this machine serves the interaction's guild: the guild of the
 * application channel, or of any channel bound here (channels config or the
 * local channel directories). Several machines can share one bot token, so a
 * guild with no local binding belongs to someone else.
 */
export async function isGuildServedByThisMachine(
  interaction: Pick<Interaction, 'client' | 'guildId'>,
): Promise<boolean> {
  const guildId = interaction.guildId
  if (!guildId) return false
  if (await isApplicationGuild(interaction)) return true

  const rows = await findChannelsByDirectory({}).catch(() => [])
  if (rows.some((row) => row.guild_id === guildId)) return true
  const candidates = [...new Set([
    ...configuredChannelIds(),
    ...rows.filter((row) => !row.guild_id).map((row) => row.channel_id),
  ])]
  if (candidates.length === 0) return false

  // Cached channels first; fetch only what the cache does not know.
  const uncached: string[] = []
  for (const id of candidates) {
    if (!interaction.client.channels.cache.has(id)) {
      uncached.push(id)
      continue
    }
    if (await channelGuildId(interaction.client, id, false) === guildId) return true
  }
  const fetched = await Promise.all(uncached.map((id) => channelGuildId(interaction.client, id, true)))
  return fetched.includes(guildId)
}

export function registerInteractionHandler({
  discordClient,
  appId,
}: {
  discordClient: Client
  appId: string
}) {
  interactionLogger.log('[REGISTER] Interaction handler registered')

  discordClient.on(
    Events.InteractionCreate,
    async (interaction: Interaction) => {
      const ingressChannelId = serialIngressChannelId(interaction)
      const ingressSlot = ingressChannelId
        ? reserveThreadIngress(ingressChannelId)
        : undefined
      await runInThreadIngressSlot(ingressSlot, async () => {
      try {
        const route = routeForInteraction(interaction)
        interactionLogger.log(
          `[INTERACTION] Received: ${interaction.type} - ${
            interaction.isChatInputCommand()
              ? interaction.commandName
              : interaction.isAutocomplete()
                ? `autocomplete:${interaction.commandName}`
                : 'other'
          }`,
        )

        // Person-scoped buttons sent in a DM (welcome Connect buttons, #292
        // link prompts) have no guild channel to own. Their handlers act only
        // for the clicking user (fail closed), so a DM button can only ever
        // act on the clicker's own account.
        if (!interaction.guild && route?.personScoped && isComponentInteraction(interaction)) {
          await route.handle(interaction, { channelBound: true })
          return
        }

        // Multi-machine routing: only handle interactions for channels owned
        // by this machine (have a project directory configured in local db).
        // If not owned, silently return so the other machine handles it.
        // Setup commands must not let an unconfigured server grant itself host access.
        const channelCommand = (interaction.isChatInputCommand() || interaction.isAutocomplete()) && interaction.commandName === 'channel'
        const applicationGuild = channelCommand && await isApplicationGuild(interaction)
        const owned = await isInteractionOwnedByThisMachine(interaction)
        // Person-scoped commands need no project: answer them in any channel
        // of a guild this machine serves, so they never go unanswered (#301).
        const unboundPersonScoped = !owned && !applicationGuild && isPersonScopedInteraction(interaction)
          && await isGuildServedByThisMachine(interaction)
        if (!owned && !applicationGuild && !unboundPersonScoped) {
          interactionLogger.log(
            `[IGNORED] Channel ${interaction.channelId} has no project directory configured, skipping interaction`,
          )
          // Do not respond at all — consuming the interaction token would
          // prevent the owning machine from responding (tokens are single-use).
          return
        }

        // Only the owning machine may consume the token. Acknowledge forks
        // before identity/intake hooks and directory or backend setup can
        // exhaust Discord's three-second initial response deadline.
        if (interaction.isChatInputCommand() && interaction.commandName === 'fork') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        }
        // Same for components (#306): the identity lookup below can outlast
        // the deadline, so each is acknowledged as its route says. Denials
        // then go out as ephemeral follow-ups. Modal openers answer with
        // showModal() instead. A component without a route is stale.
        if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
          if (!route) {
            interactionLogger.warn(`[COMPONENT] No route for custom id ${interaction.customId}`)
            await interaction.reply({ content: UNKNOWN_COMPONENT_MESSAGE, flags: MessageFlags.Ephemeral })
            return
          }
          await acknowledgeComponent(interaction, route)
        }

        // Person filter (if configured): resolve the person once, before the
        // synchronous permission checks below read the cached result. A known
        // person is answered at once while an expired lookup refreshes, so
        // modal openers stay within the deadline.
        if (interaction.guild) {
          const person = await resolvePerson({
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
          // Fail closed, but say the lookup failed rather than a denial.
          if (person?.lookupFailed) {
            if (interaction.isRepliable()) {
              await replyOrEditInteraction(interaction, IDENTITY_LOOKUP_FAILED_MESSAGE)
            }
            return
          }
        }

        // Self-serve identity linking (#292) is for people Roadie does not
        // admit yet, so /connect and Link buttons skip the permission and
        // channel-audience checks below. Both act only for the clicking user.
        if (interaction.isChatInputCommand() && interaction.commandName === 'connect') {
          await handleConnectCommand({ command: interaction, channelBound: !unboundPersonScoped })
          return
        }
        if (route?.selfServe && isComponentInteraction(interaction)) {
          await route.handle(interaction, { channelBound: !unboundPersonScoped })
          return
        }

        // Explicit application management is the only bootstrap exception to
        // ownership/response policy. The handler still requires admin identity.
        if (channelCommand && interaction.isAutocomplete()) {
          await handleChannelAutocomplete(interaction)
          return
        }
        if (channelCommand && interaction.isChatInputCommand()) {
          await handleChannelCommand({ command: interaction, appId })
          return
        }

        // Channel policy: interactions in channels the bot does not answer, or
        // from users outside the channel's audience, are ignored. Consuming
        // the token here is fine: this machine owns the channel. An unbound
        // channel has no policy of its own; person-scoped commands there are
        // still gated by the permission checks below.
        if (!unboundPersonScoped && interaction.guild && interaction.channelId) {
          const member = interaction.member
          const roleIds = member
            ? Array.isArray(member.roles)
              ? member.roles
              : [...member.roles.cache.keys()]
            : []
          const roleNames = roleIds
            .map((id) => interaction.guild?.roles.cache.get(id)?.name)
            .filter((name): name is string => Boolean(name))
          const blocked =
            decideRespond(interaction.channelId) === 'ignore' ||
            !channelAllowsSpeaker(interaction.channelId, {
              userId: interaction.user.id,
              isGuildOwner: interaction.guild.ownerId === interaction.user.id,
              roleNames,
              roleIds,
              personId: getCachedPerson({ platform: 'discord', id: interaction.user.id })?.personId,
            })
          if (blocked) {
            if (interaction.isAutocomplete()) {
              await interaction.respond([])
            } else if (interaction.isRepliable()) {
              await replyOrEditInteraction(interaction, 'Roadie is not available to you in this channel.')
            }
            return
          }
        }

        // First contact with an admitted person: one private welcome (DM).
        // /start shows the same text itself.
        const startCommand = interaction.isChatInputCommand() && interaction.commandName === 'start'
        if (interaction.guild && !interaction.isAutocomplete() && !startCommand) {
          void welcomeDiscordUser({
            user: interaction.user,
            displayName: interaction.user.displayName,
            person: getCachedPerson({ platform: 'discord', id: interaction.user.id }),
            // Never point the welcome at a channel Roadie does not answer in.
            ...(interaction.channelId && !unboundPersonScoped ? { channelId: interaction.channelId } : {}),
          })
        }

        if (!unboundPersonScoped && !interaction.isAutocomplete() && interaction.channel?.isThread() && interaction.isRepliable() && resolveChannelPolicy(interaction.channel.id)?.intake) {
          const thread = interaction.channel
          const scope = { platform: 'discord', spaceId: thread.guildId, threadId: thread.id }
          const hasSession = Boolean(await getThreadSession(thread.id))
          const admission = await readConversationAdmission(scope)
          const actor = { platform: 'discord', id: interaction.user.id, name: interaction.user.displayName }
          const intake = await resolveConversationIntake({ actor, spaceId: thread.guildId, channelId: thread.parentId ?? thread.id, threadId: thread.id,
            personId: getCachedPerson(actor)?.personId,
            eligible: hasRoadieBotPermission(interaction.member, interaction.guild), isNewConversation: !hasSession && !admission,
            createsThread: interaction.isChatInputCommand() && ['new-session', 'fork'].includes(interaction.commandName), hasSession,
            mentionsBot: false, isCommand: true, messageId: interaction.id, text: interaction.isChatInputCommand() ? `/${interaction.commandName}` : 'interactive callback', legacyOutcome: 'respond' })
          if (intake.outcome !== 'respond') {
            await replyOrEditInteraction(interaction, 'Your account is not admitted to this conversation.')
            return
          }
          await recordConversationAdmission({ scope, actor, starter: !hasSession && !admission, decision: intake })
        }

        if (interaction.isAutocomplete()) {
          if (!hasRoadieBotPermission(interaction.member, interaction.guild)) {
            await interaction.respond([])
            return
          }

          switch (interaction.commandName) {
            case 'new-session':
              await handleSessionAutocomplete({ interaction, appId })
              return

            case 'remove-project':
              await handleRemoveProjectAutocomplete({ interaction, appId })
              return

            case 'fork':
              await handleForkAutocomplete({ interaction })
              return

            default:
              if (
                interaction.commandName.endsWith('-agent') &&
                interaction.commandName !== 'agent'
              ) {
                await handleQuickAgentAutocomplete({ interaction, appId })
                return
              }
              await interaction.respond([])
              return
          }
        }

        if (interaction.isChatInputCommand()) {
          interactionLogger.log(
            `[COMMAND] Processing: ${interaction.commandName}`,
          )

          if (!hasRoadieBotPermission(interaction.member, interaction.guild)) {
            await replyOrEditInteraction(interaction,
              `You don't have permission to use this command.\nTo use Roadie, ask a server admin to give you the **Roadie** role.`,
            )
            return
          }

          switch (interaction.commandName) {
            case 'new-session':
              await handleSessionCommand({ command: interaction, appId })
              return

            case 'tasks':
              await handleTasksCommand({
                command: interaction,
                appId,
              })
              return

            case 'last-sessions':
              await handleLastSessionsCommand({
                command: interaction,
                appId,
              })
              return

            case 'remove-project':
              await handleRemoveProjectCommand({ command: interaction, appId })
              return

            case 'abort':
              await handleAbortCommand({ command: interaction, appId })
              return

            case 'compact':
              await handleCompactCommand({ command: interaction, appId })
              return

            case 'fork':
              await handleForkCommand({ interaction, appId })
              return

            case 'model':
              await handleModelCommand({ interaction, appId })
              return

            case 'credentials':
              if (!store.getState().credentialPoolsEnabled) {
                // Stale registration: /credentials only exists when
                // --credential-pools is on. Fail closed rather than touch pools.
                await interaction.reply({
                  content: 'Credential pools are not enabled on this server.',
                  flags: MessageFlags.Ephemeral,
                })
                return
              }
              await handleCredentialsCommand({ command: interaction })
              return

            case 'agent':
              await handleAgentCommand({ interaction, appId })
              return

            case 'verbosity':
              await handleVerbosityCommand({ command: interaction, appId })
              return

            case 'run-shell-command':
              if (
                !channelAllowsCapability(interaction.channelId, 'shell') ||
                !hasRoadieShellPermission(interaction.member, interaction.guild)
              ) {
                await interaction.reply({
                  content: "You don't have permission to run shell commands.",
                  flags: MessageFlags.Ephemeral,
                })
                return
              }
              await handleRunCommand({ command: interaction, appId })
              return

            case 'context-usage':
              await handleContextUsageCommand({ command: interaction, appId })
              return

            case 'session-id':
              await handleSessionIdCommand({ command: interaction, appId })
              return

            case 'upgrade-and-restart':
              await handleUpgradeAndRestartCommand({
                command: interaction,
                appId,
              })
              return

            case 'mcp':
              await handleMcpCommand({ command: interaction, appId })
              return

            case 'start':
              await handleStartCommand({ command: interaction, channelBound: !unboundPersonScoped })
              return

          }

          // Handle quick agent commands (ending with -agent suffix, but not the base /agent command)
          if (
            interaction.commandName.endsWith('-agent') &&
            interaction.commandName !== 'agent'
          ) {
            await handleQuickAgentCommand({ command: interaction, appId })
            return
          }

          // Handle user-defined commands (ending with -cmd, -skill, or -mcp-prompt suffix)
          if (
            interaction.commandName.endsWith('-cmd') ||
            interaction.commandName.endsWith('-skill') ||
            interaction.commandName.endsWith('-mcp-prompt')
          ) {
            await handleUserCommand({ command: interaction, appId })
            return
          }
          return
        }

        if (route && isComponentInteraction(interaction)) {
          if (!hasRoadieBotPermission(interaction.member, interaction.guild)) {
            await replyOrEditInteraction(interaction,
              `You don't have permission to use this.\nTo use Roadie, ask a server admin to give you the **Roadie** role.`,
            )
            return
          }
          await route.handle(interaction, { channelBound: !unboundPersonScoped })
        }
      } catch (error) {
        interactionLogger.error(
          '[INTERACTION] Error handling interaction:',
          error,
        )
        void notifyError(error, 'Interaction handler error')
        try {
          if (interaction.isRepliable() && !interaction.replied) {
            if (interaction.deferred) {
              // Component interactions that used deferUpdate() set ephemeral
              // to null. For those, followUp is correct (editReply would
              // overwrite the original message). For deferReply() interactions
              // (ephemeral is true/false), editReply resolves the pending reply.
              const usedDeferUpdate =
                interaction.isMessageComponent() &&
                interaction.ephemeral === null
              if (usedDeferUpdate) {
                await interaction.followUp({
                  content: 'An error occurred processing this interaction.',
                  flags: MessageFlags.Ephemeral,
                })
              } else {
                await interaction.editReply({
                  content: 'An error occurred processing this command.',
                })
              }
            } else {
              await interaction.reply({
                content: 'An error occurred processing this command.',
                flags: MessageFlags.Ephemeral,
              })
            }
          }
        } catch (replyError) {
          interactionLogger.error(
            '[INTERACTION] Failed to send error reply:',
            replyError,
          )
        }
      }
      })
    },
  )
}
