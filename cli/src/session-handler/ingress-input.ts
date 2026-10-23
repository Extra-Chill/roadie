// Ingress input shape for ThreadSessionRuntime.enqueueIncoming and the
// per-turn rewrites applied to it (person, channel policy, leading command).

import { getCachedPerson, isIdentityConfigured } from '../identity.js'
import { personMcpPermissions } from '../person-mcp.js'
import { channelPolicyOverrides } from '../channel-policy.js'
import { personKeyFrom } from '../credentials/person-pool.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import type { RepliedMessageContext } from '../system-message.js'
import { extractLeadingCommand } from '../leading-command-detection.js'

export type EnqueueResult = {
  /** True if the message is waiting in queue behind an active run. */
  queued: boolean
  /** Queue position (1-based). Only set when queued is true. */
  position?: number
  /** Stable queue entry id. Set when the item was placed in the local queue. */
  queueId?: string
}

/**
 * Result of the preprocess callback. Returns the resolved prompt, images,
 * and mode after expensive async work (context fetch,
 * attachment download) completes.
 */
export type PreprocessResult = {
  prompt: string
  images?: DiscordFileAttachment[]
  repliedMessage?: RepliedMessageContext
  /** Resolved ingress mode (queue suffix or forced queue). */
  mode: 'direct' | 'local-queue'
  /** When true, preprocessing determined the message should be silently dropped. */
  skip?: boolean
  /** Agent requested during preprocessing. Applied to the session if set. */
  agent?: string
}

/**
 * Apply the person filter's per-person overrides to a chat turn. Only
 * platform-authenticated speakers ('chat') get a person: a CLI-asserted actor
 * is never treated as that person. Explicit agent/model on the input win;
 * person permission rules are added to any explicit ones.
 */
export function applyPersonToIngress(input: IngressInput): IngressInput {
  if (!isIdentityConfigured()) return input
  if (!input.userId || (input.actorVia ?? 'chat') !== 'chat') return input
  const person = getCachedPerson({ platform: input.actorPlatform ?? 'discord', id: input.userId })
  if (!person?.allowed) return input
  // Every person turn resets the session's person-scoped MCP access to the
  // speaker's own servers (none when they have no config).
  const mcpPermissions = personMcpPermissions({
    personKey: personKeyFrom({
      personId: person.personId,
      platform: input.actorPlatform ?? 'discord',
      actorId: input.userId,
    }) ?? undefined,
    hasServers: (person.mcpServers?.length ?? 0) > 0,
  })
  return {
    ...input,
    ...(person.personId ? { personId: person.personId } : {}),
    ...(person.credentialPool ? { credentialPool: person.credentialPool } : {}),
    ...(input.agent || !person.agent ? {} : { agent: person.agent }),
    ...(input.model || !person.model ? {} : { model: person.model }),
    // The MCP pair goes before the person's own rules, which may refine it.
    permissions: [...(input.permissions ?? []), ...mcpPermissions, ...person.permissions],
  }
}

/**
 * Add the channel policy's session permission rules to a turn. Agent, model,
 * directory and verbosity come from the channel getters, which already read
 * the policy.
 */
export function applyChannelPolicyToIngress({
  input,
  channelId,
}: {
  input: IngressInput
  channelId: string
}): IngressInput {
  const { permissions } = channelPolicyOverrides(channelId)
  if (!permissions || permissions.length === 0) return input
  return { ...input, permissions: [...(input.permissions ?? []), ...permissions] }
}

export type IngressInput = {
  /** Raw task text when a fork adds synthetic lineage instructions. */
  titlePrompt?: string
  actorPlatform?: string
  prompt: string
  userId: string
  username: string
  // How userId was established: 'chat' (platform-authenticated author,
  // default) or 'cli' (asserted by a local `roadie send --user` caller).
  actorVia?: 'chat' | 'cli'
  // Opaque host person id resolved by the person filter for this turn.
  personId?: string
  // Credential pool override from the person filter (`credentialPool`),
  // applied to the speaker's billing pool when credential pools are enabled.
  credentialPool?: string
  // Discord message ID and thread ID for the source message, embedded in
  // <discord-user> synthetic context so the model knows which message it answers.
  sourceMessageId?: string
  sourceThreadId?: string
  // Channel that holds the source message. Differs from the thread for the
  // thread starter message, which lives in the parent channel.
  sourceChannelId?: string
  repliedMessage?: RepliedMessageContext
  images?: DiscordFileAttachment[]
  appId?: string
  command?: { name: string; arguments: string }
  /**
   * `direct` (default): send straight to the backend, which serializes
   * pending user turns itself.
   * `local-queue`: keep in roadie's local queue (used by slash commands).
   */
  mode?: 'direct' | 'local-queue'
  // Force a new assistant-part routing window by resetting run-state to
  // running before enqueue. Used by model-switch retry flows where old
  // assistant IDs can linger briefly after abort.
  resetAssistantForNewRun?: boolean
  // First-dispatch-only overrides (used when creating a new session)
  agent?: string
  model?: string
  /**
   * Thinking-level variant from `/xxx-agent variant:`. Applied after
   * agent/model snapshot so it wins over cascade for this turn.
   */
  variant?: string
  /**
   * Raw permission rule strings from --permission flag ("tool:action" or
   * "tool:pattern:action"). Parsed into PermissionRuleset entries by
   * parsePermissionRules() and appended after buildSessionPermissions()
   * so they win via last-match-wins evaluation. Only used on
   * session creation (first dispatch).
   */
  permissions?: string[]
  injectionGuardPatterns?: string[]
  /**
   * Parent session ID from explicit `roadie send --parent-session` only.
   * Stored once on first ingress and injected into the child system message.
   * Never set for /fork or task/subagent children (keeps system prompt cache).
   */
  parentSessionId?: string
  sessionStartSource?: { scheduleKind: 'at' | 'cron'; scheduledTaskId?: number; scheduledTaskRunId?: number }
  /** Optional guard for retries: skip enqueue when session has changed. */
  expectedSessionId?: string
  /**
   * When true, the message is added to the session context without triggering
   * the AI agent loop. Used for messages that should be visible to the model
   * on the next real turn but should not cause a response on their own
   * (e.g. user-to-user replies in a thread).
   */
  noReply?: boolean
  /** Intake data only: preserve execution identity and preferences as well as suppressing replies. */
  contextOnly?: boolean
  /**
   * True only for the wake prompt posted by the roadie_sleep task runner.
   * Every other ingress cancels a pending sleep; this one must not, because it
   * is delivering that sleep rather than superseding it.
   */
  isSleepWake?: boolean
  /** Synthetic recovery turn, never a new fork task. Preserved on retries. */
  isRestartContinuation?: boolean
  /**
   * Lazy preprocessing callback. When set, the runtime serializes it via a
   * lightweight promise chain (preprocessChain) to resolve prompt/images/mode
   * from the raw Discord message. This replaces the threadIngressQueue in
   * discord-bot.ts: expensive async work (context fetch,
   * attachment download) runs in arrival order but outside dispatchAction,
   * so SSE event handling and permission UI are not blocked.
   *
   * The closure captures Discord objects (Message, ThreadChannel) so the
   * runtime stays platform-agnostic — it just awaits the callback.
   */
  preprocess?: () => Promise<PreprocessResult>
  /**
   * Posts the "Queued message" ack and returns its Discord message ID. Runs
   * inside the serialized enqueue, before any drain can start, so the drain
   * indicator can always reply to it. Only called when the item really waits.
   */
  onLocalQueued?: (queued: { queueId: string; position: number }) => Promise<string>
}

// Rewrite `{ prompt: "/build foo" }` → `{ prompt: "", command: { name, arguments }, mode: "local-queue" }`
// when the prompt's leading token matches a registered session command.
// Skip if a command is already set or there's no prompt to inspect.
export function maybeConvertLeadingCommand(input: IngressInput): IngressInput {
  if (input.command) return input
  if (!input.prompt) return input
  const extracted = extractLeadingCommand(input.prompt)
  if (!extracted) return input
  return {
    ...input,
    prompt: '',
    command: extracted.command,
    mode: 'local-queue',
  }
}
