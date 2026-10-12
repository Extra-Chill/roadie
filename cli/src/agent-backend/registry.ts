// Process-wide agent backend provider used by the session runtime.
//
// The built-in OpenCode provider is the default. Plugins replace it through
// the `agent_backend` filter, resolved once at startup by
// `resolveAgentBackendProvider()`. Tests swap it with `setAgentBackendProvider`,
// which returns a function restoring the previous provider.

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { toOpenCodeBackend } from './opencode-sessions.js'
import { applyFilters, applyFiltersAsync } from '../hooks.js'
import { openCodeBackendProvider } from './opencode.js'
import path from 'node:path'
import { getDataDir } from '../config.js'
import { PiBackendProvider } from './pi/backend.js'
import { withPiChannels } from './pi/router.js'
import type { AgentBackend, AgentBackendProvider, AgentCatalogOperations } from './types.js'

/**
 * The built-in default: OpenCode, plus Pi for the channels listed in
 * ROADIE_PI_CHANNELS (comma-separated ids, #51 spike). Unset means OpenCode only.
 */
let resolvedDefault: AgentBackendProvider | undefined
let piPool: (PiPoolHandle & { agentDir: string }) | undefined

/**
 * Bill Pi channels to the credential pools (call before resolveAgentBackendProvider,
 * once the pool proxy is running). Without it Pi uses its own credentials.
 */
export function setPiPool(pool: PiPoolHandle & { agentDir: string }): void {
  piPool = pool
}

type PiPoolHandle = NonNullable<ConstructorParameters<typeof PiBackendProvider>[0]['pool']>

function defaultProvider(): AgentBackendProvider {
  if (resolvedDefault) return resolvedDefault
  const channels = (process.env['ROADIE_PI_CHANNELS'] ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  if (channels.length === 0) return openCodeBackendProvider
  const pi = new PiBackendProvider({
    bin: process.env['ROADIE_PI_BIN'] || 'pi',
    sessionDir: process.env['ROADIE_PI_SESSION_DIR'] || path.join(getDataDir(), 'pi-sessions'),
    fileEditLogDir: getDataDir(),
    ...(process.env['ROADIE_PI_MODEL'] && { model: process.env['ROADIE_PI_MODEL'] }),
    ...(process.env['ROADIE_PI_TITLE_MODEL'] && { titleModel: process.env['ROADIE_PI_TITLE_MODEL'] }),
    ...(piPool && { pool: piPool, env: { PI_CODING_AGENT_DIR: piPool.agentDir } }),
  })
  resolvedDefault = withPiChannels({ fallback: openCodeBackendProvider, pi, channels: new Set(channels) })
  return resolvedDefault
}

// Pi is added only in resolveAgentBackendProvider(), after the data dir is set.
let currentProvider: AgentBackendProvider = withProviderFilters(openCodeBackendProvider)

/**
 * The channel a backend choice is keyed on: a thread's parent, else the channel
 * itself. Backend selection (e.g. Pi channels) is per parent channel.
 */
export function backendChannelId(channel: { id: string; isThread?: () => boolean; parentId?: string | null } | null | undefined): string | undefined {
  if (!channel) return undefined
  return channel.isThread?.() ? (channel.parentId ?? channel.id) : channel.id
}

export function getAgentBackendProvider(): AgentBackendProvider {
  return currentProvider
}

/** Catalog listings run through the `agent_providers` / `agent_definitions` filters. */
export function withCatalogFilters(catalog: AgentCatalogOperations): AgentCatalogOperations {
  return {
    async providers(input) {
      const result = await catalog.providers(input)
      return result instanceof Error ? result : applyFiltersAsync('agent_providers', result, input)
    },
    config: (input) => catalog.config(input),
    ...(catalog.commands && { commands: catalog.commands.bind(catalog) }),
    async agents(input) {
      const result = await catalog.agents(input)
      return result instanceof Error ? result : applyFiltersAsync('agent_definitions', result, input)
    },
  }
}

const filteredBackends = new WeakMap<AgentBackend, AgentBackend>()

function withFilters(backend: AgentBackend): AgentBackend {
  const cached = filteredBackends.get(backend)
  if (cached) return cached
  const filtered = { ...backend, catalog: withCatalogFilters(backend.catalog) }
  filteredBackends.set(backend, filtered)
  return filtered
}

/** The provider with catalog filters applied, whichever backend it is. */
function withProviderFilters(provider: AgentBackendProvider): AgentBackendProvider {
  return {
    ...provider,
    getBackend(directory) {
      const backend = provider.getBackend(directory)
      return backend ? withFilters(backend) : null
    },
    async initializeForDirectory(directory, options) {
      const getBackend = await provider.initializeForDirectory(directory, options)
      if (getBackend instanceof Error) return getBackend
      return () => withFilters(getBackend())
    },
  }
}

/**
 * Catalog getter for code that still holds a raw OpenCode client (some
 * commands). Same Roadie types and filters as the runtime sees.
 */
export function openCodeCatalogGetter(getClient: () => OpencodeClient): () => AgentBackend {
  return () => withFilters(toOpenCodeBackend(getClient()))
}

/** Apply the `agent_backend` filter. Call after plugins load, before the bot starts. */
export function resolveAgentBackendProvider(): AgentBackendProvider {
  currentProvider = withProviderFilters(applyFilters('agent_backend', defaultProvider(), {}))
  return currentProvider
}

export function setAgentBackendProvider(
  provider: AgentBackendProvider,
): () => void {
  const previous = currentProvider
  currentProvider = withProviderFilters(provider)
  return () => {
    currentProvider = previous
  }
}
