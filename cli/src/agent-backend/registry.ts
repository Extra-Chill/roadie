// Process-wide agent backend provider used by the session runtime.
//
// Defaults to OpenCode. Tests (and, later, alternative backends) swap it with
// `setAgentBackendProvider`, which returns a function restoring the previous
// provider.

import { openCodeBackendProvider } from './opencode.js'
import type { AgentBackendProvider } from './types.js'

let currentProvider: AgentBackendProvider = openCodeBackendProvider

export function getAgentBackendProvider(): AgentBackendProvider {
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
