// Per-channel Pi opt-in (#51): threads in opted-in channels create their
// sessions in Pi; everything else stays on the default backend. Pi as the
// default backend (#177): every new session starts in Pi and the fallback
// backend serves only the sessions it already owns.
//
// Session operations route by session id, so a Pi session keeps working
// wherever Roadie reaches it (permission buttons, /abort, CLI) even through
// `getBackend(directory)`, which carries no channel. Directory-wide listings
// merge both backends (sessions lists, MCP status, catalog commands). Event
// streams are merged.
//
// With Pi as the default the fallback backend (OpenCode) starts lazily: only
// using a session id Pi does not own resolves it (ensureFallback), so bot
// startup and every listing/status/questions/MCP merge work while it is down
// and never start it just to list.

import type { AgentSessionMessage } from '../types.js'
import {
  AgentRequestError,
  type AgentBackend,
  type AgentBackendEvent,
  type AgentBackendProvider,
  type AgentCatalogOperations,
  type AgentMcpOperations,
  type AgentSessionOperations,
} from '../types.js'
import type { PiBackendProvider } from './backend.js'

type Ops = AgentSessionOperations

function routedSessions({
  fallback,
  ensureFallback,
  pi,
  createInPi,
}: {
  fallback: AgentBackend | null
  /**
   * Pi default only: resolves the fallback backend — starting its server —
   * the first time a session id Pi does not own is used. Listings, status and
   * questions never call it, so they work while the fallback is down.
   */
  ensureFallback?: () => Promise<AgentBackend | null>
  pi: PiBackendProvider
  createInPi: boolean
}): AgentSessionOperations {
  const piOps = pi.getBackend().sessions
  const other = async (): Promise<AgentBackend | null> =>
    fallback ?? (ensureFallback ? await ensureFallback() : null)
  const pick = async (sessionId: string): Promise<Ops | Error> => {
    if (pi.owns(sessionId)) return piOps
    return (await other())?.sessions ?? new AgentRequestError({ detail: 'Agent backend is unavailable' })
  }
  const bySession = <K extends keyof Ops>(name: K) =>
    (async (input: { sessionId: string }, ...rest: unknown[]) => {
      const ops = await pick(input.sessionId)
      if (ops instanceof Error) return ops
      const fn = ops[name] as ((...args: unknown[]) => Promise<unknown>) | undefined
      if (!fn) return new AgentRequestError({ detail: `This session's backend does not support ${String(name)}` })
      return fn(input, ...rest)
    }) as unknown as NonNullable<Ops[K]>

  return {
    generateTitle: (input) => (createInPi || !fallback?.sessions.generateTitle
      ? piOps.generateTitle!(input)
      : fallback.sessions.generateTitle(input)),
    create: (input) => (createInPi ? piOps.create(input) : fallback?.sessions.create(input) ?? Promise.resolve(new AgentRequestError({ detail: 'Agent backend is unavailable' }))),
    get: bySession('get'),
    setPermissions: bySession('setPermissions'),
    messages: bySession('messages') as Ops['messages'],
    prompt: bySession('prompt'),
    command: bySession('command'),
    abort: bySession('abort'),
    replyPermission: async (input) => {
      // Permission request ids are not session-scoped; try Pi first, it knows its own.
      const piResult = await piOps.replyPermission(input)
      if (!(piResult instanceof Error)) return piResult
      const otherBackend = await other()
      return otherBackend ? otherBackend.sessions.replyPermission(input) : piResult
    },
    status: async (input) => {
      const [own, rest] = await Promise.all([piOps.status(input), fallback?.sessions.status(input)])
      if (rest instanceof Error) return rest
      return { ...(rest ?? {}), ...(own instanceof Error ? {} : own) }
    },
    list: async (input) => {
      const [own, rest] = await Promise.all([piOps.list(input), fallback?.sessions.list(input)])
      if (rest instanceof Error && own instanceof Error) return rest
      return [...(rest instanceof Error ? [] : rest ?? []), ...(own instanceof Error ? [] : own)]
    },
    delete: bySession('delete'),
    fork: bySession('fork'),
    setTitle: bySession('setTitle'),
    summarize: bySession('summarize'),
    messagePage: async (input) => {
      const ops = await pick(input.sessionId)
      if (ops instanceof Error) return ops
      if (ops.messagePage) return ops.messagePage(input)
      const all = await ops.messages(input)
      return all instanceof Error ? all : { messages: all as AgentSessionMessage[] }
    },
    questions: async (input) => {
      const [own, rest] = await Promise.all([piOps.questions?.(input), fallback?.sessions.questions?.(input)])
      return [...(own instanceof Error ? [] : own ?? []), ...(rest instanceof Error ? [] : rest ?? [])]
    },
    replyQuestion: async (input) => {
      // Like permissions: request ids are not session-scoped; Pi knows its own.
      const piResult = await piOps.replyQuestion!(input)
      if (!(piResult instanceof Error)) return piResult
      const otherBackend = await other()
      return otherBackend?.sessions.replyQuestion ? otherBackend.sessions.replyQuestion(input) : piResult
    },
  }
}

/** MCP across both backends: additions reach both; status merges; toggles apply where the server exists. */
function routedMcp(fallback: AgentBackend | null, pi: PiBackendProvider): AgentMcpOperations {
  const own = pi.getBackend().mcp!
  const other = fallback?.mcp
  const toggle = (name: 'connect' | 'disconnect') => async (input: { directory: string; name: string }) => {
    const results = await Promise.all([own[name](input), other?.[name](input)])
    return results.some((result) => result === undefined) ? undefined : (results.find((r) => r instanceof Error) ?? undefined)
  }
  return {
    addRemote: async (input) => {
      const [a, b] = await Promise.all([own.addRemote(input), other?.addRemote(input)])
      return b instanceof Error ? b : a
    },
    status: async (input) => {
      const [a, b] = await Promise.all([own.status(input), other?.status(input)])
      return { ...(b instanceof Error ? {} : b ?? {}), ...(a instanceof Error ? {} : a) }
    },
    connect: toggle('connect'),
    disconnect: toggle('disconnect'),
  }
}

/**
 * Directory-wide command listings merge both backends (default first, Pi
 * appended), deduplicated by name: registration calls the composite through
 * `getBackend(directory)`, which carries no channel, so without the merge the
 * OpenCode catalog alone would list and Pi-native prompts/skills (.pi/prompts,
 * .agents/skills) would never become Discord slash commands. A backend that
 * is down or lists nothing does not block the other side; an error is only
 * returned when both fail.
 */
function routedCommands({ fallback, pi }: { fallback: AgentBackend | null; pi: PiBackendProvider }): NonNullable<AgentCatalogOperations['commands']> {
  return async ({ directory }) => {
    const [own, other] = await Promise.all([
      pi.getBackend().catalog.commands?.({ directory }),
      fallback?.catalog.commands?.({ directory }),
    ])
    if ((own === undefined || own instanceof Error) && (other === undefined || other instanceof Error)) {
      return own ?? other ?? []
    }
    const seen = new Set<string>()
    return [...(other instanceof Error ? [] : other ?? []), ...(own instanceof Error ? [] : own ?? [])]
      .filter((command) => {
        if (seen.has(command.name)) return false
        seen.add(command.name)
        return true
      })
  }
}

function composite(
  fallback: AgentBackend | null,
  pi: PiBackendProvider,
  createInPi: boolean,
  ensureFallback?: () => Promise<AgentBackend | null>,
): AgentBackend {
  const base = createInPi || !fallback ? pi.getBackend() : fallback
  return {
    ...base,
    catalog: { ...base.catalog, commands: routedCommands({ fallback, pi }) },
    sessions: routedSessions({ fallback, ensureFallback, pi, createInPi }),
    mcp: routedMcp(fallback, pi),
  }
}

/** Merge two event streams; ends when the default backend's stream ends so callers reconnect both. */
async function* merge(
  primary: AsyncIterable<AgentBackendEvent> | undefined,
  pi: AsyncIterable<AgentBackendEvent>,
  signal: AbortSignal,
): AsyncIterable<AgentBackendEvent> {
  const iterators = [pi[Symbol.asyncIterator](), ...(primary ? [primary[Symbol.asyncIterator]()] : [])]
  const next = iterators.map((iterator, index) => iterator.next().then((result) => ({ index, result })))
  while (!signal.aborted) {
    const { index, result } = await Promise.race(next)
    if (result.done) {
      if (index !== 0) return
      next[index] = new Promise(() => {})
      continue
    }
    next[index] = iterators[index]!.next().then((r) => ({ index, result: r }))
    yield result.value
  }
}

/** One event stream for Pi plus the fallback backend, tolerating the fallback being down. */
function mergedEvents(
  fallback: AgentBackendProvider,
  pi: PiBackendProvider,
  { signal }: { signal: AbortSignal },
): Promise<Error | AsyncIterable<AgentBackendEvent>> {
  const primary = fallback.subscribeEvents({ signal })
  return (async () => {
    const piEvents = await pi.subscribeEvents({ signal })
    const resolved = primary ? await primary : undefined
    // The fallback backend is down: keep Pi events flowing until it starts.
    if (resolved instanceof Error) return merge(undefined, piEvents, signal)
    return merge(resolved, piEvents, signal)
  })()
}

/** Pi owns its sessions; every other session id belongs to the fallback. */
function sessionBackendId({
  sessionId,
  fallback,
  pi,
}: {
  sessionId: string
  fallback: AgentBackendProvider
  pi: PiBackendProvider
}): string {
  if (pi.owns(sessionId)) return pi.id
  return fallback.sessionBackendId?.(sessionId) ?? fallback.id
}

export function withPiChannels({
  fallback,
  pi,
  channels,
}: {
  fallback: AgentBackendProvider
  pi: PiBackendProvider
  channels: ReadonlySet<string>
}): AgentBackendProvider {
  return {
    id: `${fallback.id}+pi`,
    sessionBackendId: (sessionId) => sessionBackendId({ sessionId, fallback, pi }),
    getBackend(directory) {
      return composite(fallback.getBackend(directory), pi, false)
    },
    async initializeForDirectory(directory, options) {
      const piChannel = Boolean(options?.channelId && channels.has(options.channelId))
      if (piChannel) {
        return () => composite(fallback.getBackend(directory), pi, true)
      }
      const getFallback = await fallback.initializeForDirectory(directory, options)
      if (getFallback instanceof Error) return getFallback
      return () => composite(getFallback(), pi, false)
    },
    subscribeEvents({ signal }) {
      return mergedEvents(fallback, pi, { signal })
    },
    onStarted(listener) {
      fallback.onStarted(listener)
    },
  }
}

/**
 * Pi as the default backend (#177): every new session starts in Pi; a session
 * the fallback backend (OpenCode) already owns keeps working through it,
 * routed by session id. The fallback's server is not started here —
 * `initializeForDirectory` never touches it; it is resolved only when a
 * session id Pi does not own is used (see routedSessions) — so bot startup,
 * listings, status, questions and MCP work while OpenCode is down and never
 * start it just to list.
 */
export function withPiDefault({
  fallback,
  pi,
}: {
  fallback: AgentBackendProvider
  pi: PiBackendProvider
}): AgentBackendProvider {
  return {
    id: `pi+${fallback.id}`,
    sessionBackendId: (sessionId) => sessionBackendId({ sessionId, fallback, pi }),
    getBackend(directory) {
      return composite(fallback.getBackend(directory), pi, true)
    },
    async initializeForDirectory(directory, options) {
      let started: Promise<AgentBackend | null> | undefined
      const ensureFallback = () => {
        started ??= fallback
          .initializeForDirectory(directory, options)
          .then((getFallback) => (getFallback instanceof Error ? null : getFallback()))
        return started
      }
      return () => composite(fallback.getBackend(directory), pi, true, ensureFallback)
    },
    subscribeEvents({ signal }) {
      return mergedEvents(fallback, pi, { signal })
    },
    onStarted(listener) {
      fallback.onStarted(listener)
    },
  }
}
