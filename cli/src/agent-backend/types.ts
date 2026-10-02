import type { OpencodeClient } from '@opencode-ai/sdk/v2'

/** OpenCode client routes currently consumed by the session runtime. */
export type AgentBackend = Pick<
  OpencodeClient,
  'session' | 'permission' | 'question' | 'provider' | 'config' | 'app' | 'global'
>
