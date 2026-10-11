// OpenCode implementation of the Roadie session operations (./types.ts).
// Wraps the OpenCode SDK client: translates inputs to OpenCode's shape and
// results to Roadie types, and turns `{ data, error }` responses into values
// or errors. A thrown/transport failure becomes OpenCodeSdkError; a request
// OpenCode answered with an error becomes AgentRequestError.

import type { OpencodeClient, Part as OpenCodePart, Provider as OpenCodeProvider } from '@opencode-ai/sdk/v2'
import { OpenCodeSdkError } from '../errors.js'
import { extractSdkErrorMessage, getOpencodeServerAuthHeaders, getOpencodeServerPort } from '../opencode.js'
import { toAgentMessage, toAgentPart, toAgentSession } from './opencode-events.js'
import type { AgentStatus } from './events.js'
import { TITLE_REQUEST_SYSTEM, TITLE_PROMPT_MAX_CHARS } from '../title-request.js'
import * as errore from 'errore'
import {
  AgentRequestError,
  type AgentAuthMethod,
  type AgentAuthOperations,
  type AgentBackend,
  type AgentCatalogOperations,
  type AgentMcpOperations,
  type AgentProviderInfo,
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
    async generateTitle({ directory, prompt }) {
      const config = await call('config.get', () => client.config.get({ directory }))
      if (config instanceof Error) return config
      const selected = config?.agent?.title?.model ?? config?.small_model
      if (!selected) return new AgentRequestError({ detail: 'Configure agent.title.model or small_model explicitly in OpenCode for fork titles. Roadie does not choose a model for you.' })
      const separator = selected.indexOf('/')
      if (separator <= 0) return new AgentRequestError({ detail: 'small_model must use provider/model format' })
      const signal = AbortSignal.timeout(15_000)
      // Explicit non-default title prevents the temporary session's own
      // automatic title request. Its history starts empty: never fork it.
      const temporary = await call('session.create', () => client.session.create({ directory, title: 'Roadie internal title request', permission: [{ permission: '*', pattern: '*', action: 'deny' }] }, { signal }))
      if (temporary instanceof Error) return temporary
      if (!temporary) return new AgentRequestError({ detail: 'Could not create isolated title request' })
      await using cleanup = new errore.AsyncDisposableStack()
      cleanup.defer(async () => {
        await client.session.abort({ sessionID: temporary.id, directory }).catch(() => undefined)
        await client.session.delete({ sessionID: temporary.id, directory }).catch(() => undefined)
      })
      const response = await call('session.prompt', () => client.session.prompt({ sessionID: temporary.id, directory, agent: 'title',
          model: { providerID: selected.slice(0, separator), modelID: selected.slice(separator + 1) },
          system: TITLE_REQUEST_SYSTEM, parts: [{ type: 'text', text: prompt.slice(0, TITLE_PROMPT_MAX_CHARS) }],
        }, { signal }))
      if (response instanceof Error) return response
      if (response?.info.role === 'assistant' && response.info.error) return new AgentRequestError({ detail: `Configured title model ${selected} failed: ${extractSdkErrorMessage(response.info.error)}` })
      const title = response?.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('').trim()
      return title || new AgentRequestError({ detail: 'Small model returned an empty fork title' })
    },
    async setTitle({ sessionId, directory, title }) {
      const result = await call('session.update', () => client.session.update({ sessionID: sessionId, directory, title }))
      return result instanceof Error ? result : undefined
    },
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

export function toAgentProvider(provider: OpenCodeProvider): AgentProviderInfo {
  return {
    id: provider.id,
    name: provider.name,
    models: Object.fromEntries(Object.entries(provider.models ?? {}).map(([id, model]) => [id, {
      id,
      name: model.name || id,
      ...(model.limit?.context ? { contextLimit: model.limit.context } : {}),
      variants: Object.keys(model.variants ?? {}).filter((v) => v.trim().length > 0),
      ...(model.release_date && { releaseDate: model.release_date }),
    }])),
  }
}

export function openCodeCatalogOperations(client: OpencodeClient): AgentCatalogOperations {
  return {
    async providers({ directory }) {
      const data = await call('config.providers', () => client.config.providers({ directory }))
      if (data instanceof Error) return data
      if (!data) return new AgentRequestError({ detail: 'OpenCode returned no providers' })
      return {
        providers: data.providers.map(toAgentProvider),
        connected: data.providers.map((provider) => provider.id),
        defaults: data.default,
      }
    },
    async config({ directory }) {
      const data = await call('config.get', () => client.config.get({ directory }))
      if (data instanceof Error) return data
      return {
        ...(data?.model && { model: data.model }),
        ...(data?.small_model && { smallModel: data.small_model }),
      }
    },
    async agents({ directory }) {
      const data = await call('app.agents', () => client.app.agents({ directory }))
      if (data instanceof Error) return data
      return (data ?? []).map((agent) => ({
        name: agent.name,
        ...(agent.description && { description: agent.description }),
        mode: agent.mode,
        ...(agent.hidden && { hidden: true }),
        ...(agent.model && { model: { providerId: agent.model.providerID, modelId: agent.model.modelID } }),
      }))
    },
  }
}

export function openCodeAuthOperations(client: OpencodeClient): AgentAuthOperations {
  // New credentials only apply after OpenCode reloads its instance.
  const reload = async (directory: string) => {
    await client.instance.dispose({ directory }).catch(() => undefined)
  }
  return {
    async methods({ directory }) {
      const data = await call('provider.auth', () => client.provider.auth({ directory }))
      if (data instanceof Error) return data
      return (data ?? {}) as Record<string, AgentAuthMethod[]>
    },
    async startOAuth({ directory, providerId, method, inputs }) {
      // Direct request: the SDK drops the `inputs` body field the server accepts.
      const port = getOpencodeServerPort()
      if (!port) return new AgentRequestError({ detail: 'OpenCode server is not running. Please try again.' })
      const url = new URL(`/provider/${encodeURIComponent(providerId)}/oauth/authorize`, `http://127.0.0.1:${port}`)
      url.searchParams.set('directory', directory)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-opencode-directory': directory,
          ...getOpencodeServerAuthHeaders(),
        },
        body: JSON.stringify({
          method,
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
        }),
      }).catch((e: unknown) => new OpenCodeSdkError({ operation: 'provider.oauth.authorize', cause: e }))
      if (response instanceof Error) return response
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let detail = text || 'Unknown error'
        try {
          const parsed = JSON.parse(text) as { message?: string; data?: { message?: string } }
          detail = parsed?.data?.message || parsed?.message || detail
        } catch {}
        return new AgentRequestError({ detail })
      }
      const body = (await response.json().catch(() => null)) as
        | { url: string; method: 'auto' | 'code'; instructions: string }
        | null
      if (!body) return new AgentRequestError({ detail: 'Failed to parse authorization response' })
      return { url: body.url, mode: body.method, instructions: body.instructions }
    },
    async finishOAuth({ directory, providerId, method, code }) {
      const result = await call('provider.oauth.callback', () => client.provider.oauth.callback({
        providerID: providerId,
        method,
        ...(code !== undefined && { code }),
        directory,
      }))
      if (result instanceof Error) return result
      await reload(directory)
    },
    async setApiKey({ directory, providerId, key }) {
      const result = await call('auth.set', () => client.auth.set({ providerID: providerId, auth: { type: 'api', key } }))
      if (result instanceof Error) return result
      await reload(directory)
    },
  }
}

const backends = new WeakMap<OpencodeClient, AgentBackend>()

/** The Roadie backend for an OpenCode client. Cached per client. */
export function openCodeMcpOperations(client: OpencodeClient): AgentMcpOperations {
  return {
    async addRemote({ directory, name, url, headers }) {
      const result = await call('mcp.add', () =>
        client.mcp.add({
          directory,
          name,
          // oauth: false keeps OpenCode from starting its own shared OAuth flow.
          config: { type: 'remote', url, headers, oauth: false },
        }),
      )
      return result instanceof Error ? result : undefined
    },
  }
}

export function toOpenCodeBackend(client: OpencodeClient): AgentBackend {
  const cached = backends.get(client)
  if (cached) return cached
  const backend: AgentBackend = {
    sessions: openCodeSessionOperations(client),
    catalog: openCodeCatalogOperations(client),
    auth: openCodeAuthOperations(client),
    mcp: openCodeMcpOperations(client),
  }
  backends.set(client, backend)
  return backend
}
