// Process-wide agent backend provider used by the session runtime.
//
// The built-in OpenCode provider is the default. Plugins replace it through
// the `agent_backend` filter, resolved once at startup by
// `resolveAgentBackendProvider()`. Tests swap it with `setAgentBackendProvider`,
// which returns a function restoring the previous provider.

import { applyFilters } from '../hooks.js'
import { openCodeBackendProvider } from './opencode.js'
import type { AgentBackendProvider } from './types.js'

let currentProvider: AgentBackendProvider = openCodeBackendProvider

export function getAgentBackendProvider(): AgentBackendProvider {
  return currentProvider
}

/** Apply the `agent_backend` filter. Call after plugins load, before the bot starts. */
export function resolveAgentBackendProvider(): AgentBackendProvider {
  currentProvider = applyFilters('agent_backend', openCodeBackendProvider, {})
  return currentProvider
}

export function setAgentBackendProvider(
  provider: AgentBackendProvider,
): () => void {
  const previous = currentProvider
  currentProvider = provider
  return () => {
    currentProvider = previous
  }
}
