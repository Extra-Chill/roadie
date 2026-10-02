// OpenCode implementation of the agent backend seam.
//
// The OpenCode SDK client already satisfies `AgentBackend` structurally, so
// this provider hands the runtime the exact same client objects as before.
// Behavior is unchanged; only the import path the runtime depends on moves.

import {
  getOpencodeClient,
  initializeOpencodeForDirectory,
} from '../opencode.js'
import type { AgentBackendProvider } from './types.js'

export const openCodeBackendProvider: AgentBackendProvider = {
  id: 'opencode',
  getBackend(directory) {
    return getOpencodeClient(directory)
  },
  initializeForDirectory(directory, options) {
    return initializeOpencodeForDirectory(directory, options)
  },
}
