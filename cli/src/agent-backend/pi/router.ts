// Per-channel Pi opt-in (#51): threads in opted-in channels create their
// sessions in Pi; everything else stays on the default backend.
//
// Session operations route by session id, so a Pi session keeps working
// wherever Roadie reaches it (permission buttons, /abort, CLI) even through
// `getBackend(directory)`, which carries no channel. Directory-wide listings
// merge both backends. Event streams are merged.

import type { AgentSessionMessage } from '../types.js'
import {
  AgentRequestError,
  type AgentBackend,
  type AgentBackendEvent,
  type AgentBackendProvider,
  type AgentSessionOperations,
} from '../types.js'
import type { PiBackendProvider } from './backend.js'

type Ops = AgentSessionOperations

function routedSessions({
  fallback,
  pi,
  createInPi,
}: {
  fallback: AgentBackend | null
  pi: PiBackendProvider
  createInPi: boolean
}): AgentSessionOperations {
  const piOps = pi.getBackend().sessions
  const pick = (sessionId: string): Ops | Error => {
    if (pi.owns(sessionId)) return piOps
    return fallback?.sessions ?? new AgentRequestError({ detail: 'Agent backend is unavailable' })
  }
  const bySession = <K extends keyof Ops>(name: K) =>
    (async (input: { sessionId: string }, ...rest: unknown[]) => {
      const ops = pick(input.sessionId)
      if (ops instanceof Error) return ops
      const fn = ops[name] as ((...args: unknown[]) => Promise<unknown>) | undefined
      if (!fn) return new AgentRequestError({ detail: `This session's backend does not support ${String(name)}` })
      return fn(input, ...rest)
    }) as unknown as NonNullable<Ops[K]>

  return {
    generateTitle: (input) => (createInPi || !fallback?.sessions.generateTitle
      ? Promise.resolve(new AgentRequestError({ detail: 'Title generation is not available for Pi sessions' }))
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
      return fallback ? fallback.sessions.replyPermission(input) : piResult
    },
    status: async (input) => {
      const [own, other] = await Promise.all([piOps.status(input), fallback?.sessions.status(input)])
      if (other instanceof Error) return other
      return { ...(other ?? {}), ...(own instanceof Error ? {} : own) }
    },
    list: async (input) => {
      const [own, other] = await Promise.all([piOps.list(input), fallback?.sessions.list(input)])
      if (other instanceof Error && own instanceof Error) return other
      return [...(other instanceof Error ? [] : other ?? []), ...(own instanceof Error ? [] : own)]
    },
    delete: bySession('delete'),
    fork: bySession('fork'),
    setTitle: bySession('setTitle'),
    summarize: bySession('summarize'),
    messagePage: async (input) => {
      const ops = pick(input.sessionId)
      if (ops instanceof Error) return ops
      if (ops.messagePage) return ops.messagePage(input)
      const all = await ops.messages(input)
      return all instanceof Error ? all : { messages: all as AgentSessionMessage[] }
    },
    questions: async (input) => (fallback?.sessions.questions ? fallback.sessions.questions(input) : []),
    replyQuestion: async (input) => (fallback?.sessions.replyQuestion
      ? fallback.sessions.replyQuestion(input)
      : new AgentRequestError({ detail: 'Questions are not supported' })),
  }
}

function composite(fallback: AgentBackend | null, pi: PiBackendProvider, piChannel: boolean): AgentBackend {
  const base = piChannel || !fallback ? pi.getBackend() : fallback
  return {
    ...base,
    sessions: routedSessions({ fallback, pi, createInPi: piChannel }),
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
      const primary = fallback.subscribeEvents({ signal })
      return (async () => {
        const piEvents = await pi.subscribeEvents({ signal })
        const resolved = primary ? await primary : undefined
        // The default backend is down: keep Pi events flowing until it starts.
        if (resolved instanceof Error) return merge(undefined, piEvents, signal)
        return merge(resolved, piEvents, signal)
      })()
    },
    onStarted(listener) {
      fallback.onStarted(listener)
    },
  }
}
