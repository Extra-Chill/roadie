// Roadie hooks: filters and actions, modeled on WordPress.
//
//   addFilter(name, fn, { priority })   fn(value, context) returns the new value
//   addAction(name, fn, { priority })   fn(context) is notified, returns nothing
//
// Lower priority runs first; equal priorities run in registration order.
// A callback that throws is logged and skipped: a filter's value passes through
// unchanged and the remaining callbacks still run. Plugins never take the bot
// down.
//
// Known hook names and their value/context types are declared in `RoadieFilters`
// and `RoadieActions`. Plugins may add their own hooks through declaration
// merging; any string name works at runtime.

import { createLogger, LogPrefix } from './logger.js'
import type { AgentBackendProvider, AgentDefinition, AgentPermissionRule, AgentProviderCatalog } from './agent-backend/types.js'
import type { AgentChildSessionStatus } from './agent-backend/events.js'
import type { PermissionRulesContext } from './permission-policy.js'
import type { ChannelPolicy } from './channel-policy.js'
import type { ContextRequest, ContextSection } from './context-provider.js'
import type { IdentityActor, IdentityContext, Person } from './identity.js'
import type { PromptSection } from './prompt-config.js'
import type { ForkWorkspaceProvider, ForkWorkspaceRequest, ForkWorkspaceBinding } from './fork-workspace.js'
import type { IntakeDecision, ConversationIntakeRequest, ConversationAdmission } from './conversation-intake.js'
import type { HostUpgradeHandler } from './service-lifecycle.js'
import type { Config } from '@opencode-ai/sdk/v2'

const logger = createLogger(LogPrefix.CLI)

export const DEFAULT_PRIORITY = 10

/** Filter name -> [value, context]. */
export interface RoadieFilters {
  /** Host runtime configuration shared across all backend workspace instances. */
  opencode_server_config: [Config | Error, Record<string, never>]
  conversation_intake: [IntakeDecision, { request: ConversationIntakeRequest; admission: ConversationAdmission | null; policy: ChannelPolicy | null | undefined }]
  /** The agent backend provider. Resolved once at startup. */
  agent_backend: [AgentBackendProvider, Record<string, never>]
  /** The person behind a chat actor; null means no identity layer. */
  person: [Person | null, { actor: IdentityActor; context: IdentityContext }]
  /** Effective channel policy: undefined = built-in behavior, null = do not answer. */
  channel_policy: [ChannelPolicy | null | undefined, { channelId: string }]
  /** System prompt sections, in order, before host prompt config applies. */
  system_prompt_sections: [PromptSection[], { sessionId?: string }]
  /** Host context (memory) for a session start or a turn. */
  context_sections: [ContextSection[], ContextRequest]
  /** Providers and models offered to users (e.g. hide or rename models). */
  agent_providers: [AgentProviderCatalog, { directory?: string }]
  /** Agents offered to users and validated against. */
  agent_definitions: [AgentDefinition[], { directory?: string }]
  /** Permission rules for a session; the last matching rule wins. */
  permission_rules: [AgentPermissionRule[], PermissionRulesContext]
  /** How a managed install (ROADIE_MANAGED) upgrades; null = the host has no upgrade path. */
  host_upgrade: [HostUpgradeHandler | null, Record<string, never>]
  /** Host provider for independent fork workspaces; null = fork stays in the source directory. */
  fork_workspace: [ForkWorkspaceProvider | Error | null, ForkWorkspaceRequest]
}

/** Action name -> context. */
export interface RoadieActions {
  /** Provisioned workspace whose conversation setup failed; host owns cleanup. */
  fork_workspace_abandoned: { request: ForkWorkspaceRequest; binding: ForkWorkspaceBinding }
  /** A session finished its run. `parentSessionId` is set when the session is a delegation child or was started with `--parent-session`. */
  session_idle: { sessionId: string; threadId: string; parentSessionId?: string }
  /** A session's run failed. `parentSessionId` follows the same lineage rule as `session_idle`. */
  session_error: { sessionId?: string; threadId: string; message: string; parentSessionId?: string }
  /** A session spawned a delegated child session (subagent). */
  child_session_started: {
    parentSessionId: string
    childSessionId: string
    agent?: string
    description?: string
    status?: AgentChildSessionStatus
    threadId: string
  }
  /** A delegated child session finished (or its delegation errored). */
  child_session_finished: {
    parentSessionId: string
    childSessionId: string
    agent?: string
    description?: string
    status?: AgentChildSessionStatus
    threadId: string
  }
  /** Startup finished: plugins are loaded and the backend is resolved. */
  ready: Record<string, never>
}

type FilterName = keyof RoadieFilters | (string & {})
type ActionName = keyof RoadieActions | (string & {})
type FilterValue<N> = N extends keyof RoadieFilters ? RoadieFilters[N][0] : unknown
type FilterContext<N> = N extends keyof RoadieFilters ? RoadieFilters[N][1] : unknown
type ActionContext<N> = N extends keyof RoadieActions ? RoadieActions[N] : unknown

export type FilterCallback<N extends FilterName> = (
  value: FilterValue<N>,
  context: FilterContext<N>,
) => FilterValue<N> | Promise<FilterValue<N>>
export type ActionCallback<N extends ActionName> = (context: ActionContext<N>) => void | Promise<void>

type Entry = { fn: (...args: any[]) => unknown; priority: number; order: number; source?: string }

const filters = new Map<string, Entry[]>()
const actions = new Map<string, Entry[]>()
let nextOrder = 0

function add(registry: Map<string, Entry[]>, name: string, fn: Entry['fn'], priority: number, source?: string) {
  const list = registry.get(name) ?? []
  list.push({ fn, priority, order: nextOrder++, ...(source && { source }) })
  list.sort((a, b) => a.priority - b.priority || a.order - b.order)
  registry.set(name, list)
  return () => remove(registry, name, fn)
}

function remove(registry: Map<string, Entry[]>, name: string, fn: Entry['fn']): boolean {
  const list = registry.get(name)
  if (!list) return false
  const index = list.findIndex((entry) => entry.fn === fn)
  if (index === -1) return false
  list.splice(index, 1)
  if (list.length === 0) registry.delete(name)
  return true
}

function describe(entry: Entry): string {
  return entry.source ? ` (from ${entry.source})` : ''
}

/** Register a filter. Returns a function that removes it. */
export function addFilter<N extends FilterName>(
  name: N,
  fn: FilterCallback<N>,
  { priority = DEFAULT_PRIORITY, source }: { priority?: number; source?: string } = {},
): () => boolean {
  return add(filters, name, fn, priority, source)
}

export function removeFilter<N extends FilterName>(name: N, fn: FilterCallback<N>): boolean {
  return remove(filters, name, fn)
}

export function hasFilter(name: FilterName): boolean {
  return (filters.get(name)?.length ?? 0) > 0
}

/**
 * Run a filter chain synchronously. For hooks read on hot synchronous paths
 * (channel policy, prompt sections); a callback returning a promise there is
 * a plugin bug, logged and skipped.
 */
export function applyFilters<N extends FilterName>(
  name: N,
  value: FilterValue<N>,
  context: FilterContext<N>,
): FilterValue<N> {
  let current = value
  for (const entry of [...(filters.get(name) ?? [])]) {
    try {
      const next = entry.fn(current, context)
      if (next instanceof Promise) {
        next.catch(() => undefined)
        logger.error(`[HOOKS] filter "${name}"${describe(entry)} returned a promise; synchronous filters must return a value. Skipped.`)
        continue
      }
      current = next as FilterValue<N>
    } catch (error) {
      logger.error(`[HOOKS] filter "${name}"${describe(entry)} threw; skipped:`, error)
    }
  }
  return current
}

/** Run a filter chain, awaiting each callback in order. */
export async function applyFiltersAsync<N extends FilterName>(
  name: N,
  value: FilterValue<N>,
  context: FilterContext<N>,
): Promise<FilterValue<N>> {
  let current = value
  for (const entry of [...(filters.get(name) ?? [])]) {
    try {
      current = (await entry.fn(current, context)) as FilterValue<N>
    } catch (error) {
      logger.error(`[HOOKS] filter "${name}"${describe(entry)} threw; skipped:`, error)
    }
  }
  return current
}

/** Register an action. Returns a function that removes it. */
export function addAction<N extends ActionName>(
  name: N,
  fn: ActionCallback<N>,
  { priority = DEFAULT_PRIORITY, source }: { priority?: number; source?: string } = {},
): () => boolean {
  return add(actions, name, fn, priority, source)
}

export function removeAction<N extends ActionName>(name: N, fn: ActionCallback<N>): boolean {
  return remove(actions, name, fn)
}

export function hasAction(name: ActionName): boolean {
  return (actions.get(name)?.length ?? 0) > 0
}

/** Notify every callback in order. Failures are logged; the rest still run. */
export async function doAction<N extends ActionName>(name: N, context: ActionContext<N>): Promise<void> {
  for (const entry of [...(actions.get(name) ?? [])]) {
    try {
      await entry.fn(context)
    } catch (error) {
      logger.error(`[HOOKS] action "${name}"${describe(entry)} threw; skipped:`, error)
    }
  }
}

/** Drop every hook. Tests only. */
export function resetHooks(): void {
  filters.clear()
  actions.clear()
}
