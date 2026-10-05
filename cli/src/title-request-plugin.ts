// Plugin entrypoint only: OpenCode initializes every exported function.
import type { Plugin } from '@opencode-ai/plugin'
import { TITLE_REQUEST_SYSTEM, TITLE_MAX_OUTPUT_TOKENS } from './title-request.js'

export const titleRequestPlugin: Plugin = async () => {
  const requests = new Set<string>()
  return {
    'chat.message': async ({ sessionID, agent }, output) => {
      if (agent === 'title' && output.message.system === TITLE_REQUEST_SYSTEM) requests.add(sessionID)
    },
    'experimental.chat.system.transform': async ({ sessionID }, output) => {
      if (sessionID && requests.has(sessionID)) output.system = [TITLE_REQUEST_SYSTEM]
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      const user = output.messages.findLast((entry) => entry.info.role === 'user')
      if (!user || !requests.has(user.info.sessionID)) return
      // Drop branch/cwd and other synthetic context added by general coding
      // plugins. The isolated title request has one real user text part.
      user.parts = user.parts.filter((part) => part.type === 'text' && !part.synthetic)
      output.messages = [user]
    },
    'chat.params': async ({ agent, message }, output) => {
      if (agent !== 'title' || message.system !== TITLE_REQUEST_SYSTEM) return
      output.maxOutputTokens = TITLE_MAX_OUTPUT_TOKENS
      output.options.reasoningEffort = 'minimal'
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted') requests.delete(event.properties.info.id)
    },
    dispose: async () => { requests.clear() },
  }
}
