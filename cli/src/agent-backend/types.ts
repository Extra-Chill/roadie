// Agent backend seam for the session runtime.
//
// Session operations (`sessions`) and listings (`catalog`) are defined in
// Roadie's own terms and return Roadie types or an Error, so a second backend
// implements them directly. Ids (providers, models, agents) are open strings.
//
// Keep this list in sync with real call sites. Add an operation only when the
// runtime starts using it.

import * as errore from 'errore'
import type { AgentEvent, AgentMessage, AgentPart, AgentSession, AgentStatus } from './events.js'

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
  generateTitle?(input: { sessionId: string; directory: string; prompt: string }): Promise<string | Error>
  /**
   * Optional backend title mutation; it never starts an agent/model turn.
   * Omit `directory` to let the backend resolve the session by id alone.
   */
  setTitle?(input: { sessionId: string; directory?: string; title: string }): Promise<void | Error>
  create(input: { directory: string; permission?: AgentPermissionRule[]; title?: string }): Promise<AgentSession | Error>
  /**
   * Undefined when the backend has no such session. Omit `directory` to let
   * the backend resolve the session by id alone.
   */
  get(input: { sessionId: string; directory?: string }): Promise<AgentSession | undefined | Error>
  setPermissions(input: { sessionId: string; permission: AgentPermissionRule[]; owner?: string }): Promise<void | Error>
  /**
   * Messages in order, oldest first. With `limit`, only the newest `limit`.
   * Omit `directory` to let the backend resolve the session by id alone.
   */
  messages(input: { sessionId: string; directory?: string; limit?: number }): Promise<AgentSessionMessage[] | Error>
  /**
   * One page of messages ending before `before` (a cursor from a previous
   * page), oldest first. `nextCursor` is set when older messages remain.
   * Absent when the backend cannot page; callers fall back to `messages`.
   */
  messagePage?(input: {
    sessionId: string
    directory?: string
    limit: number
    before?: string
  }): Promise<{ messages: AgentSessionMessage[]; nextCursor?: string } | Error>
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
      /** The turn's system prompt, as for `prompt`. */
      system?: string
      agent?: string
      model?: AgentModelSelection
      variant?: string
    },
    options?: { signal?: AbortSignal },
  ): Promise<void | Error>
  /** Omit `directory` to let the backend resolve the session by id alone. */
  abort(input: { sessionId: string; directory?: string }): Promise<void | Error>
  /**
   * Sessions the backend knows about. Omit `directory` for the backend's
   * default scope. Order is backend-defined; sort by `updatedAt` when it matters.
   */
  list(input: { directory?: string }): Promise<AgentSession[] | Error>
  delete(input: { sessionId: string; directory: string }): Promise<void | Error>
  /**
   * Copy a session into a new one, optionally only up to `messageId`.
   * With `targetDirectory` the fork is bound to that existing workspace (a
   * host-provisioned Git worktree); a backend that cannot bind returns an
   * Error and leaves no fork behind.
   */
  fork(input: {
    sessionId: string
    /** Omit to let the backend resolve the source session by id alone. */
    directory?: string
    messageId?: string
    targetDirectory?: string
    targetProjectDirectory?: string
  }): Promise<AgentSession | Error>
  /**
   * Compact the session's history into a summary using `model`.
   * Absent when the backend cannot compact on request.
   */
  summarize?(input: { sessionId: string; directory: string; model: AgentModelSelection }): Promise<void | Error>
  /** Status of every session with a known status; absent means idle. */
  status(input: { directory: string }): Promise<Record<string, AgentStatus> | Error>
  replyPermission(input: {
    requestId: string
    directory: string
    reply: 'once' | 'always' | 'reject'
    /** Feedback for the agent, sent with a rejection. */
    message?: string
  }): Promise<void | Error>
  /**
   * Questions the agent is waiting on, across sessions in `directory`.
   * Absent when the backend has no question tool.
   */
  questions?(input: { directory: string }): Promise<AgentQuestionRequest[] | Error>
  /** Answer a pending question. One answer list per question, in order. */
  replyQuestion?(input: {
    requestId: string
    directory: string
    answers: string[][]
  }): Promise<void | Error>
  /**
   * Answer a pending MCP form elicitation (form.asked). Only the person whose
   * server asked may accept or decline; the backend refuses anyone else.
   * Never consults permission rules — the person's own consent is the gate.
   */
  replyForm?(input: {
    requestId: string
    directory: string
    action: 'accept' | 'decline' | 'cancel'
    /** Collected form fields, for accept. */
    content?: Record<string, unknown>
    /** The person answering, resolved by the chat layer from the click. */
    personKey?: string
  }): Promise<void | Error>
}

/** A question the agent asked and is blocked on. */
export type AgentQuestionRequest = {
  id: string
  sessionId: string
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
/** A project command the backend can run by name (slash commands, skills, MCP prompts). */
export type AgentCommand = {
  name: string
  description?: string
  source?: 'command' | 'mcp' | 'skill'
}

export type AgentCatalogOperations = {
  providers(input: { directory?: string }): Promise<AgentProviderCatalog | Error>
  /** Backend-configured default models, as "provider/model" ids. */
  config(input: { directory?: string }): Promise<{ model?: string; smallModel?: string } | Error>
  agents(input: { directory?: string }): Promise<AgentDefinition[] | Error>
  /** Project commands for `directory`, runnable through `sessions.command`. */
  commands?(input: { directory: string }): Promise<AgentCommand[] | Error>
}

export type AgentCatalog = { catalog: AgentCatalogOperations }

/**
 * Tool servers (MCP) the backend can connect to. Optional: a backend without
 * dynamic MCP registration simply gives people no per-person servers.
 */
/**
 * One MCP server's state. `error` explains `failed` and `needs_client_registration`.
 * `unknown`: the backend cannot observe the real connection (a backend that
 * only relays config, so a configured server may or may not be up).
 */
export type AgentMcpServerStatus = {
  status: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration' | 'unknown'
  error?: string
}

export type AgentMcpOperations = {
  /** Every configured MCP server by name. */
  status(input: { directory: string }): Promise<Record<string, AgentMcpServerStatus> | Error>
  connect(input: { directory: string; name: string }): Promise<void | Error>
  disconnect(input: { directory: string; name: string }): Promise<void | Error>
  /**
   * Add or replace a remote MCP server for a project directory. `headers`
   * carry the credential and must never be logged. `owner` names the person
   * key the server is scoped to, when it is a per-person server; the backend
   * records it so MCP forms raised by the server can be answered only by that
   * person.
   */
  addRemote(input: {
    directory: string
    name: string
    url: string
    headers: Record<string, string>
    owner?: string
  }): Promise<void | Error>
}

export type AgentBackend = AgentCatalog & {
  sessions: AgentSessionOperations
  mcp?: AgentMcpOperations
}

/**
 * One item from the backend's event stream, already in Roadie's terms. A single
 * native backend event can imply several Roadie events (a delegation tool part
 * also carries child-session lifecycle), or none (an event Roadie ignores).
 *
 * `raw` is the backend's native payload, opaque to everything but the opt-in
 * backend event log. Consumers must not branch on it. `backend` is the emitting
 * provider's id (`this.id`, "pi"), so the opt-in log can tag
 * the raw payload with its source.
 */
export type AgentBackendEvent = {
  events: AgentEvent[]
  raw: unknown
  backend?: string
}

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
 * The default provider is Pi (see `./registry.ts`).
 */
export type AgentBackendProvider = {
  /** Name used in logs. */
  readonly id: string
  /**
   * Whether this provider runs or can resume `sessionId`. A thread bound to a
   * session no provider owns (e.g. one from a retired backend,
   * #177) is retired: it starts a new session, seeded from the thread, on its
   * next prompt.
   */
  owns(sessionId: string): boolean
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
  /** Stop every agent process this provider started (bot shutdown). */
  dispose?(): Promise<void>
}
