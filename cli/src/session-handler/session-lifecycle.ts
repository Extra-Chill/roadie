// session lifecycle operations used by ThreadSessionRuntime.

import { getAgentBackendProvider, isRetiredSession } from '../agent-backend/registry.js'
import type { AgentBackendGetter } from '../agent-backend/types.js'
import { applicationDirectory } from '../channel-policy.js'
import {
  getThreadSession,
  getThreadWorkingDirectory,
  setSessionAgent,
  setSessionStartSource,
  setThreadParentSessionId,
  setThreadSession,
} from '../database.js'
import { AgentBackendError, DiscordOperationError } from '../errors.js'
import { writeInjectionGuardConfig } from '../injection-guard-config.js'
import { createLogger, LogPrefix } from '../logger.js'
import { asSubtext } from '../message-formatting.js'
import { resolveSessionPermissionRules } from '../permission-policy.js'
import { markPendingSessionTitle } from '../session-title.js'
import * as threadState from './thread-runtime-state.js'
import type { ThreadSessionRuntime } from './thread-session-runtime.js'

const logger = createLogger(LogPrefix.SESSION)

// Explicit dependencies keep orchestration and resource ownership in the runtime.
type RuntimeContext = {
  sdkDirectory: ThreadSessionRuntime['sdkDirectory']
  thread: ThreadSessionRuntime['thread']
  channelId: ThreadSessionRuntime['channelId']
  state: ThreadSessionRuntime['state']
  seedFromRetiredSession: ThreadSessionRuntime['seedFromRetiredSession']
  threadId: ThreadSessionRuntime['threadId']
  hydrateSessionEventsFromDatabase: ThreadSessionRuntime['hydrateSessionEventsFromDatabase']
  chat: ThreadSessionRuntime['chat']
}

export async function ensureSession(
  runtime: Pick<
    RuntimeContext,
    | 'sdkDirectory'
    | 'thread'
    | 'channelId'
    | 'state'
    | 'seedFromRetiredSession'
    | 'threadId'
    | 'hydrateSessionEventsFromDatabase'
  >,
  {
    prompt,
    agent,
    permissions,
    injectionGuardPatterns,
    sourceMessageId,
    sessionStartScheduleKind,
    sessionStartScheduledTaskId,
  }: {
    prompt: string
    agent?: string
    /** Raw "tool:action" strings from --permission flag */
    permissions?: string[]
    injectionGuardPatterns?: string[]
    /** Chat message that started this turn; left out of a retired-session seed. */
    sourceMessageId?: string
    sessionStartScheduleKind?: 'at' | 'cron'
    sessionStartScheduledTaskId?: number
  },
): Promise<
  | Error
  | {
      session: { id: string; title: string }
      getClient: AgentBackendGetter
      createdNewSession: boolean
    }
> {
  const directory = runtime.sdkDirectory

  // A thread in a separate git checkout is kept out of the origin checkout.
  // A project subfolder is not: its project root contains it.
  const threadDir = applicationDirectory()
    ? undefined
    : await getThreadWorkingDirectory(runtime.thread.id)
  const originalRepoDirectory =
    threadDir?.kind === 'git-worktree' ? threadDir.projectDirectory : undefined

  const getClientResult = await getAgentBackendProvider().initializeForDirectory(
    directory,
    {
      originalRepoDirectory,
      channelId: runtime.channelId,
    },
  )
  if (getClientResult instanceof Error) return getClientResult
  const getClient = getClientResult

  // Check thread state for existing session ID
  let sessionId = runtime.state?.sessionId
  if (!sessionId) {
    // Fallback to DB
    sessionId = (await getThreadSession(runtime.thread.id)) || undefined
  }
  // A session the backend does not own is retired, not resumed: the thread
  // moves to a new session, seeded from its chat history below.
  let retiredSessionId: string | undefined
  if (sessionId && isRetiredSession(sessionId)) {
    retiredSessionId = sessionId
    sessionId = undefined
  }

  let session: { id: string; title: string } | undefined
  let createdNewSession = false

  if (sessionId) {
    const sessionResponse = await getClient().sessions.get({
      sessionId,
      directory: runtime.sdkDirectory,
    })
    if (sessionResponse instanceof Error) {
      logger.warn(
        `[ENSURE SESSION] Failed to get existing session ${sessionId}: ${sessionResponse.message}`,
      )
    } else if (sessionResponse) {
      session = sessionResponse
    } else {
      logger.warn(`[ENSURE SESSION] session.get returned no data for ${sessionId}`)
    }
  }

  if (!session) {
    // Roadie's rules for the session: checkout isolation, then requested
    // rules (send, channel policy, identity), then plugins. Later rules win.
    const sessionPermissions = resolveSessionPermissionRules({
      directory: runtime.sdkDirectory,
      originalRepoDirectory,
      requested: permissions,
      phase: 'create',
    })
    // Untitled: the first task names it (markPendingSessionTitle below).
    const createResult = await getClient().sessions.create({
      directory: runtime.sdkDirectory,
      permission: sessionPermissions,
    })
    if (createResult instanceof Error) {
      logger.error(
        `[ENSURE SESSION] session.create failed: ${createResult.message}, threadId=${runtime.thread.id}, directory=${runtime.sdkDirectory}`,
      )
      return new Error(
        `Failed to create session: ${createResult.message}, threadId=${runtime.thread.id}, directory=${runtime.sdkDirectory}`,
        { cause: createResult },
      )
    }
    session = createResult
    // Insert DB row immediately so the external-sync poller sees
    // source='roadie' before the next poll tick and skips this session.
    // The upsert at the end of ensureSession is kept for the reuse path.
    await setThreadSession(runtime.thread.id, session.id)
    await markPendingSessionTitle(session)
    if (injectionGuardPatterns?.length) {
      writeInjectionGuardConfig({
        sessionId: session.id,
        scanPatterns: injectionGuardPatterns,
      })
    }
    createdNewSession = true
    if (retiredSessionId) {
      await runtime.seedFromRetiredSession({
        client: getClient(),
        sessionId: session.id,
        retiredSessionId,
        sourceMessageId,
      })
    }
  }

  // Store session in DB and thread state
  await setThreadSession(runtime.thread.id, session.id)
  threadState.setSessionId(runtime.threadId, session.id)
  // Parent may have been set on ingress before the thread_sessions row
  // existed; write it now that the row is guaranteed.
  const parentSessionId = runtime.state?.parentSessionId
  if (parentSessionId) {
    await setThreadParentSessionId({
      threadId: runtime.thread.id,
      parentSessionId,
    }).catch((error) => {
      logger.warn(
        `[PARENT SESSION] Failed to persist parent session for thread ${runtime.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }
  await runtime.hydrateSessionEventsFromDatabase({ sessionId: session.id })

  // Store session start source for scheduled tasks
  if (createdNewSession && sessionStartScheduleKind) {
    const sessionStartSourceResult = await setSessionStartSource({
      sessionId: session.id,
      scheduleKind: sessionStartScheduleKind,
      scheduledTaskId: sessionStartScheduledTaskId,
    }).catch(
      (e) => new AgentBackendError({ operation: 'setSessionStartSource', cause: e }),
    )
    if (sessionStartSourceResult instanceof Error) {
      logger.warn(`[SESSION START SOURCE] ${sessionStartSourceResult.message}`)
    }
  }

  // Store agent preference if provided
  if (agent && createdNewSession) {
    await setSessionAgent(session.id, agent)
  }

  return { session, getClient, createdNewSession }
}

export async function sendNewSessionModelInfo(
  runtime: Pick<RuntimeContext, 'chat'>,
  {
    createdNewSession,
    model,
    agent,
  }: {
    createdNewSession: boolean
    model: { providerID: string; modelID: string }
    agent?: string
  },
): Promise<void> {
  if (!createdNewSession) {
    return
  }

  const modelLabel = `${model.providerID}/${model.modelID}`
  const agentLabel = agent && agent.toLowerCase() !== 'build' ? ` ⋅ ${agent}` : ''
  const result = await runtime.chat
    .sendMessage(asSubtext(`*using ${modelLabel}${agentLabel}*`))
    .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
  if (result instanceof Error) {
    logger.warn(`[SESSION INFO] Failed to send model info: ${result.message}`)
  }
}
