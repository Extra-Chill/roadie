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
import type { AgentBackend, AgentBackendProvider, AgentCatalogOperations } from './types.js'

let currentProvider: AgentBackendProvider = withProviderFilters(openCodeBackendProvider)

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
  currentProvider = withProviderFilters(applyFilters('agent_backend', openCodeBackendProvider, {}))
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
