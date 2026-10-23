// session submission operations used by ThreadSessionRuntime.

import {
  agentBackendLabel,
  getAgentBackendProvider,
  isRetiredSession,
} from '../agent-backend/registry.js'
import type { AgentBackendGetter } from '../agent-backend/types.js'
import { AgentRequestError, type AgentPromptPart } from '../agent-backend/types.js'
import { applicationDirectory } from '../channel-policy.js'
import {
  ensureSessionPreferencesSnapshot,
  getCurrentModelInfo,
} from '../commands/model.js'
import { resolvePersonBillingPool } from '../credentials/person-pool.js'
import {
  clearSessionModel,
  getSessionForkOrigin,
  getSessionTurnAttribution,
  getThreadSession,
  getThreadWorkingDirectory,
  getVariantCascade,
  recordCredentialOwner,
  recordCredentialPayerNotice,
  setSessionAgent,
  setSessionModel,
  setSessionTurnAttribution,
  startScheduledTaskRunSession,
} from '../database.js'
import { AgentBackendError } from '../errors.js'
import { createLogger, LogPrefix } from '../logger.js'
import { asSubtext } from '../message-formatting.js'
import { notifyError } from '../sentry.js'
import { schedulePendingSessionTitle, sessionTitlePrompt } from '../session-title.js'
import { store } from '../store.js'
import { getPromptContext, systemPromptNamesOtherSession } from '../system-message.js'
import { getThinkingValuesForModel, matchThinkingValue } from '../thinking-utils.js'
import { isAbortError } from '../utils.js'
import { resolveValidatedAgentPreference } from './agent-utils.js'
import { waitForGlobalEventListener } from './global-event-listener.js'
import { type EnqueueResult, type IngressInput } from './ingress-input.js'
import { validateModelId } from './model-utils.js'
import { toPromptFilePart } from './runtime-helpers.js'
import { releaseCurrentThreadIngress } from './thread-ingress.js'
import type { QueuedMessage } from './thread-runtime-state.js'
import type { ThreadSessionRuntime } from './thread-session-runtime.js'

const logger = createLogger(LogPrefix.SESSION)
const discordLogger = createLogger(LogPrefix.DISCORD)

// Explicit dependencies keep orchestration and resource ownership in the runtime.
type RuntimeContext = {
  supersedePendingSleep: ThreadSessionRuntime['supersedePendingSleep']
  dispatchAction: ThreadSessionRuntime['dispatchAction']
  state: ThreadSessionRuntime['state']
  threadId: ThreadSessionRuntime['threadId']
  isBusy: ThreadSessionRuntime['isBusy']
  permissionOwner: ThreadSessionRuntime['permissionOwner']
  thread: ThreadSessionRuntime['thread']
  sdkDirectory: ThreadSessionRuntime['sdkDirectory']
  channelId: ThreadSessionRuntime['channelId']
  chat: ThreadSessionRuntime['chat']
  typing: ThreadSessionRuntime['typing']
  messageQueue: ThreadSessionRuntime['messageQueue']
  ensureSession: ThreadSessionRuntime['ensureSession']
  registerSpeakerMcpServers: ThreadSessionRuntime['registerSpeakerMcpServers']
  updateExistingSessionPermissions: ThreadSessionRuntime['updateExistingSessionPermissions']
  persistIngressVariant: ThreadSessionRuntime['persistIngressVariant']
  sendNewSessionModelInfo: ThreadSessionRuntime['sendNewSessionModelInfo']
  resolveTurnSystemPrompt: ThreadSessionRuntime['resolveTurnSystemPrompt']
  consumeWorkingDirectoryPromptChange: ThreadSessionRuntime['consumeWorkingDirectoryPromptChange']
  getParentSessionIdMissingFromSystem: ThreadSessionRuntime['getParentSessionIdMissingFromSystem']
  resolveTurnContext: ThreadSessionRuntime['resolveTurnContext']
  recordTurnAttribution: ThreadSessionRuntime['recordTurnAttribution']
  disposed: ThreadSessionRuntime['disposed']
  markPendingDelivery: ThreadSessionRuntime['markPendingDelivery']
  pendingDeliveryMessageIds: ThreadSessionRuntime['pendingDeliveryMessageIds']
  setPendingReaction: ThreadSessionRuntime['setPendingReaction']
  markQueueDispatchBusy: ThreadSessionRuntime['markQueueDispatchBusy']
  enqueueViaLocalQueue: ThreadSessionRuntime['enqueueViaLocalQueue']
  lastDisplayedContextPercentage: ThreadSessionRuntime['lastDisplayedContextPercentage']
  lastRateLimitDisplayTime: ThreadSessionRuntime['lastRateLimitDisplayTime']
  lastSentPartKind: ThreadSessionRuntime['lastSentPartKind']
  ensureModelContextLimit: ThreadSessionRuntime['ensureModelContextLimit']
  postPayerChangeNoticeOnce: ThreadSessionRuntime['postPayerChangeNoticeOnce']
}

export async function submitToSession(
  runtime: Pick<
    RuntimeContext,
    | 'supersedePendingSleep'
    | 'dispatchAction'
    | 'state'
    | 'threadId'
    | 'isBusy'
    | 'permissionOwner'
    | 'thread'
    | 'sdkDirectory'
    | 'channelId'
    | 'chat'
    | 'typing'
    | 'messageQueue'
    | 'ensureSession'
    | 'registerSpeakerMcpServers'
    | 'updateExistingSessionPermissions'
    | 'persistIngressVariant'
    | 'sendNewSessionModelInfo'
    | 'resolveTurnSystemPrompt'
    | 'consumeWorkingDirectoryPromptChange'
    | 'getParentSessionIdMissingFromSystem'
    | 'resolveTurnContext'
    | 'recordTurnAttribution'
    | 'disposed'
    | 'markPendingDelivery'
    | 'pendingDeliveryMessageIds'
    | 'setPendingReaction'
    | 'markQueueDispatchBusy'
    | 'enqueueViaLocalQueue'
  >,
  input: IngressInput,
): Promise<EnqueueResult> {
  await runtime.supersedePendingSleep(input)
  let skippedBySessionGuard = false
  let deferPiTurn = false

  await runtime.dispatchAction(async () => {
    if (input.expectedSessionId && runtime.state?.sessionId !== input.expectedSessionId) {
      logger.log(
        `[ENQUEUE] Skipping stale promptAsync enqueue for thread ${runtime.threadId}: expected session ${input.expectedSessionId}, current session ${runtime.state?.sessionId || 'none'}`,
      )
      skippedBySessionGuard = true
      return
    }

    // Pi steering shares the running model turn, so it stays with that
    // turn's speaker. Another speaker's message waits for the turn to
    // settle, keeping each speaker's permissions (including person-MCP).
    if (
      !input.noReply &&
      runtime.isBusy() &&
      (input.personId ?? input.userId) !== runtime.permissionOwner
    ) {
      deferPiTurn = true
      return
    }

    // Context-only messages (noReply) should not create a new session.
    // If there is no existing session, silently skip.
    if (input.noReply) {
      const existingSessionId =
        runtime.state?.sessionId ||
        (await getThreadSession(runtime.thread.id)) ||
        undefined
      if (!existingSessionId) {
        logger.log(
          `[INGRESS] Skipping noReply message for thread ${runtime.threadId}: no existing session`,
        )
        return
      }
      // A retired session (one the backend does not own) takes no context:
      // the next real prompt moves the thread, and its seed reads this
      // message from the chat.
      if (isRetiredSession(existingSessionId)) {
        logger.log(
          `[INGRESS] Skipping noReply message for thread ${runtime.threadId}: session ${existingSessionId} is retired`,
        )
        return
      }
      if (input.contextOnly) {
        const backend = await getAgentBackendProvider().initializeForDirectory(
          runtime.sdkDirectory,
          { channelId: runtime.channelId },
        )
        if (backend instanceof Error) {
          logger.warn(`[CONTEXT] Cannot record message: ${backend.message}`)
          return
        }
        const history = await backend().sessions.messages({
          sessionId: existingSessionId,
          directory: runtime.sdkDirectory,
        })
        if (history instanceof Error) {
          logger.warn(`[CONTEXT] Cannot resolve existing preferences: ${history.message}`)
          return
        }
        const previous = history.findLast(
          (entry) => entry.message.role === 'user',
        )?.message
        const context = getPromptContext({
          platform: runtime.chat.platform,
          sessionId: existingSessionId,
          backend: agentBackendLabel(),
          threadId: runtime.threadId,
          username: input.username,
          userId: input.userId,
          sourceMessageId: input.sourceMessageId,
          sourceThreadId: input.sourceThreadId,
          threadName: runtime.chat.name || undefined,
          repliedMessage: input.repliedMessage,
        })
        const parts: AgentPromptPart[] = [
          { kind: 'text', text: input.prompt },
          { kind: 'text', text: context, synthetic: true },
          ...(input.images ?? []).map(
            (file): AgentPromptPart => ({
              kind: 'file',
              mime: file.mime,
              url: file.url,
              filename: file.filename,
            }),
          ),
        ]
        const recorded = await backend().sessions.prompt({
          sessionId: existingSessionId,
          directory: runtime.sdkDirectory,
          parts,
          noReply: true,
          agent: previous?.agent,
          model: previous?.model,
          system: previous?.system,
        })
        if (recorded instanceof Error)
          logger.warn(`[CONTEXT] Cannot record message: ${recorded.message}`)
        return
      }
    }

    // Helper: stop typing and drain queued local messages on error.
    const cleanupOnError = async (errorMessage: string) => {
      runtime.typing.stopTyping()
      await runtime.chat.sendMessage(errorMessage, { notify: true })
      await runtime.messageQueue.tryDrainQueue({ showIndicator: true })
    }

    // ── Ensure session ──────────────────────────────────────
    const sessionResult = await runtime.ensureSession({
      prompt: input.prompt,
      agent: input.agent,
      permissions: input.permissions,
      injectionGuardPatterns: input.injectionGuardPatterns,
      sourceMessageId: input.sourceMessageId,
      sessionStartScheduleKind: input.sessionStartSource?.scheduleKind,
      sessionStartScheduledTaskId: input.sessionStartSource?.scheduledTaskId,
    })
    if (sessionResult instanceof Error) {
      await cleanupOnError(`✗ ${sessionResult.message}`)
      return
    }

    const { session, getClient, createdNewSession } = sessionResult
    schedulePendingSessionTitle({
      session,
      prompt: sessionTitlePrompt(input),
      backend: getClient(),
      directory: runtime.sdkDirectory,
    })

    await runtime.registerSpeakerMcpServers({ client: getClient(), input })
    const updatePermissionsResult = await runtime.updateExistingSessionPermissions({
      client: getClient(),
      sessionId: session.id,
      permissions: input.permissions,
      noReply: input.noReply,
      owner: input.personId ?? input.userId,
    })
    if (updatePermissionsResult instanceof Error) {
      await cleanupOnError(
        `Failed to update session permissions: ${updatePermissionsResult.message}`,
      )
      return
    }

    // ── Resolve model + agent preferences (mirrors dispatchPrompt) ──
    const channelId = runtime.channelId
    const resolvedAppId = input.appId

    // Explicit agent prompts (for example /plan-agent <prompt>) must update
    // the session preference before dispatch. Otherwise the model can resolve
    // from the requested agent while Pi keeps running the old agent.
    if (input.agent) {
      await setSessionAgent(session.id, input.agent)
      await clearSessionModel(session.id)
    }

    if (input.model) {
      const validatedModel = await validateModelId({
        model: input.model,
        getClient,
        directory: runtime.sdkDirectory,
      })
      if (validatedModel instanceof Error) {
        await cleanupOnError(`Failed to resolve model: ${validatedModel.message}`)
        return
      }
    }

    await ensureSessionPreferencesSnapshot({
      sessionId: session.id,
      channelId,
      appId: resolvedAppId,
      getClient,
      directory: runtime.sdkDirectory,
      agentOverride: input.agent,
      modelOverride: input.model,
      force: createdNewSession,
    })

    const agentResult = await resolveValidatedAgentPreference({
      agent: input.agent,
      sessionId: session.id,
      channelId,
      getClient,
      directory: runtime.sdkDirectory,
    }).catch((e) => new AgentBackendError({ operation: 'resolveAgent', cause: e }))
    if (agentResult instanceof Error) {
      await cleanupOnError(`Failed to resolve agent: ${agentResult.message}`)
      return
    }
    const resolvedAgent = agentResult.agentPreference
    const availableAgents = agentResult.agents
    releaseCurrentThreadIngress()

    await runtime.persistIngressVariant({
      sessionId: session.id,
      channelId,
      appId: resolvedAppId,
      agentPreference: resolvedAgent,
      getClient,
      variant: input.variant,
    })

    const [modelResult, preferredVariant] = await Promise.all([
      (async () => {
        if (input.model) {
          return validateModelId({
            model: input.model,
            getClient,
            directory: runtime.sdkDirectory,
          })
        }
        const modelInfo = await getCurrentModelInfo({
          sessionId: session.id,
          channelId,
          appId: resolvedAppId,
          agentPreference: resolvedAgent,
          getClient,
          directory: runtime.sdkDirectory,
        })
        if (modelInfo.type === 'none') {
          return undefined
        }
        return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
      })().catch(
        (e) => new AgentBackendError({ operation: 'resolveModelPreference', cause: e }),
      ),
      getVariantCascade({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
      }),
    ])
    if (modelResult instanceof Error) {
      await cleanupOnError(`Failed to resolve model: ${modelResult.message}`)
      return
    }
    const modelField = modelResult
    if (!modelField) {
      await cleanupOnError(
        'No model account available. Add an account to the credential pool with `/credentials add`.',
      )
      return
    }

    // Resolve thinking variant
    const thinkingValue = await (async (): Promise<string | undefined> => {
      if (!preferredVariant) {
        return undefined
      }
      const catalog = await getClient().catalog.providers({
        directory: runtime.sdkDirectory,
      })
      if (catalog instanceof Error) {
        return undefined
      }
      const availableValues = getThinkingValuesForModel({
        providers: catalog.providers,
        providerId: modelField.providerID,
        modelId: modelField.modelID,
      })
      if (availableValues.length === 0) {
        return undefined
      }
      return (
        matchThinkingValue({
          requestedValue: preferredVariant,
          availableValues,
        }) || undefined
      )
    })()

    const variantField = thinkingValue ? { variant: thinkingValue } : {}

    await runtime.sendNewSessionModelInfo({
      createdNewSession,
      model: modelField,
      agent: resolvedAgent,
    })

    // ── Build prompt parts ──────────────────────────────────
    const images = input.images || []
    const promptWithImagePaths = (() => {
      if (images.length === 0) {
        return input.prompt
      }
      const imageList = images
        .map((img) => {
          return `- ${img.sourceUrl || img.filename}`
        })
        .join('\n')
      return `${input.prompt}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${imageList}`
    })()

    // ── Working directory + channel topic for per-turn prompt context ──
    const workingDirectory = applicationDirectory()
      ? undefined
      : await getThreadWorkingDirectory(runtime.thread.id)

    const channelTopic = await runtime.chat.channelTopic(channelId)
    const system = await runtime.resolveTurnSystemPrompt({
      sessionId: session.id,
      channelTopic,
      agents: availableAgents,
      input,
    })
    if (system instanceof Error) {
      await cleanupOnError(`✗ Failed to prepare system prompt: ${system.message}`)
      return
    }
    const workingDirectoryChanged =
      runtime.consumeWorkingDirectoryPromptChange(workingDirectory)
    const syntheticContext = getPromptContext({
      platform: runtime.chat.platform,
      sessionId: session.id,
      backend: agentBackendLabel(),
      threadId: runtime.thread.id,
      username: input.username,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      sourceThreadId: input.sourceThreadId || runtime.thread.id,
      threadName: runtime.chat.name || undefined,
      repliedMessage: input.repliedMessage,
      workingDirectory,
      currentAgent: resolvedAgent,
      workingDirectoryChanged,
      systemPromptFromSourceSession: systemPromptNamesOtherSession({
        system,
        sessionId: session.id,
      }),
      forkOrigin: await getSessionForkOrigin(session.id),
      parentSessionId: runtime.getParentSessionIdMissingFromSystem({ system, input }),
    })
    const turnContext = await runtime.resolveTurnContext({
      sessionId: session.id,
      input,
      isFirstTurn: createdNewSession,
    })
    const parts: AgentPromptPart[] = [
      { kind: 'text', text: promptWithImagePaths },
      { kind: 'text', text: syntheticContext, synthetic: true },
      ...(turnContext
        ? [{ kind: 'text' as const, text: turnContext, synthetic: true }]
        : []),
      ...images.map(toPromptFilePart),
    ]

    await runtime.recordTurnAttribution({ sessionId: session.id, input })
    await waitForGlobalEventListener()
    // Disposed while preparing (thread deleted, backend restarting or
    // shutting down): the backend may no longer own this session, so the
    // prompt must not be sent anywhere.
    if (runtime.disposed) {
      logger.log(
        `[DISPATCH] Runtime disposed before prompt was sent sessionId=${session.id}`,
      )
      return
    }
    // A busy session takes this prompt at its next step boundary; the
    // running step is never aborted. Only /abort stops a run.
    // Marked before sending so a fast pickup event can't arrive first.
    const pendingMessageId =
      runtime.isBusy() && !input.noReply ? input.sourceMessageId : undefined
    if (pendingMessageId) {
      runtime.markPendingDelivery(pendingMessageId)
    } else if (
      !input.noReply &&
      input.sourceMessageId &&
      input.sourceChannelId === runtime.threadId
    ) {
      // A new turn: its first reply answers the message that started it.
      // Only inline channel conversations implement anchoring.
      runtime.chat.setReplyAnchor?.(input.sourceMessageId)
    }
    const promptResult = await getClient().sessions.prompt({
      sessionId: session.id,
      directory: runtime.sdkDirectory,
      parts,
      system,
      ...(resolvedAgent ? { agent: resolvedAgent } : {}),
      ...(modelField
        ? { model: { providerId: modelField.providerID, modelId: modelField.modelID } }
        : {}),
      ...(variantField.variant ? { variant: variantField.variant } : {}),
      ...(input.noReply ? { noReply: true } : {}),
    })
    if (promptResult instanceof Error) {
      if (pendingMessageId) {
        runtime.pendingDeliveryMessageIds = runtime.pendingDeliveryMessageIds.filter(
          (id) => id !== pendingMessageId,
        )
        void runtime.setPendingReaction(pendingMessageId, false)
      }
      void notifyError(promptResult, 'promptAsync failed in submitToSession')
      await cleanupOnError(`✗ Agent error: ${promptResult.message}`)
      return
    }

    if (input.sessionStartSource?.scheduledTaskRunId) {
      await startScheduledTaskRunSession({
        runId: input.sessionStartSource.scheduledTaskRunId,
        sessionId: session.id,
        projectDirectory: runtime.sdkDirectory,
      })
    }

    logger.log(
      `[INGRESS] promptAsync accepted by ${getAgentBackendProvider().id} queue sessionId=${session.id} threadId=${runtime.threadId}`,
    )

    // noReply messages don't trigger the agent loop, so don't mark as busy
    if (!input.noReply) {
      runtime.markQueueDispatchBusy(session.id)
    }
  })

  if (deferPiTurn) return runtime.enqueueViaLocalQueue(input)
  if (skippedBySessionGuard) {
    return { queued: false }
  }
  return { queued: false }
}

export async function dispatchPrompt(
  runtime: Pick<
    RuntimeContext,
    | 'lastDisplayedContextPercentage'
    | 'lastRateLimitDisplayTime'
    | 'lastSentPartKind'
    | 'ensureSession'
    | 'typing'
    | 'chat'
    | 'sdkDirectory'
    | 'registerSpeakerMcpServers'
    | 'updateExistingSessionPermissions'
    | 'channelId'
    | 'persistIngressVariant'
    | 'ensureModelContextLimit'
    | 'sendNewSessionModelInfo'
    | 'thread'
    | 'resolveTurnSystemPrompt'
    | 'consumeWorkingDirectoryPromptChange'
    | 'getParentSessionIdMissingFromSystem'
    | 'resolveTurnContext'
    | 'recordTurnAttribution'
    | 'disposed'
    | 'threadId'
  >,
  input: QueuedMessage,
): Promise<boolean> {
  runtime.lastDisplayedContextPercentage = 0
  runtime.lastRateLimitDisplayTime = 0
  runtime.lastSentPartKind = undefined

  // ── Ensure session ────────────────────────────────────────
  const sessionResult = await runtime.ensureSession({
    prompt: input.prompt,
    agent: input.agent,
    permissions: input.permissions,
    injectionGuardPatterns: input.injectionGuardPatterns,
    sourceMessageId: input.sourceMessageId,
    sessionStartScheduleKind: input.sessionStartScheduleKind,
    sessionStartScheduledTaskId: input.sessionStartScheduledTaskId,
  })
  if (sessionResult instanceof Error) {
    runtime.typing.stopTyping()
    await runtime.chat.sendMessage(`✗ ${sessionResult.message}`, { notify: true })
    // Show indicator: this dispatch failed, so the next queued message
    // has been waiting — the user needs to see which one is starting.
    return false
  }
  const { session, getClient, createdNewSession } = sessionResult
  schedulePendingSessionTitle({
    session,
    prompt: sessionTitlePrompt(input),
    backend: getClient(),
    directory: runtime.sdkDirectory,
  })

  await runtime.registerSpeakerMcpServers({ client: getClient(), input })
  const updatePermissionsResult = await runtime.updateExistingSessionPermissions({
    client: getClient(),
    sessionId: session.id,
    permissions: input.permissions,
    owner: input.personId ?? input.userId,
  })
  if (updatePermissionsResult instanceof Error) {
    runtime.typing.stopTyping()
    await runtime.chat.sendMessage(
      `Failed to update session permissions: ${updatePermissionsResult.message}`,
      { notify: true },
    )
    return false
  }

  // ── Resolve model + agent preferences ─────────────────────
  const channelId = runtime.channelId
  const resolvedAppId = input.appId

  // Explicit agent prompts (for example /plan-agent <prompt>) must update
  // the session preference before dispatch. Otherwise the model can resolve
  // from the requested agent while Pi keeps running the old agent.
  if (input.agent) {
    await setSessionAgent(session.id, input.agent)
    await clearSessionModel(session.id)
  }

  if (input.model) {
    const validatedModel = await validateModelId({
      model: input.model,
      getClient,
      directory: runtime.sdkDirectory,
    })
    if (validatedModel instanceof Error) {
      runtime.typing.stopTyping()
      await runtime.chat.sendMessage(
        `Failed to resolve model: ${validatedModel.message}`,
        { notify: true },
      )
      return false
    }
  }

  await ensureSessionPreferencesSnapshot({
    sessionId: session.id,
    channelId,
    appId: resolvedAppId,
    getClient,
    directory: runtime.sdkDirectory,
    agentOverride: input.agent,
    modelOverride: input.model,
    force: createdNewSession,
  })

  const earlyAgentResult = await resolveValidatedAgentPreference({
    agent: input.agent,
    sessionId: session.id,
    channelId,
    getClient,
    directory: runtime.sdkDirectory,
  }).catch((e) => new AgentBackendError({ operation: 'resolveAgent', cause: e }))
  if (earlyAgentResult instanceof Error) {
    runtime.typing.stopTyping()
    await runtime.chat.sendMessage(
      `Failed to resolve agent: ${earlyAgentResult.message}`,
      { notify: true },
    )
    return false
  }
  const earlyAgentPreference = earlyAgentResult.agentPreference
  const earlyAvailableAgents = earlyAgentResult.agents

  await runtime.persistIngressVariant({
    sessionId: session.id,
    channelId,
    appId: resolvedAppId,
    agentPreference: earlyAgentPreference,
    getClient,
    variant: input.variant,
  })

  const [earlyModelResult, preferredVariant] = await Promise.all([
    (async () => {
      if (input.model) {
        return validateModelId({
          model: input.model,
          getClient,
          directory: runtime.sdkDirectory,
        })
      }
      const modelInfo = await getCurrentModelInfo({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
        agentPreference: earlyAgentPreference,
        getClient,
        directory: runtime.sdkDirectory,
      })
      if (modelInfo.type === 'none') {
        return undefined
      }
      return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
    })().catch(
      (e) => new AgentBackendError({ operation: 'resolveModelPreference', cause: e }),
    ),
    getVariantCascade({
      sessionId: session.id,
      channelId,
      appId: resolvedAppId,
    }),
  ])
  if (earlyModelResult instanceof Error) {
    runtime.typing.stopTyping()
    await runtime.chat.sendMessage(
      `Failed to resolve model: ${earlyModelResult.message}`,
      { notify: true },
    )
    return false
  }
  const earlyModelParam = earlyModelResult
  if (!earlyModelParam) {
    runtime.typing.stopTyping()
    await runtime.chat.sendMessage(
      'No model account available. Add an account to the credential pool with `/credentials add`.',
    )
    return false
  }

  // Resolve thinking variant
  const earlyThinkingValue = await (async (): Promise<string | undefined> => {
    if (!preferredVariant) {
      return undefined
    }
    const catalog = await getClient().catalog.providers({
      directory: runtime.sdkDirectory,
    })
    if (catalog instanceof Error) {
      return undefined
    }
    const availableValues = getThinkingValuesForModel({
      providers: catalog.providers,
      providerId: earlyModelParam.providerID,
      modelId: earlyModelParam.modelID,
    })
    if (availableValues.length === 0) {
      return undefined
    }
    return (
      matchThinkingValue({
        requestedValue: preferredVariant,
        availableValues,
      }) || undefined
    )
  })()

  await runtime.ensureModelContextLimit({
    providerID: earlyModelParam.providerID,
    modelID: earlyModelParam.modelID,
  })

  await runtime.sendNewSessionModelInfo({
    createdNewSession,
    model: earlyModelParam,
    agent: earlyAgentPreference,
  })

  // ── Build prompt parts ────────────────────────────────────
  const images = input.images || []
  const promptWithImagePaths = (() => {
    if (images.length === 0) {
      return input.prompt
    }
    const imageList = images
      .map((img) => {
        return `- ${img.sourceUrl || img.filename}`
      })
      .join('\n')
    return `${input.prompt}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${imageList}`
  })()

  // ── Working directory for per-turn prompt context ─────────
  const workingDirectory = applicationDirectory()
    ? undefined
    : await getThreadWorkingDirectory(runtime.thread.id)

  const channelTopic = await runtime.chat.channelTopic(channelId)
  // Pinned before building parts so the fork notice can compare identities.
  // Also covers session.command: the context-awareness plugin reads the same
  // pinned file because the command API has no system field.
  const system = await runtime.resolveTurnSystemPrompt({
    sessionId: session.id,
    channelTopic,
    agents: earlyAvailableAgents,
    input,
  })
  if (system instanceof Error) {
    logger.error(
      `[DISPATCH] Failed to pin system prompt for session ${session.id}: ${system.message}`,
    )
    void notifyError(system, 'Failed to pin session system prompt')
    runtime.typing.stopTyping()
    await runtime.chat.sendMessage(
      `✗ Failed to prepare system prompt: ${system.message}`,
      { notify: true },
    )
    return false
  }
  const systemPromptFromSourceSession = systemPromptNamesOtherSession({
    system,
    sessionId: session.id,
  })
  const forkOrigin = await getSessionForkOrigin(session.id)
  const workingDirectoryChanged =
    runtime.consumeWorkingDirectoryPromptChange(workingDirectory)
  const syntheticContext = getPromptContext({
    platform: runtime.chat.platform,
    sessionId: session.id,
    backend: agentBackendLabel(),
    threadId: runtime.thread.id,
    username: input.username,
    userId: input.userId,
    sourceMessageId: input.sourceMessageId,
    sourceThreadId: input.sourceThreadId || runtime.thread.id,
    threadName: runtime.chat.name || undefined,
    repliedMessage: input.repliedMessage,
    workingDirectory,
    currentAgent: earlyAgentPreference,
    workingDirectoryChanged,
    systemPromptFromSourceSession,
    forkOrigin,
    parentSessionId: runtime.getParentSessionIdMissingFromSystem({ system, input }),
  })
  const turnContext = await runtime.resolveTurnContext({
    sessionId: session.id,
    input,
    isFirstTurn: createdNewSession,
  })
  const parts: AgentPromptPart[] = [
    { kind: 'text', text: promptWithImagePaths },
    { kind: 'text', text: syntheticContext, synthetic: true },
    ...(turnContext
      ? [{ kind: 'text' as const, text: turnContext, synthetic: true }]
      : []),
    ...images.map(toPromptFilePart),
  ]

  const variantField = earlyThinkingValue ? { variant: earlyThinkingValue } : {}

  if (input.command) {
    const queuedCommand = input.command
    const commandSignal = AbortSignal.timeout(30_000)
    // session.command() only accepts FilePart in parts, not text parts.
    // Append the <discord-user /> tag to the arguments, same as promptAsync,
    // so the model sees who sent the command.
    const discordTag = getPromptContext({
      platform: runtime.chat.platform,
      sessionId: session.id,
      backend: agentBackendLabel(),
      threadId: runtime.thread.id,
      username: input.username,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      sourceThreadId: input.sourceThreadId || runtime.thread.id,
      threadName: runtime.chat.name || undefined,
      repliedMessage: input.repliedMessage,
      systemPromptFromSourceSession,
      forkOrigin,
      parentSessionId: runtime.getParentSessionIdMissingFromSystem({ system, input }),
    })
    await runtime.recordTurnAttribution({ sessionId: session.id, input })
    if (runtime.disposed) {
      logger.log(
        `[DISPATCH] Runtime disposed before command was sent sessionId=${session.id}`,
      )
      return false
    }
    const commandResponse = await getClient().sessions.command(
      {
        sessionId: session.id,
        directory: runtime.sdkDirectory,
        command: queuedCommand.name,
        arguments: queuedCommand.arguments + (discordTag ? `\n${discordTag}` : ''),
        system,
        agent: earlyAgentPreference,
        model: {
          providerId: earlyModelParam.providerID,
          modelId: earlyModelParam.modelID,
        },
        ...(variantField.variant ? { variant: variantField.variant } : {}),
      },
      { signal: commandSignal },
    )

    if (commandResponse instanceof AgentRequestError) {
      const errorMessage = commandResponse.message
      if (errorMessage.includes('aborted')) {
        logger.log(`[DISPATCH] Command aborted (expected) sessionId=${session.id}`)
        runtime.typing.stopTyping()
        return true
      }
      const apiError = new Error(`Agent error: ${errorMessage}`)
      logger.error(`[DISPATCH] ${apiError.message}`)
      void notifyError(apiError, 'Agent error during command')
      runtime.typing.stopTyping()
      await runtime.chat.sendMessage(`✗ ${apiError.message}`, { notify: true })
      return false
    }

    if (commandResponse instanceof Error) {
      const timeoutReason = commandSignal.reason
      const timedOut =
        commandSignal.aborted &&
        timeoutReason instanceof Error &&
        timeoutReason.name === 'TimeoutError'
      if (timedOut) {
        logger.warn(`[DISPATCH] Command timed out after 30s sessionId=${session.id}`)
        runtime.typing.stopTyping()
        await runtime.chat.sendMessage(
          '✗ Command timed out after 30 seconds. Try a shorter command or run it with /run-shell-command.',
          { notify: true },
        )
        return false
      }

      const commandErrorForAbortCheck: unknown = commandResponse
      if (isAbortError(commandErrorForAbortCheck)) {
        logger.log(`[DISPATCH] Command aborted (expected) sessionId=${session.id}`)
        runtime.typing.stopTyping()
        return true
      }

      logger.error(`[DISPATCH] Command SDK call failed: ${commandResponse.message}`)
      void notifyError(commandResponse, 'Failed to send command to the agent')
      runtime.typing.stopTyping()
      await runtime.chat.sendMessage(
        `✗ Unexpected bot Error: ${commandResponse.message}`,
        { notify: true },
      )
      return false
    }

    logger.log(`[DISPATCH] Successfully ran command for session ${session.id}`)
    return true
  }

  await runtime.recordTurnAttribution({ sessionId: session.id, input })
  await waitForGlobalEventListener()
  if (runtime.disposed) {
    logger.log(
      `[DISPATCH] Runtime disposed before prompt was sent sessionId=${session.id}`,
    )
    return false
  }
  const promptResponse = await getClient().sessions.prompt({
    sessionId: session.id,
    directory: runtime.sdkDirectory,
    parts,
    system,
    model: { providerId: earlyModelParam.providerID, modelId: earlyModelParam.modelID },
    agent: earlyAgentPreference,
    ...(variantField.variant ? { variant: variantField.variant } : {}),
  })

  if (promptResponse instanceof Error) {
    const errorMessage = promptResponse.message
    const errorObject = promptResponse
    logger.error(`[DISPATCH] Prompt API call failed: ${errorMessage}`)
    void notifyError(errorObject, 'Agent error during local queue prompt')
    runtime.typing.stopTyping()
    await runtime.chat.sendMessage(`✗ Agent error: ${errorMessage}`, { notify: true })
    return false
  }

  logger.log(
    `[DISPATCH] promptAsync accepted by ${getAgentBackendProvider().id} queue sessionId=${session.id} threadId=${runtime.threadId}`,
  )
  return true
}

export async function persistIngressVariant(
  runtime: Pick<RuntimeContext, 'sdkDirectory'>,
  {
    sessionId,
    channelId,
    appId,
    agentPreference,
    getClient,
    variant,
  }: {
    sessionId: string
    channelId?: string
    appId?: string
    agentPreference?: string
    getClient: Error | AgentBackendGetter
    variant?: string
  },
) {
  if (!variant) return
  if (getClient instanceof Error) return
  const variantModelInfo = await getCurrentModelInfo({
    sessionId,
    channelId,
    appId,
    agentPreference,
    getClient,
    directory: runtime.sdkDirectory,
  })
  if (variantModelInfo.type === 'none') return
  const catalog = await getClient().catalog.providers({ directory: runtime.sdkDirectory })
  if (catalog instanceof Error) return
  const matchedVariant = matchThinkingValue({
    requestedValue: variant,
    availableValues: getThinkingValuesForModel({
      providers: catalog.providers,
      providerId: variantModelInfo.providerID,
      modelId: variantModelInfo.modelID,
    }),
  })
  if (!matchedVariant) return
  await setSessionModel({
    sessionId,
    modelId: variantModelInfo.model,
    variant: matchedVariant,
  })
}

export async function recordTurnAttribution(
  runtime: Pick<
    RuntimeContext,
    'chat' | 'thread' | 'channelId' | 'postPayerChangeNoticeOnce'
  >,
  {
    sessionId,
    input,
  }: {
    sessionId: string
    input: Pick<
      IngressInput,
      'userId' | 'username' | 'actorVia' | 'personId' | 'credentialPool'
    >
  },
): Promise<void> {
  const { credentialPoolsEnabled, credentialsMode, threadBilling } = store.getState()
  const billing = input.userId
    ? resolvePersonBillingPool({
        person: {
          personId: input.personId,
          credentialPool: input.credentialPool,
        },
        platform: runtime.chat.platform,
        actorId: input.userId,
      })
    : undefined
  // Speaker billing: read the previous turn's payer before this turn's
  // attribution overwrites the row. Global mode never changes payer (the
  // shared pool bills everything), and neither does owner billing.
  const speakerBilling =
    credentialPoolsEnabled &&
    credentialsMode !== 'global' &&
    threadBilling === 'speaker' &&
    billing !== undefined
  const previousAttribution = speakerBilling
    ? await getSessionTurnAttribution(sessionId).catch((e) => {
        logger.warn(
          `[ACTOR] Failed to read the previous turn's payer for session ${sessionId}: ${String(e)}`,
        )
        return undefined
      })
    : undefined
  const result = await setSessionTurnAttribution({
    sessionId,
    threadId: runtime.thread.id,
    channelId: runtime.channelId,
    ...(input.userId
      ? {
          actor: {
            platform: runtime.chat.platform,
            id: input.userId,
            ...(input.username ? { name: input.username } : {}),
            via: input.actorVia ?? 'chat',
          },
          ...(input.personId ? { personId: input.personId } : {}),
          ...(credentialPoolsEnabled && billing
            ? { credentialPool: billing.poolId }
            : {}),
        }
      : {}),
  }).catch((e) => new Error('Failed to record session turn attribution', { cause: e }))
  if (result instanceof Error) {
    logger.warn(
      `[ACTOR] ${result.message} for session ${sessionId}: ${String(result.cause)}`,
    )
  } else if (
    speakerBilling &&
    billing &&
    previousAttribution?.credentialPool &&
    previousAttribution.credentialPool !== billing.poolId
  ) {
    // Only on a successful attribution write: the notice compares the
    // previous row's pool, which this write has just replaced.
    await runtime.postPayerChangeNoticeOnce({
      sessionId,
      previousPoolId: previousAttribution.credentialPool,
      poolId: billing.poolId,
      username: input.username,
    })
  }
  if (credentialPoolsEnabled && billing) {
    // First human speaker owns the session; insert-or-ignore keeps later
    // speakers from moving it. Sessions with no actor stay ownerless and
    // bill to the shared pool.
    await recordCredentialOwner({
      sessionId,
      poolId: billing.poolId,
      personKey: billing.personKey,
    }).catch((e) =>
      logger.warn(
        `[ACTOR] Failed to record credential owner for session ${sessionId}: ${String(e)}`,
      ),
    )
  }
}

export async function postPayerChangeNoticeOnce(
  runtime: Pick<RuntimeContext, 'chat'>,
  {
    sessionId,
    previousPoolId,
    poolId,
    username,
  }: {
    sessionId: string
    previousPoolId: string
    poolId: string
    username: string
  },
): Promise<void> {
  try {
    const claimed = await recordCredentialPayerNotice({
      sessionId,
      previousPoolId,
      poolId,
    }).catch((e) => {
      logger.warn(
        `[ACTOR] Failed to record the payer-change notice for session ${sessionId}: ${String(e)}`,
      )
      return false
    })
    if (!claimed) return
    const notice = asSubtext(
      `Speaker billing: this thread now bills through ${username}'s credential pool (${poolId}). Earlier messages in this thread are sent to that pool's provider account.`,
    )
    const sent = await runtime.chat.sendNotice(notice)
    if (sent instanceof Error) {
      discordLogger.error('Failed to send the speaker-billing payer-change notice:', sent)
    }
  } catch (e) {
    logger.warn(
      `[ACTOR] Failed to post the payer-change notice for session ${sessionId}: ${String(e)}`,
    )
  }
}
