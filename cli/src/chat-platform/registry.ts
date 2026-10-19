// Chat platform registry (#297).
//
// A chat platform is anything that can deliver conversations to the session
// runtime: Discord, Slack, or a host-supplied surface registered by a plugin
// (`roadie.registerChatPlatform(...)` in `register(roadie)`). The core keeps
// no platform switch: `roadie` resolves `--platform` / ROADIE_PLATFORM ids
// against this registry and starts every requested platform in one process.
//
// A platform owns its ingress (how a new message, interaction answer, or
// abort arrives) and its `ChatThread` implementation. Everything after
// ingress is platform-neutral and shared: conversation intake, the thread
// session runtime and its queue, the scheduler, credential pools, identity
// (`person` filter with `actor.platform`) and `roadie send`. Platforms that
// share state with others must namespace their thread ids (e.g.
// `slack:<workspace>:<channel>:<ts>`) so shared tables never collide.

import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.CLI)

/** What a running platform hands back so the process can stop it. */
export type ChatPlatformHandle = {
  stop(): Promise<void>
}

export type ChatPlatformStartContext = {
  /** Every platform id starting in this process, in start order. */
  platformIds: string[]
  /** Startup options from the `roadie` command that platforms may honor. */
  options: {
    restartOnboarding?: boolean
    addChannels?: boolean
    dataDir?: string
  }
}

export type ChatPlatformDefinition = {
  /**
   * Stable platform id (lowercase letters, digits, dashes). Used for
   * `--platform`, `actor.platform`, thread id namespacing and /health.
   */
  id: string
  /**
   * Connect the platform's ingress and return a stop handle. Shared services
   * (lock port, database, agent backend, hooks) are already up. A returned
   * Error is logged and recorded (see getFailedChatPlatforms); the remaining
   * platforms keep starting unless this platform is `required`.
   */
  start(context: ChatPlatformStartContext): Promise<Error | ChatPlatformHandle>
  /**
   * When true, a start failure keeps the all-or-nothing behavior: platforms
   * started earlier are stopped again and startup fails.
   */
  required?: boolean
}

const CHAT_PLATFORM_ID = /^[a-z][a-z0-9-]*$/

const platforms = new Map<string, ChatPlatformDefinition & { source?: string }>()

/** Platforms started by `startChatPlatforms` and not yet stopped. */
const activeHandles = new Map<string, ChatPlatformHandle>()

/** Platforms whose last start() failed, by id, with the error message. */
const failedPlatforms = new Map<string, string>()

/** Failed platform starts for /health and diagnostics. */
export function getFailedChatPlatforms(): { id: string; error: string }[] {
  return [...failedPlatforms].map(([id, error]) => ({ id, error }))
}

/**
 * Register a chat platform. Built-in adapters (Discord, Slack) and plugins
 * use the same call. Returns an Error for an invalid or duplicate id so a
 * misconfigured plugin fails loudly instead of silently shadowing a platform.
 */
export function registerChatPlatform(
  definition: ChatPlatformDefinition,
  { source }: { source?: string } = {},
): Error | void {
  if (!definition || typeof definition.id !== 'string' || !CHAT_PLATFORM_ID.test(definition.id)) {
    return new Error(
      `Invalid chat platform id ${JSON.stringify(definition?.id)}: use lowercase letters, digits and dashes, starting with a letter`,
    )
  }
  if (typeof definition.start !== 'function') {
    return new Error(`Chat platform "${definition.id}" must provide a start(context) function`)
  }
  const existing = platforms.get(definition.id)
  if (existing) {
    return new Error(
      `Chat platform "${definition.id}" is already registered${existing.source ? ` (by ${existing.source})` : ''}`,
    )
  }
  platforms.set(definition.id, { ...definition, ...(source && { source }) })
}

export function getChatPlatform(id: string): ChatPlatformDefinition | undefined {
  return platforms.get(id)
}

export function listChatPlatformIds(): string[] {
  return [...platforms.keys()]
}

/** Remove one registration (tests, plugin teardown). */
export function unregisterChatPlatform(id: string): boolean {
  return platforms.delete(id)
}

/** Drop every registration and active handle. Tests only. */
export function resetChatPlatforms(): void {
  platforms.clear()
  activeHandles.clear()
  failedPlatforms.clear()
}

/**
 * Parse `--platform` values / ROADIE_PLATFORM into platform ids. Accepts a
 * single id, repeated flags, and comma-separated lists; duplicates are
 * dropped, order is preserved. No value means Discord, the historic default.
 */
export function parseChatPlatformIds(raw: string | string[] | undefined): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  const ids = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  return ids.length ? [...new Set(ids)] : ['discord']
}

/**
 * Start every requested platform in order. All ids are validated first so an
 * unknown platform never partially starts the bot. A platform whose start()
 * fails is logged and recorded (getFailedChatPlatforms) while the remaining
 * platforms keep starting, so one bad platform never takes the others down.
 * An Error is returned only when every requested platform failed, or when a
 * platform marked `required` fails — then the platforms already running are
 * stopped again (newest first), keeping the historic all-or-nothing behavior.
 */
export async function startChatPlatforms(
  context: ChatPlatformStartContext,
): Promise<Error | ChatPlatformHandle> {
  const unknown = context.platformIds.filter((id) => !platforms.has(id))
  if (unknown.length) {
    const registered = listChatPlatformIds()
    return new Error(
      `Unknown chat platform${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Registered platforms: ${registered.length ? registered.join(', ') : '(none)'}. ` +
        'Plugins add platforms with registerChatPlatform() in register(roadie).',
    )
  }
  for (const id of context.platformIds) failedPlatforms.delete(id)
  const startedIds: string[] = []
  const failedIds: string[] = []
  for (const id of context.platformIds) {
    const definition = platforms.get(id)!
    const handle = await definition
      .start(context)
      .catch((error) => (error instanceof Error ? error : new Error(String(error))))
    if (handle instanceof Error) {
      failedPlatforms.set(id, handle.message)
      failedIds.push(id)
      logger.error(`[PLATFORM] ${id} failed to start:`, handle)
      if (definition.required) {
        await stopActiveChatPlatforms()
        return new Error(`Chat platform ${id} failed to start: ${handle.message}`, {
          cause: handle,
        })
      }
      continue
    }
    activeHandles.set(id, handle)
    startedIds.push(id)
    logger.log(`[PLATFORM] ${id} started`)
  }
  if (!startedIds.length && failedIds.length) {
    const details = failedIds.map((id) => `${id} (${failedPlatforms.get(id)})`).join('; ')
    return new Error(`Every requested chat platform failed to start: ${details}`)
  }
  return {
    stop: async () => {
      for (const id of [...startedIds].reverse()) await stopActiveChatPlatform(id)
    },
  }
}

async function stopActiveChatPlatform(id: string): Promise<void> {
  const handle = activeHandles.get(id)
  if (!handle) return
  activeHandles.delete(id)
  try {
    await handle.stop()
  } catch (error) {
    logger.error(`[PLATFORM] ${id} failed to stop:`, error)
  }
}

/**
 * Stop every platform started in this process, newest first. Shared by the
 * generic shutdown path and Discord's lifecycle handler, and used to roll
 * back a partial multi-platform startup. Idempotent.
 */
export async function stopActiveChatPlatforms(): Promise<void> {
  for (const id of [...activeHandles.keys()].reverse()) await stopActiveChatPlatform(id)
}
