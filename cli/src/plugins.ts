// Roadie plugins: modules that extend Roadie through hooks (./hooks.ts).
//
// Configure with `--plugin <spec>` (repeatable) or ROADIE_PLUGINS (comma- or
// newline-separated). A spec is a file path (absolute, or relative to the
// working directory) or an installed package name. Plugins load in the order
// given, before the bot starts.
//
// A plugin module exports `register(roadie)` (named or default):
//
//   export function register(roadie) {
//     roadie.addFilter('context_sections', async (sections, request) => [...sections, ...])
//     roadie.addAction('session_idle', ({ sessionId }) => { ... })
//     roadie.registerChatPlatform({ id: 'host-chat', start: async () => ({ stop: async () => {} }) })
//   }

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  addAction,
  addFilter,
  applyFilters,
  applyFiltersAsync,
  doAction,
  hasAction,
  hasFilter,
  removeAction,
  removeFilter,
  DEFAULT_PRIORITY,
} from './hooks.js'
import { registerChatPlatform, type ChatPlatformDefinition } from './chat-platform/registry.js'
import { createLogger, LogPrefix } from './logger.js'
import { getRoadieEnv } from './config.js'

const logger = createLogger(LogPrefix.CLI)

export const PLUGIN_API_VERSION = 1

export type RoadiePluginApi = {
  apiVersion: number
  defaultPriority: number
  addFilter: typeof addFilter
  removeFilter: typeof removeFilter
  hasFilter: typeof hasFilter
  applyFilters: typeof applyFilters
  applyFiltersAsync: typeof applyFiltersAsync
  addAction: typeof addAction
  removeAction: typeof removeAction
  hasAction: typeof hasAction
  doAction: typeof doAction
  /**
   * Register a chat platform (#297): the same registry Discord and Slack go
   * through. Start it with `--platform <id>` / ROADIE_PLATFORM, alone or
   * alongside other platforms. Throws on an invalid or duplicate id so a
   * misconfigured plugin stops startup instead of silently losing a platform.
   */
  registerChatPlatform: (definition: ChatPlatformDefinition) => void
}

export type RoadiePlugin = { register: (roadie: RoadiePluginApi) => void | Promise<void> }

/** The API one plugin sees: its hooks are tagged with its spec for logs. */
function apiFor(spec: string): RoadiePluginApi {
  return {
    apiVersion: PLUGIN_API_VERSION,
    defaultPriority: DEFAULT_PRIORITY,
    addFilter: (name, fn, options) => addFilter(name, fn, { ...options, source: spec }),
    removeFilter,
    hasFilter,
    applyFilters,
    applyFiltersAsync,
    addAction: (name, fn, options) => addAction(name, fn, { ...options, source: spec }),
    removeAction,
    hasAction,
    doAction,
    registerChatPlatform: (definition) => {
      const result = registerChatPlatform(definition, { source: spec })
      if (result instanceof Error) throw result
    },
  }
}

/** Plugin specs from flags, then ROADIE_PLUGINS. Duplicates are dropped. */
export function resolvePluginSpecs(fromFlags: string[] = []): string[] {
  const fromEnv = (getRoadieEnv('ROADIE_PLUGINS') ?? '')
    .split(/[,\n]/)
    .map((spec) => spec.trim())
    .filter(Boolean)
  return [...new Set([...fromFlags.map((s) => s.trim()).filter(Boolean), ...fromEnv])]
}

function importTarget(spec: string, cwd: string): string {
  const isPath = spec.startsWith('.') || spec.startsWith('/') || path.isAbsolute(spec)
  return isPath ? pathToFileURL(path.resolve(cwd, spec)).href : spec
}

function findRegister(mod: unknown): RoadiePlugin['register'] | undefined {
  const candidate = mod as { register?: unknown; default?: unknown }
  if (typeof candidate.register === 'function') return candidate.register as RoadiePlugin['register']
  const fallback = candidate.default as { register?: unknown } | ((...args: unknown[]) => unknown) | undefined
  if (typeof fallback === 'function') return fallback as RoadiePlugin['register']
  if (fallback && typeof fallback.register === 'function') return fallback.register as RoadiePlugin['register']
  return undefined
}

// Import targets already registered in this process.
const registered = new Set<string>()

/**
 * Load and register plugins in order. A plugin that fails to load or register
 * is an Error: misconfigured extensions must not silently change behavior.
 * Each plugin registers once per process, however many callers load it.
 */
export async function loadPlugins(specs: string[], { cwd = process.cwd() }: { cwd?: string } = {}): Promise<Error | string[]> {
  const loaded: string[] = []
  for (const spec of specs) {
    const target = importTarget(spec, cwd)
    if (registered.has(target)) {
      loaded.push(spec)
      continue
    }
    let mod: unknown
    try {
      mod = await import(target)
    } catch (error) {
      return new Error(`Could not load plugin ${spec}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    const register = findRegister(mod)
    if (!register) {
      return new Error(`Plugin ${spec} does not export a register(roadie) function`)
    }
    try {
      await register(apiFor(spec))
    } catch (error) {
      return new Error(`Plugin ${spec} failed to register: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    registered.add(target)
    logger.log(`[PLUGINS] Loaded ${spec}`)
    loaded.push(spec)
  }
  return loaded
}
