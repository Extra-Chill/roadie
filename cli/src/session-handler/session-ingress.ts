// session ingress operations used by ThreadSessionRuntime.

import {
  cancelSessionSleepForThread,
  getThreadParentSessionId,
  setThreadParentSessionId,
} from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  applyChannelPolicyToIngress,
  applyPersonToIngress,
  maybeConvertLeadingCommand,
  type EnqueueResult,
  type IngressInput,
} from './ingress-input.js'
import { waitForCurrentThreadIngress } from './thread-ingress.js'
import * as threadState from './thread-runtime-state.js'
import type { ThreadSessionRuntime } from './thread-session-runtime.js'

const logger = createLogger(LogPrefix.SESSION)

// Explicit dependencies keep orchestration and resource ownership in the runtime.
type RuntimeContext = {
  threadId: ThreadSessionRuntime['threadId']
  supersedePendingSleep: ThreadSessionRuntime['supersedePendingSleep']
  messageQueue: ThreadSessionRuntime['messageQueue']
  chat: ThreadSessionRuntime['chat']
  channelId: ThreadSessionRuntime['channelId']
  ensureParentSessionId: ThreadSessionRuntime['ensureParentSessionId']
  enqueueWithPreprocess: ThreadSessionRuntime['enqueueWithPreprocess']
  enqueueViaLocalQueue: ThreadSessionRuntime['enqueueViaLocalQueue']
  submitToSession: ThreadSessionRuntime['submitToSession']
  state: ThreadSessionRuntime['state']
  preprocessChain: ThreadSessionRuntime['preprocessChain']
}

export async function supersedePendingSleep(
  runtime: Pick<RuntimeContext, 'threadId'>,
  input: IngressInput,
): Promise<void> {
  if (input.isSleepWake || input.contextOnly) return
  await cancelSessionSleepForThread({ threadId: runtime.threadId }).catch((error) => {
    logger.error('[SLEEP] failed to cancel pending sleep:', error)
  })
}

export async function enqueueViaLocalQueue(
  runtime: Pick<RuntimeContext, 'supersedePendingSleep' | 'messageQueue'>,
  input: IngressInput,
): Promise<EnqueueResult> {
  await runtime.supersedePendingSleep(input)
  return runtime.messageQueue.enqueueViaLocalQueue(input)
}

export async function enqueueIncoming(
  runtime: Pick<
    RuntimeContext,
    | 'chat'
    | 'channelId'
    | 'threadId'
    | 'ensureParentSessionId'
    | 'enqueueWithPreprocess'
    | 'enqueueViaLocalQueue'
    | 'submitToSession'
  >,
  input: IngressInput,
): Promise<EnqueueResult> {
  await waitForCurrentThreadIngress()
  if (input.contextOnly) input = { ...input, noReply: true }
  input = applyPersonToIngress({ ...input, actorPlatform: runtime.chat.platform })
  input = applyChannelPolicyToIngress({
    input: { ...input, actorPlatform: runtime.chat.platform },
    channelId: runtime.channelId || runtime.chat.parentId || runtime.threadId,
  })
  if (!input.contextOnly) threadState.setSessionUsername(runtime.threadId, input.username)
  const botUserId = runtime.chat.botUserId
  if (!input.contextOnly && input.userId && input.userId !== botUserId) {
    threadState.setSessionUserId(runtime.threadId, input.userId)
  }
  await runtime.ensureParentSessionId({
    parentSessionId: input.parentSessionId,
  })

  // When a preprocessor is provided, we must resolve it inside
  // dispatchAction before we know the final mode for routing.
  if (input.preprocess) {
    return runtime.enqueueWithPreprocess(input)
  }
  // If the prompt starts with `/cmdname ...` (and no explicit command is
  // already set), rewrite it into a command invocation so it goes through
  // the session command API instead of being sent to the model as
  // plain text. Covers Discord chat messages, /new-session, CLI
  // `roadie send --prompt`, and scheduled tasks — all funnel through here.
  if (!input.contextOnly) input = maybeConvertLeadingCommand(input)
  if (input.mode === 'local-queue') {
    return runtime.enqueueViaLocalQueue(input)
  }
  if (input.command) {
    // Commands wait in the local queue until the current run finishes.
    return runtime.enqueueViaLocalQueue(input)
  }
  return runtime.submitToSession(input)
}

export async function ensureParentSessionId(
  runtime: Pick<RuntimeContext, 'state' | 'threadId'>,
  {
    parentSessionId,
  }: {
    parentSessionId?: string
  },
) {
  if (runtime.state?.parentSessionId) {
    return
  }

  const storedParentSessionId = await getThreadParentSessionId(runtime.threadId)
  if (storedParentSessionId) {
    threadState.setParentSessionId(runtime.threadId, storedParentSessionId)
    return
  }

  if (!parentSessionId) {
    return
  }

  threadState.setParentSessionId(runtime.threadId, parentSessionId)
  // Row may not exist yet on first ingress before ensureSession creates it.
  // Best-effort write; ensureSession path also persists after setThreadSession.
  await setThreadParentSessionId({
    threadId: runtime.threadId,
    parentSessionId,
  }).catch((error) => {
    logger.warn(
      `[PARENT SESSION] Failed to persist parent session for thread ${runtime.threadId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

export async function enqueueWithPreprocess(
  runtime: Pick<
    RuntimeContext,
    'preprocessChain' | 'threadId' | 'submitToSession' | 'enqueueViaLocalQueue'
  >,
  input: IngressInput,
): Promise<EnqueueResult> {
  // Deferred result: the chain link resolves/rejects this promise.
  let resolveOuter!: (value: EnqueueResult | PromiseLike<EnqueueResult>) => void
  let rejectOuter!: (reason: unknown) => void
  const resultPromise = new Promise<EnqueueResult>((resolve, reject) => {
    resolveOuter = resolve
    rejectOuter = reject
  })

  // Chain preprocess + enqueue calls so they run in arrival order but
  // outside dispatchAction. The chain awaits the full enqueue (including
  // ensureSession / setThreadSession) before releasing to the next
  // message, so session-creation races on fresh threads are avoided.
  // The chain itself never rejects (catch + resolve via rejectOuter)
  // so the next link always runs.
  runtime.preprocessChain = runtime.preprocessChain.then(async () => {
    try {
      const result = await input.preprocess!()
      if (result.skip) {
        resolveOuter({ queued: false })
        return
      }
      const resolvedInput: IngressInput = maybeConvertLeadingCommand({
        ...input,
        prompt: result.prompt,
        images: result.images,
        mode: result.mode,
        // Preprocessing may request an agent — apply it only if no
        // explicit agent was already set (CLI --agent flag wins).
        agent: input.agent || result.agent,
        repliedMessage: result.repliedMessage,
        preprocess: undefined,
      })

      const hasPromptText = resolvedInput.prompt.trim().length > 0
      const hasImages = (resolvedInput.images?.length || 0) > 0
      if (!hasPromptText && !hasImages && !resolvedInput.command) {
        logger.warn(
          `[INGRESS] Skipping empty preprocessed input threadId=${runtime.threadId}`,
        )
        resolveOuter({ queued: false })
        return
      }

      // Route with the resolved mode through normal paths.
      // Await the enqueue so session state (ensureSession, setThreadSession)
      // is persisted before the next message's preprocessing reads it.
      // noReply messages always go through direct submission so the flag
      // reaches promptAsync; local queue doesn't support noReply.
      const enqueueResult = resolvedInput.noReply
        ? await runtime.submitToSession({
            ...resolvedInput,
            mode: 'direct',
            command: undefined,
          })
        : resolvedInput.mode === 'local-queue' || resolvedInput.command
          ? await runtime.enqueueViaLocalQueue(resolvedInput)
          : await runtime.submitToSession(resolvedInput)
      resolveOuter(enqueueResult)
    } catch (err) {
      rejectOuter(err)
    }
  })

  return resultPromise
}
