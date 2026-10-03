// OpenCode implementation of the Roadie session operations (./types.ts).
// Wraps the OpenCode SDK client: translates inputs to OpenCode's shape and
// results to Roadie types, and turns `{ data, error }` responses into values
// or errors. A thrown/transport failure becomes OpenCodeSdkError; a request
// OpenCode answered with an error becomes AgentRequestError.

import type { OpencodeClient, Part as OpenCodePart } from '@opencode-ai/sdk/v2'
import { OpenCodeSdkError } from '../errors.js'
import { extractSdkErrorMessage } from '../opencode.js'
import { toAgentMessage, toAgentPart, toAgentSession } from './opencode-events.js'
import type { AgentStatus } from './events.js'
import {
  AgentRequestError,
  type AgentBackend,
  type AgentModelSelection,
  type AgentPromptPart,
  type AgentSessionOperations,
} from './types.js'

type SdkResult<T> = { data?: T; error?: unknown }

async function call<T>(operation: string, request: () => Promise<SdkResult<T>>): Promise<T | undefined | Error> {
  const result = await request().catch((e: unknown) => new OpenCodeSdkError({ operation, cause: e }))
  if (result instanceof Error) return result
  if (result.error) {
    return new AgentRequestError({ detail: extractSdkErrorMessage(result.error as Parameters<typeof extractSdkErrorMessage>[0]) })
  }
  return result.data
}

function toOpenCodeParts(parts: AgentPromptPart[]) {
  return parts.map((part) => {
    if (part.kind === 'text') {
      return { type: 'text' as const, text: part.text, ...(part.synthetic && { synthetic: true }) }
    }
    return {
      type: 'file' as const,
      mime: part.mime,
      url: part.url,
      ...(part.filename && { filename: part.filename }),
    }
  })
}

function toOpenCodeModel(model: AgentModelSelection | undefined) {
  return model ? { providerID: model.providerId, modelID: model.modelId } : undefined
}

function toStatus(status: { type: string; attempt?: number; message?: string; next?: number }): AgentStatus {
  if (status.type === 'retry') {
    return { state: 'retry', attempt: status.attempt ?? 0, message: status.message ?? '', nextAt: status.next ?? 0 }
  }
  return status.type === 'busy' ? { state: 'busy' } : { state: 'idle' }
}

export function openCodeSessionOperations(client: OpencodeClient): AgentSessionOperations {
  return {
    async create({ directory, permission }) {
      const session = await call('session.create', () => client.session.create({ directory, permission }))
      if (session instanceof Error) return session
      if (!session) return new AgentRequestError({ detail: 'OpenCode returned no session' })
      return toAgentSession(session)
    },
    async get({ sessionId, directory }) {
      const session = await call('session.get', () => client.session.get({ sessionID: sessionId, directory }))
      if (session instanceof Error) return session
      return session ? toAgentSession(session) : undefined
    },
    async setPermissions({ sessionId, permission }) {
      const result = await call('session.update', () => client.session.update({ sessionID: sessionId, permission }))
      return result instanceof Error ? result : undefined
    },
    async messages({ sessionId, directory }) {
      const messages = await call('session.messages', () => client.session.messages({ sessionID: sessionId, directory }))
      if (messages instanceof Error) return messages
      return (messages ?? []).map((entry) => ({
        message: toAgentMessage(entry.info),
        parts: (entry.parts as OpenCodePart[]).map(toAgentPart),
      }))
    },
    async prompt({ sessionId, directory, parts, system, agent, model, variant, noReply }) {
      const result = await call('session.promptAsync', () => client.session.promptAsync({
        sessionID: sessionId,
        directory,
        parts: toOpenCodeParts(parts),
        ...(system !== undefined && { system }),
        ...(agent && { agent }),
        ...(model && { model: toOpenCodeModel(model) }),
        ...(variant && { variant }),
        ...(noReply && { noReply: true }),
      }))
      return result instanceof Error ? result : undefined
    },
    async command({ sessionId, directory, command, arguments: args, agent, model, variant }, options) {
      const result = await call('session.command', () => client.session.command(
        {
          sessionID: sessionId,
          directory,
          command,
          arguments: args,
          ...(agent && { agent }),
          ...(model && { model: `${model.providerId}/${model.modelId}` }),
          ...(variant && { variant }),
        },
        options?.signal ? { signal: options.signal } : undefined,
      ))
      return result instanceof Error ? result : undefined
    },
    async abort({ sessionId, directory }) {
      const result = await call('session.abort', () => client.session.abort({ sessionID: sessionId, directory }))
      return result instanceof Error ? result : undefined
    },
    async status({ directory }) {
      const statuses = await call('session.status', () => client.session.status({ directory }))
      if (statuses instanceof Error) return statuses
      return Object.fromEntries(
        Object.entries(statuses ?? {}).map(([id, status]) => [id, toStatus(status)]),
      )
    },
    async replyPermission({ requestId, directory, reply }) {
      const result = await call('permission.reply', () => client.permission.reply({ requestID: requestId, directory, reply }))
      return result instanceof Error ? result : undefined
    },
  }
}

const backends = new WeakMap<OpencodeClient, AgentBackend>()

/** The Roadie backend for an OpenCode client. Cached per client. */
export function toOpenCodeBackend(client: OpencodeClient): AgentBackend {
  const cached = backends.get(client)
  if (cached) return cached
  const backend: AgentBackend = {
    sessions: openCodeSessionOperations(client),
    provider: client.provider,
    config: client.config,
    app: client.app,
  }
  backends.set(client, backend)
  return backend
}
