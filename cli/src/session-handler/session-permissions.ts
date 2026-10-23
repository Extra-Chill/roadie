// session permissions operations used by ThreadSessionRuntime.

import type { AgentBackend } from '../agent-backend/types.js'
import { AgentRequestError } from '../agent-backend/types.js'
import { getDataDir } from '../config.js'
import { personKeyFrom } from '../credentials/person-pool.js'
import { getCachedPerson, isIdentityConfigured } from '../identity.js'
import { createLogger, LogPrefix } from '../logger.js'
import { resolveSessionPermissionRules } from '../permission-policy.js'
import { registerPersonMcpServers } from '../person-mcp.js'
import { type IngressInput } from './ingress-input.js'
import type { ThreadSessionRuntime } from './thread-session-runtime.js'

const logger = createLogger(LogPrefix.SESSION)

// Explicit dependencies keep orchestration and resource ownership in the runtime.
type RuntimeContext = {
  chat: ThreadSessionRuntime['chat']
  sdkDirectory: ThreadSessionRuntime['sdkDirectory']
  permissionOwner: ThreadSessionRuntime['permissionOwner']
}

export async function registerSpeakerMcpServers(
  runtime: Pick<RuntimeContext, 'chat' | 'sdkDirectory'>,
  {
    client,
    input,
  }: {
    client: AgentBackend
    input: Pick<IngressInput, 'userId' | 'actorVia' | 'personId'>
  },
): Promise<void> {
  if (!isIdentityConfigured()) return
  if (!input.userId || (input.actorVia ?? 'chat') !== 'chat') return
  const actor = { platform: runtime.chat.platform, id: input.userId }
  const person = getCachedPerson(actor)
  if (!person?.allowed || !person.mcpServers?.length) return
  const personKey = personKeyFrom({
    personId: person.personId,
    platform: actor.platform,
    actorId: actor.id,
  })
  if (!personKey) return
  await registerPersonMcpServers({
    backend: client,
    directory: runtime.sdkDirectory,
    dataDir: getDataDir(),
    personKey,
    servers: person.mcpServers,
  }).catch((e: unknown) => logger.warn(`[PERSON-MCP] registration failed: ${String(e)}`))
}

export async function updateExistingSessionPermissions(
  runtime: Pick<RuntimeContext, 'sdkDirectory' | 'permissionOwner'>,
  {
    client,
    sessionId,
    permissions,
    noReply,
    owner,
  }: {
    client: AgentBackend
    sessionId: string
    permissions?: string[]
    noReply?: boolean
    owner?: string
  },
) {
  if (noReply) {
    return null
  }

  const rules = resolveSessionPermissionRules({
    directory: runtime.sdkDirectory,
    requested: permissions,
    phase: 'create',
  })

  const updateResult = await client.sessions.setPermissions({
    sessionId,
    permission: rules,
    owner,
  })
  if (updateResult instanceof AgentRequestError) {
    return new Error('Pi rejected permission update', { cause: updateResult })
  }
  if (updateResult instanceof Error) return updateResult
  runtime.permissionOwner = owner
  return null
}
