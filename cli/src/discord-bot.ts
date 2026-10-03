// Core Discord bot module that handles message events and bot lifecycle.
// Bridges Discord messages to OpenCode sessions, manages voice connections,
// and orchestrates the main event loop for the Roadie bot.
//
// Shutdown resilience: during self-restart (gateway reconnect limit, SIGUSR2),
// discord.js can still fire errors from pending async operations (DNS lookups,
// WebSocket frames) after the client is destroyed. The uncaughtException handler
// suppresses these when shuttingDown is already set, and we removeAllListeners()
// before destroying the client to prevent late events from becoming uncaught.

declare global {
  // eslint-disable-next-line no-var
  var shuttingDown: boolean | undefined
}

import { recordInterruptedSessions } from './service-lifecycle.js'
import { DiscordOperationError } from './errors.js'
import {
  initDatabase,
  closeDatabase,
  getThreadWorkingDirectory,
  getThreadSession,
  getChannelMentionMode,
  getChannelDirectory,
  cancelAllPendingIpcRequests,
  cleanupDeletedThread,
  clearGuildCategoryByChannelId,
  consumeSessionSleepWake,
  deleteChannelDirectoryById,
  findChannelsByDirectory,
  isCurrentThreadSessionBinding,
  setThreadWorkingDirectory,
} from './database.js'
import {
  stopOpencodeServer,
} from './opencode.js'
import { resolveSessionWorkingDirectory, git } from './git-utils.js'
import { asSubtext } from './message-formatting.js'
import {
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
  sendThreadMessage,
  SILENT_MESSAGE_FLAGS,
  NOTIFY_MESSAGE_FLAGS,
  reactToThread,
  stripMentions,
  hasRoadieBotPermission,
  hasRoadieShellPermission,
  hasNoRoadieRole,
  resolveGuildMessageMember,
} from './discord-utils.js'
import {
  getOpencodeSystemMessage,
  isInjectedPromptMarker,
  type ThreadStartMarker,
} from './system-message.js'
import YAML from 'yaml'
import { getFileAttachments, getTextAttachments, resolveContentMentions } from './message-formatting.js'
import { extractBtwQueueSuffix } from './btw-prefix-detection.js'
import { forkSessionToBtwThread } from './commands/btw.js'
import {
  preprocessExistingThreadMessage,
  preprocessNewThreadMessage,
  resolveMessagePrompt,
} from './message-preprocessing.js'
import { cancelPendingActionButtons } from './commands/action-buttons.js'
import { cancelPendingQuestion, hasPendingQuestionForThread } from './commands/ask-question.js'
import { cancelPendingFileUpload } from './commands/file-upload.js'
import { cancelPendingPermission } from './commands/permissions.js'
import { cancelHtmlActionsForThread } from './html-actions.js'
import {
  ensureRoadieCategory,
  createProjectChannels,
  getChannelsWithDescriptions,
  type ChannelWithTags,
} from './channel-management.js'
import {
  type SessionStartSourceContext,
} from './session-handler/model-utils.js'
import {
  getRuntime,
  getOrCreateRuntime,
  disposeRuntime,
  getRuntimeThreadIdsForChannel,
  restorePersistedLocalQueues,
  resumeInterruptedSessions,
  snapshotBusyRuntimes,
  reserveThreadIngress,
  runInThreadIngressSlot,
} from './session-handler/thread-session-runtime.js'
import { runShellCommand } from './commands/run-command.js'
import { registerInteractionHandler } from './interaction-handler.js'
import { getDiscordRestApiUrl } from './discord-urls.js'
import { markDiscordGatewayReady, stopHranaServer } from './hrana-server.js'
import { notifyError } from './sentry.js'
import { flushDebouncedProcessCallbacks } from './debounced-process-flush.js'
import { startRuntimeIdleSweeper } from './runtime-idle-sweeper.js'
import {
  getDefaultRoadieDirectory,
} from './channel-management.js'
import { store } from './store.js'
import {
  startExternalOpencodeSessionSync,
  stopExternalOpencodeSessionSync,
} from './external-opencode-sync.js'

export {
  initDatabase,
  closeDatabase,
  getChannelDirectory,
} from './database.js'
export { initializeOpencodeForDirectory, assertCompatibleOpencodeVersion } from './opencode.js'
export {
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
} from './discord-utils.js'
export { getOpencodeSystemMessage } from './system-message.js'
export {
  ensureRoadieCategory,
  createProjectChannels,
  createDefaultRoadieChannel,
  getChannelsWithDescriptions,
} from './channel-management.js'
export type { ChannelWithTags } from './channel-management.js'

import {
  ChannelType,
  Client,
  Events,
  RESTEvents,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'

import dedent from 'string-dedent'
import { createLogger, formatErrorWithStack, LogPrefix } from './logger.js'
import { writeHeapSnapshot, startHeapMonitor } from './heap-monitor.js'
import {
  flushCpuProfiling,
  startStdinCpuProfListener,
  stopStdinCpuProfListener,
} from './cpu-profiler.js'
import { startTaskRunner } from './task-runner.js'
import { getCachedPerson, isIdentityHookConfigured, resolvePerson } from './identity.js'
import {
  channelAllowsCapability,
  channelAllowsSpeaker,
  channelStartsThreads,
  decideRespond,
  setChannelParentResolver,
} from './channel-policy.js'
// Increase connection pool to prevent deadlock when multiple sessions have open SSE streams.
// Each session's event.subscribe() holds a connection; without enough connections,
// regular HTTP requests (question.reply, session.prompt) get blocked → deadlock.
// undici is a transitive dep from discord.js — not listed in our package.json.
// Types are declared in src/undici.d.ts.


const discordLogger = createLogger(LogPrefix.DISCORD)
const voiceLogger = createLogger(LogPrefix.VOICE)

const MISSING_MESSAGE_CONTENT_REPLY = dedent`
  I can see you sent a message, but Discord did not include its text.
  Mention me and send it again, like \`@Roadie fix the failing test\`, so I can read it.
  To avoid this reminder, start Roadie with \`--mention-mode\` so it only reacts to mentioned messages.
`

function isMissingReadableMessageContent(message: Message) {
  if (message.author.bot) return false
  if (message.content.trim()) return false
  if (message.attachments.size > 0) return false
  if (message.embeds.length > 0) return false
  if (message.stickers.size > 0) return false
  return true
}

// Well-known WebSocket and Discord Gateway close codes for diagnostic logging.
// Gateway proxy redeploys cause an abrupt TCP drop (code 1006) because the proxy
// doesn't send a close frame to clients before shutting down. discord.js then
// enters reconnection mode. The ShardReconnecting event intentionally strips the
// close code for recoverable disconnects, so we track it ourselves from the
// lower-level ShardDisconnect and ShardError events and correlate by shard ID.
function describeCloseCode(code: number): string {
  const codes: Record<number, string> = {
    1000: 'normal closure',
    1001: 'going away',
    1006: 'abnormal closure (no close frame received)',
    1011: 'unexpected server error',
    1012: 'service restart',
    4000: 'unknown error',
    4001: 'unknown opcode',
    4002: 'decode error',
    4003: 'not authenticated',
    4004: 'authentication failed',
    4005: 'already authenticated',
    4007: 'invalid seq',
    4008: 'rate limited',
    4009: 'session timed out',
    4010: 'invalid shard',
    4011: 'sharding required',
    4012: 'invalid API version',
    4013: 'invalid intents',
    4014: 'disallowed intents',
  }
  return codes[code] || 'unknown'
}

// Per-shard state for tracking reconnection context.
// When discord.js fires ShardReconnecting it only provides the shard ID.
// We stash the last error / close code from preceding events so the
// reconnecting log line can include the actual cause.
interface ShardReconnectInfo {
  lastError?: Error
  lastDisconnectCode?: number
  attempts: number
}
const shardReconnectState = new Map<number, ShardReconnectInfo>()

function getOrCreateShardState(shardId: number): ShardReconnectInfo {
  let state = shardReconnectState.get(shardId)
  if (!state) {
    state = { attempts: 0 }
    shardReconnectState.set(shardId, state)
  }
  return state
}

function parseEmbedFooterMarker<T extends Record<string, unknown>>({
  footer,
}: {
  footer: string | undefined
}): T | undefined {
  if (!footer) {
    return undefined
  }
  try {
    const parsed = YAML.parse(footer)
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }
    return parsed as T
  } catch {
    return undefined
  }
}

function parseSessionStartSourceFromMarker(
  marker: ThreadStartMarker | undefined,
): SessionStartSourceContext | undefined {
  if (!marker?.scheduledKind) {
    return undefined
  }
  if (marker.scheduledKind !== 'at' && marker.scheduledKind !== 'cron') {
    return undefined
  }
  if (
    typeof marker.scheduledTaskId !== 'number' ||
    !Number.isInteger(marker.scheduledTaskId) ||
    marker.scheduledTaskId < 1
  ) {
    return {
      scheduleKind: marker.scheduledKind,
      scheduledTaskRunId: marker.scheduledTaskRunId,
    }
  }
  return {
    scheduleKind: marker.scheduledKind,
    scheduledTaskId: marker.scheduledTaskId,
    scheduledTaskRunId: marker.scheduledTaskRunId,
  }
}

type StartOptions = {
  token: string
  appId?: string
}

export async function createDiscordClient() {
  // Read REST API URL lazily so gateway mode can set store.discordBaseUrl
  // after module import but before client creation.
  const restApiUrl = getDiscordRestApiUrl()
  const { allowedMentions } = store.getState()
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
    rest: { api: restApiUrl },
    allowedMentions: { parse: allowedMentions },
  })
}

/**
 * Gate raw shell execution (`!cmd`). CLI-injected prompts from this bot keep
 * working as before; human authors need the shell capability. Replies and
 * returns false when denied.
 */
async function allowShellCommand({
  message,
  isCliInjectedPrompt,
}: {
  message: Message
  isCliInjectedPrompt: boolean
}): Promise<boolean> {
  if (isCliInjectedPrompt || !message.guild) return true
  const member = await resolveGuildMessageMember(message)
  if (
    channelAllowsCapability(message.channelId, 'shell') &&
    hasRoadieShellPermission(member, message.guild)
  ) {
    return true
  }
  await message.reply({
    content: "You don't have permission to run shell commands.",
    flags: SILENT_MESSAGE_FLAGS,
  })
  return false
}

export async function startDiscordBot({
  token,
  appId,
  discordClient,
}: StartOptions & { discordClient?: Client }) {
  if (!discordClient) {
    discordClient = await createDiscordClient()
  }

  activeDiscordClient = discordClient
  registerBotLifecycleHandlers()

  let currentAppId: string | undefined = appId

  const cleanupDeletedDiscordThread = async (threadId: string) => {
    const abortActiveRun = await isCurrentThreadSessionBinding(threadId)
    disposeRuntime(threadId, { abortActiveRun })
    await cleanupDeletedThread(threadId)
  }

  const cleanupDeletedDiscordChannel = async (channelId: string) => {
    const mapping = await getChannelDirectory(channelId)
    const preserveMapping = mapping?.directory === getDefaultRoadieDirectory()
    const threadIds = getRuntimeThreadIdsForChannel(channelId)
    await Promise.all(threadIds.map(cleanupDeletedDiscordThread))
    await clearGuildCategoryByChannelId(channelId)
    const deleted = await deleteChannelDirectoryById(channelId, {
      preserveMapping,
    })
    if (preserveMapping) {
      discordLogger.log(
        `Preserved deleted default channel ${channelId} as a tombstone`,
      )
      return
    }
    if (deleted) {
      discordLogger.log(`Cleaned up deleted channel ${channelId}`)
    }
  }

  const reconcileDeletedDiscordChannels = async (c: Client<true>) => {
    const mappings = await findChannelsByDirectory({})
    for (const mapping of mappings) {
      const channel = await c.channels
        .fetch(mapping.channel_id, { force: true })
        .catch((error) => {
          const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
          const status = error instanceof Error ? Reflect.get(error, 'status') : undefined
          if (code === 10003 || status === 404) return null
          discordLogger.warn(
            `Could not verify channel ${mapping.channel_id}; preserving its SQLite mapping: ${formatErrorWithStack(error)}`,
          )
          return undefined
        })
      if (channel !== null) continue
      await cleanupDeletedDiscordChannel(mapping.channel_id)
    }
  }

  const setupHandlers = async (c: Client<true>) => {
    discordLogger.log(`Discord bot logged in as ${c.user.tag}`)
    discordLogger.log(`Connected to ${c.guilds.cache.size} guild(s)`)
    discordLogger.log(`Bot user ID: ${c.user.id}`)

    if (!currentAppId) {
      await c.application?.fetch()
      currentAppId = c.application?.id

      if (!currentAppId) {
        discordLogger.error('Could not get application ID')
        throw new Error('Failed to get bot application ID')
      }
      discordLogger.log(`Bot Application ID (fetched): ${currentAppId}`)
    } else {
      discordLogger.log(`Bot Application ID (provided): ${currentAppId}`)
    }

    voiceLogger.log('[READY] Bot is ready')
    markDiscordGatewayReady()

    setChannelParentResolver((channelId) => {
      const cached = c.channels.cache.get(channelId)
      return cached && 'parentId' in cached ? cached.parentId : undefined
    })
    registerInteractionHandler({ discordClient: c, appId: currentAppId })
    await reconcileDeletedDiscordChannels(c)
    startExternalOpencodeSessionSync({ discordClient: c })
    await restorePersistedLocalQueues({
      discordClient: c,
      appId: currentAppId,
    }).catch((error) => {
      discordLogger.warn(
        `Failed to restore persisted local queues: ${error instanceof Error ? error.stack : String(error)}`,
      )
    })
    await resumeInterruptedSessions({
      discordClient: c,
      appId: currentAppId,
    }).catch((error) => {
      discordLogger.warn(
        `Failed to resume interrupted sessions: ${error instanceof Error ? error.stack : String(error)}`,
      )
    })

    // Channel logging is informational only; do it in background so startup stays responsive.
    void (async () => {
      for (const guild of c.guilds.cache.values()) {
        discordLogger.log(`${guild.name} (${guild.id})`)

        const channels = await getChannelsWithDescriptions(guild)
        const roadieChannels = channels.filter((ch) => ch.roadieDirectory)

        if (roadieChannels.length > 0) {
          discordLogger.log(
            `  Found ${roadieChannels.length} channel(s) for this bot`,
          )
          continue
        }

        discordLogger.log('  No channels for this bot')
      }
    })().catch((error) => {
      discordLogger.warn(
        `Background guild channel scan failed: ${error instanceof Error ? error.stack : String(error)}`,
      )
    })
  }

  // Keep startup ordered so stale targets are removed before queues and
  // scheduled tasks can deliver work to them.
  const setupPromise = discordClient.isReady()
    ? setupHandlers(discordClient)
    : new Promise<void>((resolve, reject) => {
        discordClient.once(Events.ClientReady, (readyClient) => {
          void setupHandlers(readyClient).then(resolve, reject)
        })
      })

  discordClient.on(Events.Error, (error) => {
    discordLogger.error('[GATEWAY] Client error:', formatErrorWithStack(error))
  })

  // discord.js silently waits out 429s, so log them to explain slow REST calls.
  discordClient.rest.on(RESTEvents.RateLimited, (info) => {
    discordLogger.warn(
      `[REST] Rate limited ${info.method} ${info.route} retryAfter=${info.retryAfter}ms scope=${info.scope} global=${info.global} sublimitTimeout=${info.sublimitTimeout}ms`,
    )
  })

  discordClient.on(Events.ShardError, (error, shardId) => {
    const state = getOrCreateShardState(shardId)
    state.lastError = error
    discordLogger.error(
      `[GATEWAY] Shard ${shardId} error: ${formatErrorWithStack(error)}`,
    )
  })

  discordClient.on(Events.ShardDisconnect, (event, shardId) => {
    // ShardDisconnect fires for unrecoverable close codes (4004, 4010-4014).
    // For recoverable codes discord.js fires ShardReconnecting instead.
    const state = getOrCreateShardState(shardId)
    state.lastDisconnectCode = event.code
    discordLogger.warn(
      `[GATEWAY] Shard ${shardId} disconnected: code=${event.code} (${describeCloseCode(event.code)})`,
    )
  })

  // discord.js retries gateway reconnection indefinitely. If the gateway is
  // unreachable for an extended period (network outage, proxy down, etc.) the
  // bot becomes a zombie — alive but unable to receive events. After this many
  // consecutive failed attempts we self-restart (cleanup + spawn fresh process).
  // Normal transient disconnects recover within a handful of attempts; 50 means
  // several minutes of sustained failure (discord.js uses exponential backoff).
  const MAX_RECONNECT_ATTEMPTS = 50

  discordClient.on(Events.ShardReconnecting, (shardId) => {
    // discord.js strips the close code before emitting this event.
    // We log whatever context we captured from preceding ShardError events.
    const state = getOrCreateShardState(shardId)
    state.attempts++

    const parts: string[] = [`attempt #${state.attempts}`]
    if (state.lastDisconnectCode !== undefined) {
      parts.push(`close code=${state.lastDisconnectCode} (${describeCloseCode(state.lastDisconnectCode)})`)
    }
    if (state.lastError) {
      parts.push(`last error: ${state.lastError.message}`)
    }
    discordLogger.warn(
      `[GATEWAY] Shard ${shardId} reconnecting: ${parts.join(', ')}`,
    )

    if (state.attempts >= MAX_RECONNECT_ATTEMPTS) {
      discordLogger.error(
        `[GATEWAY] Shard ${shardId} exceeded ${MAX_RECONNECT_ATTEMPTS} reconnect attempts, self-restarting`,
      )
      // Self-restart: cleanup, then SIGKILL so the bin.ts wrapper
      // restarts us. Without the wrapper this dies after logging a warning.
      void selfRestart('gateway-reconnect-limit')
    }
  })

  discordClient.on(Events.ShardResume, (shardId, replayedEvents) => {
    const state = shardReconnectState.get(shardId)
    if (state?.attempts) {
      discordLogger.log(
        `[GATEWAY] Shard ${shardId} resumed after ${state.attempts} reconnect attempt(s), ${replayedEvents} replayed events`,
      )
    } else {
      discordLogger.log(
        `[GATEWAY] Shard ${shardId} resumed, ${replayedEvents} replayed events`,
      )
    }
    shardReconnectState.delete(shardId)
  })

  // ShardReady fires when a shard completes a fresh IDENTIFY (not RESUME).
  // After a gateway proxy redeploy, sessions are lost (in-memory), so RESUME
  // fails with INVALID_SESSION and discord.js falls back to fresh IDENTIFY.
  discordClient.on(Events.ShardReady, (shardId) => {
    const state = shardReconnectState.get(shardId)
    if (state?.attempts) {
      discordLogger.log(
        `[GATEWAY] Shard ${shardId} ready after ${state.attempts} reconnect attempt(s)`,
      )
    }
    shardReconnectState.delete(shardId)
  })

  discordClient.on(Events.Invalidated, () => {
    discordLogger.error('[GATEWAY] Session invalidated by Discord')
  })

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    const threadIngressSlot =
      message.channel.isThread() || message.channel.type === ChannelType.GuildText
        ? reserveThreadIngress(message.channel.id)
        : undefined
    await runInThreadIngressSlot(threadIngressSlot, async () => {
    try {
      const isSelfBotMessage = Boolean(
        discordClient.user && message.author?.id === discordClient.user.id,
      )
      const promptMarker = parseEmbedFooterMarker<ThreadStartMarker>({
        footer: message.embeds[0]?.footer?.text,
      })
      const isCliInjectedPrompt = Boolean(
        isSelfBotMessage && isInjectedPromptMarker({ marker: promptMarker }),
      )
      const sessionStartSource = isCliInjectedPrompt
        ? parseSessionStartSourceFromMarker(promptMarker)
        : undefined
      const cliInjectedUsername = isCliInjectedPrompt
        ? promptMarker?.username || 'roadie-cli'
        : undefined
      const cliInjectedUserId = isCliInjectedPrompt
        ? promptMarker?.userId
        : undefined
      const cliInjectedAgent = isCliInjectedPrompt
        ? promptMarker?.agent
        : undefined
      const cliInjectedModel = isCliInjectedPrompt
        ? promptMarker?.model
        : undefined
      const cliInjectedPermissions = isCliInjectedPrompt
        ? promptMarker?.permissions
        : undefined
      const cliInjectedInjectionGuardPatterns = isCliInjectedPrompt
        ? promptMarker?.injectionGuardPatterns
        : undefined
      const cliInjectedParentSessionId = isCliInjectedPrompt
        ? promptMarker?.parentSessionId
        : undefined

      // Always ignore our own messages (unless CLI-injected prompt above).
      // Without this, assigning the Roadie role to the bot itself would loop.
      if (isSelfBotMessage && !isCliInjectedPrompt) {
        return
      }

      // Allow CLI-injected prompts from this Roadie bot through even when role
      // reconciliation did not give the bot the "Roadie" role yet. Other bots
      // still need Roadie permission so multi-agent orchestration stays opt-in.
      const isInjectedSelfBotMessage =
        isCliInjectedPrompt && message.author?.id === discordClient.user?.id

      if (message.author?.bot && !isInjectedSelfBotMessage) {
        const member = await resolveGuildMessageMember(message)
        if (!hasRoadieBotPermission(member, message.guild)) {
          return
        }
      }

      // Detect messages that start with a mention of another user (not the bot).
      // In channels these are fully ignored. In threads they are added to the
      // session context without triggering the AI (noReply), so the agent sees
      // user-to-user conversation on the next real turn.
      const leadingMentionMatch = message.content?.match(/^<@!?(\d+)>/)
      const isLeadingMentionToOtherUser =
        leadingMentionMatch &&
        leadingMentionMatch[1] !== discordClient.user?.id

      if (message.partial) {
        discordLogger.log(`Fetching partial message ${message.id}`)
        const fetched = await message.fetch()
          .catch((e) => new DiscordOperationError({ operation: 'fetchMessage', cause: e }))
        if (fetched instanceof Error) {
          discordLogger.log(
            `Failed to fetch partial message ${message.id}:`,
            fetched.message,
          )
          return
        }
      }

      // Check mention mode BEFORE permission check for text channels.
      // When mention mode is enabled, users without Roadie role can message
      // without getting a permission error - we just silently ignore.
      const channel = message.channel

      // In text channels, messages starting with a mention to another user
      // are fully ignored before any permission or mention-mode checks.
      // This prevents permission-error replies for user-to-user conversation.
      if (channel.type === ChannelType.GuildText && isLeadingMentionToOtherUser) {
        return
      }

      // Channel policy (if configured) decides whether this channel is
      // answered at all and whether a mention is required. Without a policy
      // file the built-in per-channel mention mode applies.
      if (!isCliInjectedPrompt) {
        const respond = decideRespond(channel.id)
        if (respond === 'ignore') {
          return
        }
        const mentionRequired =
          respond === 'needs-mention' ||
          (respond === 'builtin' && channel.type === ChannelType.GuildText &&
            (await getChannelMentionMode(channel.id)))
        // Mentions only gate new conversations in channels; threads continue.
        if (mentionRequired && channel.type === ChannelType.GuildText) {
          const botMentioned =
            discordClient.user && message.mentions.has(discordClient.user.id)
          const isShellCommand = message.content?.startsWith('!')
          if (!botMentioned && !isShellCommand) {
            voiceLogger.log(`[IGNORED] Mention required in this channel, bot not mentioned`)
            return
          }
        }
      }

      // Multi-machine routing: check channel ownership before permission
      // checks so we don't send permission-denial replies in channels owned
      // by another machine. Resolve the "owning" channel: for threads, check
      // the parent channel; for text channels, check the channel itself.
      if (!isCliInjectedPrompt && message.guild) {
        const channel = message.channel
        let owningChannelId: string | undefined
        if (
          [
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread,
          ].includes(channel.type)
        ) {
          const thread = channel as ThreadChannel
          owningChannelId = thread.parent?.id || thread.parentId || undefined
        } else {
          owningChannelId = channel.id
        }
        if (owningChannelId) {
          const channelConfig = await getChannelDirectory(owningChannelId)
          if (!channelConfig) {
            voiceLogger.log(
              `[IGNORED] Channel ${owningChannelId} has no project directory configured`,
            )
            return
          }
        }
      }

      if (!isCliInjectedPrompt && message.guild) {
        const member = await resolveGuildMessageMember(message)
        if (!member) {
          return
        }

        // Identity hook (if configured): resolve the person before the
        // synchronous permission checks below, which read the cached result.
        await resolvePerson({
          actor: {
            platform: 'discord',
            id: message.author.id,
            name: member.displayName || message.author.displayName,
          },
          context: { guildId: message.guild.id, channelId: message.channelId },
        })

        // Channel policy audience. Speakers outside it are ignored silently so
        // ordinary conversation in shared channels gets no denial replies.
        const speakerAllowed = channelAllowsSpeaker(message.channelId, {
          userId: message.author.id,
          isGuildOwner: message.guild.ownerId === message.author.id,
          roleNames: member.roles.cache.map((role) => role.name),
          roleIds: [...member.roles.cache.keys()],
          personId: getCachedPerson({ platform: 'discord', id: message.author.id })?.personId,
        })
        if (!speakerAllowed) {
          voiceLogger.log(`[IGNORED] ${message.author.id} is outside this channel's audience`)
          return
        }

        if (hasNoRoadieRole(member)) {
          await message.reply({
            content: `You have the **no-roadie** role which blocks bot access.\nRemove this role to use Roadie.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        if (!hasRoadieBotPermission(member, message.guild)) {
          await message.reply({
            content: isIdentityHookConfigured()
              ? `You don't have permission to start sessions.\nAsk an admin to link and authorize your account.`
              : `You don't have permission to start sessions.\nTo use Roadie, ask a server admin to give you the **Roadie** role.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }
      }

      const isThread = [
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].includes(channel.type)

      if (isThread) {
        const thread = channel as ThreadChannel
        discordLogger.log(`Message in thread ${thread.name} (${thread.id})`)

        // Only respond in threads roadie knows about (has a session row in DB),
        // where the bot is explicitly @mentioned, or where the bot created the
        // thread itself (e.g. /fork, roadie send). This prevents
        // the bot from hijacking user-created threads in project channels while
        // still responding to bot-created threads that may not yet have a session
        // row with a non-empty session_id (createPendingWorkspace sets ''). (GitHub #84)
        const hasExistingSession = await getThreadSession(thread.id)
        const botMentioned =
          discordClient.user && message.mentions.has(discordClient.user.id)
        const botCreatedThread =
          discordClient.user && thread.ownerId === discordClient.user.id
        if (
          !hasExistingSession &&
          !botMentioned &&
          !isCliInjectedPrompt &&
          !botCreatedThread
        ) {
          discordLogger.log(
            `Ignoring thread ${thread.id}: no existing session and bot not mentioned`,
          )
          return
        }

        // Context-only messages (user-to-user replies) can't be stored without
        // an existing session. Skip early to avoid creating a runtime or running
        // preprocessing for nothing.
        if (isLeadingMentionToOtherUser && !hasExistingSession) {
          return
        }

        const parent = thread.parent as TextChannel | null
        let projectDirectory: string | undefined
        if (parent) {
          const channelConfig = await getChannelDirectory(parent.id)
          if (channelConfig) {
            projectDirectory = channelConfig.directory
          }
        }

        // A thread bound to its own working directory still runs its agent
        // server in the project root; the working directory is passed per call.
        const threadDir = await getThreadWorkingDirectory(thread.id)
        if (threadDir) {
          projectDirectory = threadDir.projectDirectory
          discordLogger.log(
            `Using project directory: ${projectDirectory} (thread working directory: ${threadDir.workingDirectory})`,
          )
        }

        if (projectDirectory && !fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await message.reply({
            content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
            flags: NOTIFY_MESSAGE_FLAGS,
          })
          return
        }

        // ! prefix runs a shell command in the thread's working directory
        // instead of starting/continuing a session.
        if (message.content?.startsWith('!') && projectDirectory) {
          const shellCmd = message.content.slice(1).trim()
          if (shellCmd) {
            threadIngressSlot?.release()
            if (!(await allowShellCommand({ message, isCliInjectedPrompt }))) {
              return
            }
            const shellDir = threadDir?.workingDirectory ?? projectDirectory
            const loadingReply = await message.reply({
              content: `Running \`${shellCmd.slice(0, 1900)}\`...`,
            })
            const result = await runShellCommand({
              command: shellCmd,
              directory: shellDir,
            })
            await loadingReply.edit({ content: result })
            return
          }
        }

        // `. btw` suffix mirrors /btw for fast side-question forks.
        // Works like queue: just the word "btw" at the end after punctuation
        // or newline. The whole message (minus the suffix) becomes the fork prompt.
        const suffix = extractBtwQueueSuffix(message.content || '')
        if (suffix.forceBtw && !suffix.forceQueue && projectDirectory && !isLeadingMentionToOtherUser) {
          threadIngressSlot?.release()
          const btwSdkDir = threadDir?.workingDirectory ?? projectDirectory
          // Ack right away: fork + thread creation can take seconds. Runs in
          // parallel with the fork and is edited with the result at the end.
          const ackPromise = message.reply({
            content: asSubtext('Forking session to answer this side question...'),
            flags: SILENT_MESSAGE_FLAGS,
          }).catch((error: unknown) => {
            discordLogger.warn('Could not send btw ack:', error)
            return undefined
          })
          // Long `roadie send` prompts arrive as prompt.md, so the fork needs attachments too.
          const [btwImages, btwTextAttachments] = await Promise.all([
            getFileAttachments(message),
            getTextAttachments(message),
          ])
          const result = await forkSessionToBtwThread({
            sourceThread: thread,
            projectDirectory,
            sdkDirectory: btwSdkDir,
            prompt: suffix.prompt,
            modelPrompt: [suffix.prompt, btwTextAttachments].filter(Boolean).join('\n\n'),
            images: btwImages.length > 0 ? btwImages : undefined,
            userId: cliInjectedUserId || message.author.id,
            actorVia: cliInjectedUserId ? 'cli' : 'chat',
            username:
              cliInjectedUsername ||
              message.member?.displayName ||
              message.author.displayName,
            appId: currentAppId,
          })

          const resultContent = result instanceof Error
            ? result.message
            : `Session forked! Continue in ${result.thread.toString()}`
          const ack = await ackPromise
          const edited = ack
            ? await ack.edit({ content: resultContent }).catch((error: unknown) => {
              discordLogger.warn('Could not edit btw ack:', error)
              return undefined
            })
            : undefined
          if (!edited) {
            await message.reply({ content: resultContent, flags: SILENT_MESSAGE_FLAGS })
          }
          return
        }

        if (!projectDirectory) {
          discordLogger.log(
            `Cannot process message: no project directory for thread ${thread.id}`,
          )
          return
        }

        if (isMissingReadableMessageContent(message)) {
          await message.reply({
            content: MISSING_MESSAGE_CONTENT_REPLY,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        const resolvedProjectDir = projectDirectory

        const sdkDir = threadDir?.workingDirectory ?? resolvedProjectDir
        const runtime = getOrCreateRuntime({
          threadId: thread.id,
          thread,
          projectDirectory: resolvedProjectDir,
          sdkDirectory: sdkDir,
          channelId: parent?.id || undefined,
          appId: currentAppId,
        })

        // Cancel interactive UI when a real user sends a message.
        // Context-only messages (user-to-user replies) should not interrupt
        // the active run or dismiss pending UI.
        const dismissSourceUi = async () => {
          if (message.author.bot || isCliInjectedPrompt || isLeadingMentionToOtherUser) return
          cancelPendingActionButtons(thread.id)
          cancelHtmlActionsForThread(thread.id)
          const dismissedPermission = await cancelPendingPermission(thread.id)
          if (dismissedPermission) {
            await runtime.abortActiveRunAndWait({
              reason: 'user sent a new message while permission was pending',
            })
          }
          const dismissedQuestion = hasPendingQuestionForThread(thread.id)
          if (dismissedQuestion) {
            await cancelPendingQuestion(thread.id)
            await runtime.abortActiveRunAndWait({
              reason: 'user sent a new message while question was pending',
            })
          }
          void cancelPendingFileUpload(thread.id)
        }
        if (!suffix.forceQueue) {
          await dismissSourceUi()
        }

        // A sleep wake only becomes a turn if it can still claim its own row.
        // The claim fails when the user cancelled the sleep while the wake was
        // being posted, so the superseded wake is dropped instead of starting a
        // turn the user already replaced. Cancellation for every other kind of
        // message happens inside runtime.enqueueIncoming().
        const isSleepWake = Boolean(promptMarker?.sleepWake)
        if (isSleepWake) {
          const claimedWake = promptMarker?.sleepId
            ? await consumeSessionSleepWake({ deliveryId: promptMarker.sleepId })
            : false
          if (!claimedWake) {
            discordLogger.log(
              `[SLEEP] ignoring superseded wake in thread ${thread.id}`,
            )
            return
          }
        }

        // Expensive pre-processing (voice transcription, context fetch,
        // attachment download) runs inside the runtime's serialized
        // preprocess chain, preserving Discord arrival order without
        // blocking SSE event handling in dispatchAction.
        const enqueueResult = await runtime.enqueueIncoming({
          prompt: '',
          userId: cliInjectedUserId || message.author.id,
            actorVia: cliInjectedUserId ? 'cli' : 'chat',
          username:
            cliInjectedUsername ||
            message.member?.displayName ||
            message.author.displayName,
          sourceMessageId: message.id,
          sourceThreadId: thread.id,
          sourceChannelId: message.channelId,
          appId: currentAppId,
          agent: cliInjectedAgent,
          model: cliInjectedModel,
          permissions: cliInjectedPermissions,
          injectionGuardPatterns: cliInjectedInjectionGuardPatterns,
          parentSessionId: cliInjectedParentSessionId,
          isSleepWake: isSleepWake || undefined,
          noReply: isLeadingMentionToOtherUser || undefined,
          sessionStartSource: sessionStartSource
            ? {
                scheduleKind: sessionStartSource.scheduleKind,
                scheduledTaskId: sessionStartSource.scheduledTaskId,
                scheduledTaskRunId: sessionStartSource.scheduledTaskRunId,
              }
            : undefined,
          preprocess: async () => {
            return preprocessExistingThreadMessage({
              message,
              thread,
              isCliInjected: isCliInjectedPrompt,
            })
          },
        })

        // Notify when the message was queued instead of sent immediately
        if (enqueueResult.queued && enqueueResult.position) {
          await sendThreadMessage(
            thread,
            asSubtext(`Queued at position ${enqueueResult.position}. Edit or delete your message to update the queue`),
          )
        }
      }

      if (channel.type === ChannelType.GuildText) {
        // `roadie send` posts a starter message with a `start` embed marker,
        // then creates the thread via REST. The ThreadCreate handler picks up
        // that thread and starts the session. If we don't skip here, this
        // handler races the CLI to call startThread() on the same message,
        // causing DiscordAPIError[160004] "A thread has already been created
        // for this message".
        if (promptMarker?.start) {
          return
        }

        voiceLogger.log(
          `[GUILD_TEXT] Message in text channel #${channel.name} (${channel.id})`,
        )

        const channelConfig = await getChannelDirectory(channel.id)

        if (!channelConfig) {
          const botMentioned = Boolean(
            discordClient.user && message.mentions.has(discordClient.user.id),
          )
          if (botMentioned) {
            // TODO: Consider creating/using a session for any text channel when Roadie is
            // explicitly @mentioned, so the bot can answer quick questions even before
            // the channel is linked to a project.
            await message.reply({
              content:
                'This channel is not connected to an OpenCode project.\nSend your message in a project channel, or use `/add-project` for an existing project, or `/create-new-project` to make a new one.',
              flags: SILENT_MESSAGE_FLAGS,
            })
            return
          }
          voiceLogger.log(
            `[IGNORED] Channel #${channel.name} has no project directory configured`,
          )
          return
        }

        const projectDirectory = channelConfig.directory

        // Note: Mention mode is checked early in the handler (before permission check)
        // to avoid sending permission errors to users who just didn't @mention the bot.

        discordLogger.log(`DIRECTORY: Found roadie.directory: ${projectDirectory}`)

        if (!fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await message.reply({
            content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
            flags: NOTIFY_MESSAGE_FLAGS,
          })
          return
        }

        if (isMissingReadableMessageContent(message)) {
          await message.reply({
            content: MISSING_MESSAGE_CONTENT_REPLY,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        // ! prefix runs a shell command instead of starting a session
        if (message.content?.startsWith('!')) {
          const shellCmd = message.content.slice(1).trim()
          if (shellCmd) {
            threadIngressSlot?.release()
            if (!(await allowShellCommand({ message, isCliInjectedPrompt }))) {
              return
            }
            const loadingReply = await message.reply({
              content: `Running \`${shellCmd.slice(0, 1900)}\`...`,
            })
            const result = await runShellCommand({
              command: shellCmd,
              directory: projectDirectory,
            })
            await loadingReply.edit({ content: result })
            return
          }
        }

        // Channel policy `threads: existing-only`: channel messages never start
        // a new session thread; existing threads keep working.
        if (!isCliInjectedPrompt && !channelStartsThreads(channel.id)) {
          voiceLogger.log(`[IGNORED] Channel ${channel.id} does not start new threads`)
          return
        }

        const baseThreadName =
          stripMentions(message.content || '')
            .replace(/\s+/g, ' ')
            .trim() || 'roadie thread'

        const threadName = baseThreadName

        const thread = await message.startThread({
          name: threadName.slice(0, 80),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'Start Claude session',
        })

        // Add user to thread so it appears in their sidebar
        await thread.members.add(message.author.id)

        discordLogger.log(`Created thread "${thread.name}" (${thread.id})`)

        // Create runtime immediately so follow-up messages queue naturally
        // via the preprocess chain instead of being rejected with "please wait".
        const sessionDirectory = projectDirectory

        const channelRuntime = getOrCreateRuntime({
          threadId: thread.id,
          thread,
          projectDirectory,
          sdkDirectory: sessionDirectory,
          channelId: channel.id,
          appId: currentAppId,
        })
        await channelRuntime.enqueueIncoming({
          prompt: '',
          userId: message.author.id,
          username:
            message.member?.displayName || message.author.displayName,
          sourceMessageId: message.id,
          sourceThreadId: thread.id,
          sourceChannelId: message.channelId,
          appId: currentAppId,
          preprocess: async () => {
            return preprocessNewThreadMessage({ message, thread })
          },
        })
      } else {
        // discordLogger.log(`Channel type ${channel.type} is not supported`)
      }
    } catch (error) {
      voiceLogger.error('Discord handler error:', error)
      void notifyError(error, 'MessageCreate handler error')
      try {
        const errMsg = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 1900)
        await message.reply({
          content: `Error: ${errMsg}`,
          flags: NOTIFY_MESSAGE_FLAGS,
        })
      } catch (sendError) {
        voiceLogger.error(
          'Discord handler error (fallback):',
          sendError instanceof Error ? sendError.message : String(sendError),
        )
      }
    }
    })
  })

  // Handle user message edits to update queued messages.
  // When a user edits a message that is still waiting in roadie's local queue,
  // the queue item is updated with the new content. If the edit removes the
  // queue suffix, the item is removed from the queue.
  discordClient.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    try {
      // Fetch full message if partial (cache miss). Needed for mentions
      // and content to be fully resolved.
      const message = newMessage.partial
        ? await newMessage.fetch().catch(() => null)
        : newMessage
      if (!message) return
      if (message.author.bot) return
      if (!message.content) return
      // Discord fires MESSAGE_UPDATE for embed-only updates (link preview
      // unfurling) without the user actually editing the message content.
      // editedTimestamp is null for these; skip them to avoid false queue removals.
      if (!message.editedTimestamp) return

      const channel = message.channel
      const isThread = [
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].includes(channel.type)
      if (!isThread) return

      const runtime = getRuntime(channel.id)
      if (!runtime) return

      // Same resolution as initial ingress, so the edited prompt matches.
      const { prompt, mode, queuedAction } = await resolveMessagePrompt({
        message,
        text: resolveContentMentions(message),
      })

      // If the edit removed the queue suffix, remove the item from the queue.
      // If the suffix is still present, update the prompt.
      const result = await runtime.updateQueuedMessage({
        sourceMessageId: message.id,
        newPrompt: mode === 'local-queue' ? prompt : '',
        queuedAction,
      })

      if (result.found && channel.isThread()) {
        const displayName =
          message.member?.displayName ?? message.author.displayName
        if (result.removed) {
          discordLogger.log(
            `[MESSAGE_EDIT] Removed queued message ${message.id} in thread ${channel.id}`,
          )
          await sendThreadMessage(
            channel,
            asSubtext(`**${displayName}** removed message from queue`),
          )
        } else {
          discordLogger.log(
            `[MESSAGE_EDIT] Updated queued message ${message.id} in thread ${channel.id}`,
          )
          await sendThreadMessage(
            channel,
            asSubtext(`**${displayName}** edited queued message`),
          )
        }
      }
    } catch (error) {
      discordLogger.error(
        'Error handling message update:',
        error instanceof Error ? error.stack : String(error),
      )
    }
  })

  // Handle user message deletes to remove queued messages.
  // Discord delete events do not include author/content, so attribution comes
  // from the queued item captured at enqueue time.
  discordClient.on(Events.MessageDelete, async (message) => {
    try {
      const channel = message.channel
      if (!channel.isThread()) return

      const runtime = getRuntime(channel.id)
      if (!runtime) return

      const removed = await runtime.removeQueuedMessage(message.id)
      if (!removed) return

      discordLogger.log(
        `[MESSAGE_DELETE] Removed queued message ${message.id} in thread ${channel.id}`,
      )
      await sendThreadMessage(
        channel,
        asSubtext(`**${removed.username}** removed message from queue`),
      )
    } catch (error) {
      discordLogger.error(
        'Error handling message delete:',
        error instanceof Error ? error.stack : String(error),
      )
    }
  })

  // Handle bot-initiated threads created by `roadie send` (without --notify-only)
  // Uses a YAML embed marker to pass options (start, cwd, agent, model)
  discordClient.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    try {
      if (!newlyCreated) {
        return
      }

      // Only handle threads in text channels
      const parent = thread.parent as TextChannel | null
      if (!parent || parent.type !== ChannelType.GuildText) {
        return
      }

      // Get the starter message to check for auto-start marker
      const starterMessage = await thread
        .fetchStarterMessage()
        .catch((error) => {
          discordLogger.warn(
            `[THREAD_CREATE] Failed to fetch starter message for thread ${thread.id}:`,
            error instanceof Error ? error.stack : String(error),
          )
          return null
        })
      if (!starterMessage) {
        discordLogger.log(
          `[THREAD_CREATE] Could not fetch starter message for thread ${thread.id}`,
        )
        return
      }

      // Parse JSON marker from embed footer
      const embedFooter = starterMessage.embeds[0]?.footer?.text
      if (!embedFooter) {
        return
      }

      // Only process markers from our own bot messages to prevent crafted embeds
      if (starterMessage.author?.id !== discordClient.user?.id) {
        return
      }

      const marker = parseEmbedFooterMarker<ThreadStartMarker>({
        footer: embedFooter,
      })
      if (!marker) {
        return
      }

      if (!marker.start) {
        return // Not an auto-start thread
      }

      discordLogger.log(
        `[BOT_SESSION] Detected bot-initiated thread: ${thread.name}`,
      )

      const resolvedPrompt = await resolveMessagePrompt({
        message: starterMessage,
        text: resolveContentMentions(starterMessage).trim(),
      })
      const { prompt } = resolvedPrompt
      if (!prompt) {
        discordLogger.log(`[BOT_SESSION] No prompt found in starter message`)
        return
      }

      // Get directory from database
      const channelConfig = await getChannelDirectory(parent.id)

      if (!channelConfig) {
        discordLogger.log(
          `[BOT_SESSION] No project directory configured for parent channel`,
        )
        return
      }

      const projectDirectory = channelConfig.directory

      if (!fs.existsSync(projectDirectory)) {
        discordLogger.error(
          `[BOT_SESSION] Directory does not exist: ${projectDirectory}`,
        )
        await thread.send({
          content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
          flags: NOTIFY_MESSAGE_FLAGS,
        })
        return
      }

      // Worktree creation is left to host tooling. A marker from
      // an older `send --worktree` client gets a clear notice; the session
      // runs in the project directory instead.
      if (marker.worktree) {
        await thread.send({
          content: `Roadie no longer creates worktrees (requested: \`${String(marker.worktree).slice(0, 100)}\`). Create the checkout with your host tooling and use \`roadie send --cwd <path>\`. Continuing in the project directory.`,
          flags: NOTIFY_MESSAGE_FLAGS,
        })
      }

      // --cwd binds the thread to an existing project subfolder or worktree.
      // Revalidated here because the path could have gone stale since send
      // time. The binding is stored so restarts and forks keep it; the
      // project root itself is the default and needs no binding.
      let cwdDirectory: string | undefined
      if (marker.cwd) {
        const cwdResult = await resolveSessionWorkingDirectory({
          projectDirectory,
          candidatePath: marker.cwd,
        })
        if (cwdResult instanceof Error) {
          discordLogger.error(`[BOT_SESSION] --cwd validation failed: ${cwdResult.message}`)
          await thread.send({
            content: `✗ --cwd validation failed: ${cwdResult.message.slice(0, 1900)}`,
            flags: NOTIFY_MESSAGE_FLAGS,
          })
          return
        }

        if (path.resolve(cwdResult.directory) !== path.resolve(projectDirectory)) {
          cwdDirectory = cwdResult.directory
        }

        if (cwdDirectory) {
          const isWorktree = cwdResult.kind === 'worktree'
          // Label a worktree with its checked-out branch, anything else with its folder name.
          const branchResult = isWorktree ? await git(cwdDirectory, 'symbolic-ref --short HEAD') : undefined
          await setThreadWorkingDirectory({
            threadId: thread.id,
            projectDirectory,
            workingDirectory: cwdDirectory,
            label: typeof branchResult === 'string' ? branchResult : path.basename(cwdDirectory),
            kind: isWorktree ? 'git-worktree' : 'directory',
          })
          if (isWorktree) {
            await reactToThread({
              rest: discordClient.rest,
              threadId: thread.id,
              channelId: parent.id,
              emoji: '🌳',
            })
          }
        }
      }

      discordLogger.log(
        `[BOT_SESSION] Starting session for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}..."`,
      )

      const botThreadStartSource = parseSessionStartSourceFromMarker(marker)

      const sessionDirectory = cwdDirectory ?? projectDirectory

      const runtime = getOrCreateRuntime({
        threadId: thread.id,
        thread,
        projectDirectory,
        sdkDirectory: sessionDirectory,
        channelId: parent.id,
        appId: currentAppId,
      })
      await runtime.enqueueIncoming({
        prompt: '',
        userId: marker.userId || '',
        actorVia: 'cli',
        username: marker.username || 'bot',
        appId: currentAppId,
        agent: marker.agent,
        model: marker.model,
        permissions: marker.permissions,
        injectionGuardPatterns: marker.injectionGuardPatterns,
        parentSessionId: marker.parentSessionId,
        mode: resolvedPrompt.mode,
        sessionStartSource: botThreadStartSource
          ? {
              scheduleKind: botThreadStartSource.scheduleKind,
              scheduledTaskId: botThreadStartSource.scheduledTaskId,
              scheduledTaskRunId: botThreadStartSource.scheduledTaskRunId,
            }
          : undefined,
        preprocess: async () => {
          return resolvedPrompt
        },
      })
    } catch (error) {
      voiceLogger.error(
        '[BOT_SESSION] Error handling bot-initiated thread:',
        error,
      )
      void notifyError(error, 'ThreadCreate handler error')
      try {
        const errMsg = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 1900)
        await thread.send({
          content: `Error: ${errMsg}`,
          flags: NOTIFY_MESSAGE_FLAGS,
        })
      } catch (sendError) {
        voiceLogger.error(
          '[BOT_SESSION] Failed to send error message:',
          sendError instanceof Error ? sendError.message : String(sendError),
        )
      }
    }
  })

  // Dispose runtime when a thread is deleted so memory is freed immediately
  // instead of waiting for the idle sweeper (1 hour default).
  discordClient.on(Events.ThreadDelete, (thread) => {
    void cleanupDeletedDiscordThread(thread.id).catch((error) => {
      notifyError(
        error instanceof Error ? error : new Error(String(error)),
        `Failed to clean up deleted thread ${thread.id}`,
      )
    })
  })

  // Clean up SQLite and active child runtimes without relying on Discord to
  // send separate ThreadDelete events for every child.
  discordClient.on(Events.ChannelDelete, async (channel) => {
    try {
      await cleanupDeletedDiscordChannel(channel.id)
    } catch (error) {
      notifyError(
        error instanceof Error ? error : new Error(String(error)),
        `Failed to clean up channel_directories for deleted channel ${channel.id}`,
      )
    }
  })

  // Skip login if the caller already connected the client (e.g. cli.ts logs in
  // before calling startDiscordBot). Calling login() again destroys the existing
  // WebSocket (close code 1000) and triggers a spurious ShardReconnecting event.
  if (!discordClient.isReady()) {
    await discordClient.login(token)
  }
  await setupPromise
  // A stop signal during setup: do not start workers against closing resources.
  if (global.shuttingDown) {
    return
  }

  startHeapMonitor()
  startStdinCpuProfListener()
  const stopTaskRunner = startTaskRunner({ token })
  const stopRuntimeIdleSweeper = startRuntimeIdleSweeper()
  stopBackgroundWorkers = async () => {
    await stopRuntimeIdleSweeper()
    await stopTaskRunner()
  }

  // Prevent discord.js from permanently killing the REST token on 401.
  // @discordjs/rest calls setToken(null) whenever it receives a 401 response.
  // The gateway proxy now returns 503 for stale-DB rejections (not 401), but
  // this guard stays as defense-in-depth for any other transient 401 source.
  // Allows null through when Client.destroy() is running (it sets client.token
  // = null before calling rest.setToken(null)).
  const originalSetToken = discordClient.rest.setToken.bind(discordClient.rest)
  discordClient.rest.setToken = (newToken) => {
    if (!newToken && discordClient.token !== null) {
      discordLogger.warn('[REST] Blocked token nullification from 401 response')
      return discordClient.rest
    }
    return originalSetToken(newToken)
  }

  process.on('uncaughtException', (error) => {
    // During self-restart or shutdown, discord.js can still fire errors from
    // pending async operations (DNS lookups, WebSocket frames) after the client
    // is destroyed. These are expected and must not interfere with the restart
    // flow — let the existing selfRestart/handleShutdown finish cleanly.
    if (selfRestarting || global.shuttingDown) {
      discordLogger.log(
        'Ignoring uncaught exception during shutdown:',
        error?.message || String(error),
      )
      return
    }
    discordLogger.error('Uncaught exception:', formatErrorWithStack(error))
    notifyError(error, 'Uncaught exception in bot process')
    void shutdownBot('uncaughtException', { skipExit: true })
    setTimeout(() => {
      process.exit(1)
    }, 250).unref()
  })

  process.on('unhandledRejection', (reason, promise) => {
    if (global.shuttingDown) {
      discordLogger.log('Ignoring unhandled rejection during shutdown:', reason)
      return
    }
    discordLogger.error(
      'Unhandled rejection:',
      formatErrorWithStack(reason),
      'at promise:',
      promise,
    )
    const error =
      reason instanceof Error
        ? reason
        : new Error(formatErrorWithStack(reason))
    void notifyError(error, 'Unhandled rejection in bot process')
  })
}

// ── Process lifecycle ────────────────────────────────────────────────
// cli-runner installs these handlers right after binding the hrana lock port,
// long before Discord is ready. Before this, SIGINT/SIGTERM during startup only
// hit the opencode.ts fallback listener, which does not exit, so the process
// kept the lock port forever and every next start failed with EADDRINUSE.
// Every cleanup step below must therefore be safe at any startup phase.

const SHUTDOWN_DEADLINE_MS = 15_000
let activeDiscordClient: Client | null = null
let stopBackgroundWorkers: (() => Promise<void>) | null = null
let selfRestarting = false
let lifecycleHandlersRegistered = false

async function shutdownBot(reason: string, { skipExit = false } = {}) {
  discordLogger.log(`Received ${reason}, cleaning up...`)

  if (global.shuttingDown) {
    discordLogger.log('Already shutting down, ignoring duplicate signal')
    return
  }
  global.shuttingDown = true

  // Cleanup or process.exit() can hang (native worker threads after gateway
  // failures). Never let a stuck shutdown hold the lock port. Kept ref'd so a
  // drained event loop cannot exit with code 0 and skip the wrapper restart.
  setTimeout(() => {
    process.kill(process.pid, 'SIGKILL')
  }, SHUTDOWN_DEADLINE_MS)

  try {
    stopStdinCpuProfListener()
    const flushed = await flushCpuProfiling()
    if (flushed instanceof Error) {
      discordLogger.warn(
        'Failed to flush CPU profile on shutdown:',
        flushed.message,
      )
    }
    await stopBackgroundWorkers?.()

    await flushDebouncedProcessCallbacks().catch((error) => {
      discordLogger.warn(
        'Failed to flush debounced process callbacks:',
        error instanceof Error ? error.stack : String(error),
      )
    })

    // Cancel pending IPC requests so plugin tools don't hang
    await cancelAllPendingIpcRequests().catch((e) => {
      discordLogger.warn(
        'Failed to cancel pending IPC requests:',
        (e as Error).message,
      )
    })

    // Before the agent server stops, so busy runs are still visible.
    try {
      recordInterruptedSessions(snapshotBusyRuntimes())
    } catch (error) {
      discordLogger.warn(
        'Failed to record interrupted sessions:',
        error instanceof Error ? error.message : String(error),
      )
    }

    voiceLogger.log('[SHUTDOWN] Stopping OpenCode server')
    stopExternalOpencodeSessionSync()
    await stopOpencodeServer()

    discordLogger.log('Closing database...')
    await closeDatabase()

    discordLogger.log('Stopping hrana server...')
    await stopHranaServer()

    if (activeDiscordClient) {
      discordLogger.log('Destroying Discord client...')
      // Remove all listeners before destroy to prevent late-arriving shard
      // errors (from pending DNS lookups, WebSocket frames) from becoming
      // uncaught exceptions after the client's internal handlers are torn down.
      activeDiscordClient.removeAllListeners()
      void activeDiscordClient.destroy()
    }

    discordLogger.log('Cleanup complete.')
    if (!skipExit) {
      process.exit(0)
    }
  } catch (error) {
    voiceLogger.error('[SHUTDOWN] Error during cleanup:', error)
    if (!skipExit) {
      process.exit(1)
    }
  }
}

// Self-restart: die so the bin.ts wrapper restarts us with exponential
// backoff and crash-loop detection. process.exit() can hang joining native
// worker threads after Discord gateway failures, so SIGKILL instead.
// When running without the wrapper (e.g. `tsx src/cli.ts`), the process
// just dies — use `tsx src/bin.ts` for auto-restart support.
async function selfRestart(reason: string) {
  if (selfRestarting) {
    discordLogger.log(`Self-restart already in progress, ignoring duplicate reason: ${reason}`)
    return
  }
  selfRestarting = true
  discordLogger.log(`Self-restarting (reason: ${reason})...`)
  await shutdownBot(reason, { skipExit: true })

  if (!process.env.__ROADIE_CHILD) {
    discordLogger.warn(
      'No restart wrapper detected. Run via `tsx src/bin.ts` (dev) or `roadie` (npm) for auto-restart on crash.',
    )
  }
  process.kill(process.pid, 'SIGKILL')
}

/** Idempotent. Call as soon as the process owns the lock port. */
export function registerBotLifecycleHandlers() {
  if (lifecycleHandlersRegistered) {
    return
  }
  lifecycleHandlersRegistered = true

  // SIGHUP: closing the terminal must stop the bot, not leave it orphaned.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      void shutdownBot(signal)
    })
  }

  process.on('SIGUSR1', () => {
    discordLogger.log('Received SIGUSR1, writing heap snapshot...')
    writeHeapSnapshot().catch((e) => {
      discordLogger.error(
        'Failed to write heap snapshot:',
        e instanceof Error ? e.message : String(e),
      )
    })
  })

  process.on('SIGUSR2', () => {
    discordLogger.log('Received SIGUSR2, restarting after cleanup...')
    void selfRestart('SIGUSR2')
  })

  // bin.ts spawns us with an IPC channel. The OS closes it when the wrapper
  // dies for any reason (including SIGKILL), so an orphaned child exits instead
  // of holding the lock port. Guarded by __ROADIE_CHILD so vitest workers,
  // which also have an IPC channel, are not affected.
  if (!process.env.__ROADIE_CHILD) {
    return
  }
  // The wrapper can die before we get here (e.g. during the eviction wait);
  // 'disconnect' is not replayed for late listeners.
  if (!process.connected) {
    void shutdownBot('wrapper-disconnect')
    return
  }
  process.on('disconnect', () => {
    void shutdownBot('wrapper-disconnect')
  })
  process.channel?.unref()
}
