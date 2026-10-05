// Agent backend seam for the session runtime.
//
// Session operations (`sessions`) and listings (`catalog`) are defined in
// Roadie's own terms and return Roadie types or an Error, so a second backend
// implements them directly. Ids (providers, models, agents) are open strings.
//
// Keep this list in sync with real call sites. Add an operation only when the
// runtime starts using it.

import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import * as errore from 'errore'
import type { AgentMessage, AgentPart, AgentSession, AgentStatus } from './events.js'

/**
 * The backend rejected a request (as opposed to the request never arriving,
 * which is a transport error). `message` is the backend's own explanation.
 */
export class AgentRequestError extends errore.createTaggedError({
  name: 'AgentRequestError',
  message: '$detail',
}) {}

/** One permission rule. The last matching rule wins. */
export type AgentPermissionRule = {
  permission: string
  pattern: string
  action: 'allow' | 'deny' | 'ask'
}

export type AgentModelSelection = { providerId: string; modelId: string }

/** Input for a prompt. Synthetic text is context the person did not type. */
export type AgentPromptPart =
  | { kind: 'text'; text: string; synthetic?: boolean }
  | { kind: 'file'; mime: string; url: string; filename?: string }

export type AgentSessionMessage = { message: AgentMessage; parts: AgentPart[] }

export type AgentSessionOperations = {
  /** A bounded title-only model request, without the source conversation. */
  generateTitle?(input: { directory: string; prompt: string }): Promise<string | Error>
  /** Optional backend title mutation; it never starts an agent/model turn. */
  setTitle?(input: { sessionId: string; directory: string; title: string }): Promise<void | Error>
  create(input: { directory: string; permission?: AgentPermissionRule[] }): Promise<AgentSession | Error>
  /** Undefined when the backend has no such session. */
  get(input: { sessionId: string; directory: string }): Promise<AgentSession | undefined | Error>
  setPermissions(input: { sessionId: string; permission: AgentPermissionRule[] }): Promise<void | Error>
  messages(input: { sessionId: string; directory: string }): Promise<AgentSessionMessage[] | Error>
  /** Queue a prompt. Resolves once accepted; output arrives as events. */
  prompt(input: {
    sessionId: string
    directory: string
    parts: AgentPromptPart[]
    system?: string
    agent?: string
    model?: AgentModelSelection
    variant?: string
    /** Record the message without starting a turn. */
    noReply?: boolean
  }): Promise<void | Error>
  /** Run a named backend command (e.g. a project slash command). */
  command(
    input: {
      sessionId: string
      directory: string
      command: string
      arguments: string
      agent?: string
      model?: AgentModelSelection
      variant?: string
    },
    options?: { signal?: AbortSignal },
  ): Promise<void | Error>
  abort(input: { sessionId: string; directory: string }): Promise<void | Error>
  /** Status of every session with a known status; absent means idle. */
  status(input: { directory: string }): Promise<Record<string, AgentStatus> | Error>
  replyPermission(input: {
    requestId: string
    directory: string
    reply: 'once' | 'always' | 'reject'
  }): Promise<void | Error>
}

/** A model a provider offers. */
export type AgentModelInfo = {
  id: string
  name: string
  /** Context window in tokens, when known. */
  contextLimit?: number
  /** Thinking levels / variants the model accepts, e.g. "low", "high". */
  variants: string[]
  /** Release date as reported by the backend (shown in pickers). */
  releaseDate?: string
}

/** A model provider and its models, keyed by model id. */
export type AgentProviderInfo = {
  id: string
  name: string
  models: Record<string, AgentModelInfo>
}

export type AgentProviderCatalog = {
  providers: AgentProviderInfo[]
  /** Ids of providers that are authenticated and usable. */
  connected: string[]
  /** Default model id per provider id. */
  defaults: Record<string, string>
}

/** An agent the backend can run a session as. */
export type AgentDefinition = {
  name: string
  description?: string
  /** "primary" agents are user-selectable; "subagent" ones are delegated to; "all" are both. */
  mode: string
  hidden?: boolean
  model?: AgentModelSelection
}

/** Model/provider, configuration and agent listings, in Roadie terms. */
export type AgentCatalogOperations = {
  providers(input: { directory?: string }): Promise<AgentProviderCatalog | Error>
  /** Backend-configured default models, as "provider/model" ids. */
  config(input: { directory?: string }): Promise<{ model?: string; smallModel?: string } | Error>
  agents(input: { directory?: string }): Promise<AgentDefinition[] | Error>
}

export type AgentCatalog = { catalog: AgentCatalogOperations }

/** A question asked before an OAuth sign-in starts (e.g. which account type). */
export type AgentAuthPrompt =
  | {
      type: 'text'
      key: string
      message: string
      placeholder?: string
      when?: { key: string; op: 'eq' | 'neq'; value: string }
    }
  | {
      type: 'select'
      key: string
      message: string
      options: Array<{ label: string; value: string; hint?: string }>
      when?: { key: string; op: 'eq' | 'neq'; value: string }
    }

/** One way to sign in to a provider. */
export type AgentAuthMethod = {
  type: 'oauth' | 'api'
  label: string
  prompts?: AgentAuthPrompt[]
}

/** A started OAuth sign-in: the user opens `url`. */
export type AgentOAuthStart = {
  url: string
  /** "auto": the backend sees the callback itself; "code": the user pastes a code or callback URL. */
  mode: 'auto' | 'code'
  instructions: string
}

/**
 * Provider sign-in. Completing a sign-in makes the new credentials take
 * effect for subsequent sessions.
 */
export type AgentAuthOperations = {
  /** Sign-in methods per provider id. A provider absent here accepts an API key. */
  methods(input: { directory: string }): Promise<Record<string, AgentAuthMethod[]> | Error>
  startOAuth(input: {
    directory: string
    providerId: string
    /** Index into the provider's methods. */
    method: number
    inputs?: Record<string, string>
  }): Promise<AgentOAuthStart | Error>
  /** Finish an OAuth sign-in. Without `code`, waits for an "auto" callback. */
  finishOAuth(input: { directory: string; providerId: string; method: number; code?: string }): Promise<void | Error>
  setApiKey(input: { directory: string; providerId: string; key: string }): Promise<void | Error>
}

export type AgentBackend = AgentCatalog & {
  sessions: AgentSessionOperations
  auth: AgentAuthOperations
}

/**
 * One raw event from the backend's stream. The runtime translates it into an
 * AgentEvent (./opencode-events.ts) and keeps the raw form only for the opt-in
 * backend event log.
 */
export type AgentBackendEvent = OpenCodeEvent

/** Lazily returns the catalog for a directory once it has been initialized. */
export type AgentCatalogGetter = () => AgentCatalog

/** Lazily returns the backend for a directory once it has been initialized. */
export type AgentBackendGetter = () => AgentBackend

export type AgentBackendInitializeOptions = {
  originalRepoDirectory?: string
  channelId?: string
}

/**
 * Supplies agent backends to the session runtime, one per project directory.
 * The default provider is OpenCode (see `./opencode.ts`).
 */
export type AgentBackendProvider = {
  /** Name used in logs. */
  readonly id: string
  /** Backend for a directory whose server is already running, or null. */
  getBackend(directory: string): AgentBackend | null
  /** Ensure the backend serving `directory` is running; returns a getter. */
  initializeForDirectory(
    directory: string,
    options?: AgentBackendInitializeOptions,
  ): Promise<Error | AgentBackendGetter>
  /**
   * One stream of events for every session and directory this provider
   * serves. Returns null while no backend is running. The stream ends or
   * throws when the connection drops; callers reconnect.
   */
  subscribeEvents(options: {
    signal: AbortSignal
  }): null | Promise<Error | AsyncIterable<AgentBackendEvent>>
  /** Called whenever the backend (re)starts, so event consumers reconnect. */
  onStarted(listener: (info: { description: string }) => void): void
}
