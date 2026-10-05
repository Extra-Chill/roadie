// Native Events API intake. Hosts may forward/re-sign events onto this loopback
// endpoint; both direct Slack and host delivery use the same durable inbox.
import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import mime from 'mime'
import * as errore from 'errore'
import * as orm from 'drizzle-orm'
import { z } from 'zod'
import {
  getDb,
  getThreadSession,
  getThreadIdBySessionId,
  getThreadWorkingDirectory,
  setThreadWorkingDirectory,
  getChannelDirectory,
  setChannelDirectory,
  setSessionModel,
  setSessionAgent,
  setSessionTurnAttribution,
  createScheduledTask,
  consumeSessionSleepWake,
} from './database.js'
import * as schema from './schema.js'
import {
  channelAllowsSpeaker,
  channelAllowsCapability,
  channelStartsThreads,
  decideRespond,
  resolveChannelPolicy,
  setChannelParentResolver,
  applicationDirectory,
  resolveSendChannel,
  validateApplicationDirectory,
} from './channel-policy.js'
import { personHas, resolvePerson } from './identity.js'
import {
  getOrCreateRuntime,
  getRuntime,
  disposeRuntime,
  resumeInterruptedSessions,
  restorePersistedLocalQueues,
  type IngressInput,
  type ThreadSessionRuntime,
} from './session-handler/thread-session-runtime.js'
import { getAgentBackendProvider } from './agent-backend/registry.js'
import { resolveForkWorkspace, forkWorkspaceNotice } from './fork-workspace.js'
import { forkOpenCodeSession } from './agent-backend/opencode-fork.js'
import { markPendingForkTitle } from './fork-title.js'
import { openCodeCatalogGetter } from './agent-backend/registry.js'
import { getOpencodeClient } from './opencode.js'
import { setThreadSession } from './database.js'
import { copySessionPreferences } from './commands/model.js'
import { copySessionSystemPrompt } from './system-message.js'
import {
  SlackApi,
  SlackApiError,
  parseSlackThreadId,
  slackThreadId,
} from './chat-platform/slack-api.js'
import { SlackChatThread, slackInteractionSchema } from './chat-platform/slack.js'
import { createLogger } from './logger.js'
import { store } from './store.js'
import { startIpcPolling, stopIpcPolling } from './ipc-polling.js'
import { startTaskRunner } from './task-runner.js'
import {
  formatSessionSleepWakePrompt,
  parseSendAtValue,
  serializeScheduledTaskPayload,
  getPromptPreview,
  getLocalTimeZone,
  type ScheduledTaskPayload,
} from './task-schedule.js'
import { waitForSessionComplete } from './wait-session.js'
import { REMOTE_SEND_OPTIONS, setRemoteSendRunner } from './remote-send.js'
import { prepareChatAttachments } from './chat-platform/attachments.js'
import { markChatPlatformReady } from './hrana-server.js'
import { doAction } from './hooks.js'
import { readConversationAdmission, resolveConversationIntake, recordConversationAdmission } from './conversation-intake.js'
import { startRuntimeIdleSweeper } from './runtime-idle-sweeper.js'

const logger = createLogger('SLACK')
const messageSchema = z.object({
  type: z.enum(['message', 'app_mention']),
  channel: z.string(),
  ts: z.string().regex(/^\d+\.\d+$/),
  user: z.string().optional(),
  text: z.string().default(''),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  bot_profile: z.object({ name: z.string().optional() }).optional(),
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        mimetype: z.string().optional(),
        url_private: z.string().optional(),
      }),
    )
    .optional(),
})
const commandSchema = z.object({
  team_id: z.string(),
  channel_id: z.string(),
  user_id: z.string(),
  user_name: z.string().default(''),
  command: z.string(),
  text: z.string().default(''),
  trigger_id: z.string(),
})
const deliverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), event: messageSchema }),
  z.object({ kind: z.literal('interaction'), event: slackInteractionSchema }),
  z.object({ kind: z.literal('command'), event: commandSchema }),
  z.object({
    kind: z.literal('wake'),
    event: z.object({
      threadId: z.string(),
      sessionId: z.string(),
      deliveryId: z.string(),
      wakeAt: z.string(),
      reason: z.string().nullable(),
    }),
  }),
])
type Delivery = z.infer<typeof deliverySchema>

export function verifySlackSignature(input: {
  body: Buffer
  timestamp: string | undefined
  signature: string | undefined
  secret: string
  now?: number
}): boolean {
  if (
    !input.timestamp ||
    !/^\d+$/.test(input.timestamp) ||
    !input.signature ||
    !/^v0=[a-f0-9]{64}$/.test(input.signature)
  )
    return false
  if (Math.abs((input.now ?? Date.now()) / 1000 - Number(input.timestamp)) > 300) return false
  const expected = crypto
    .createHmac('sha256', input.secret)
    .update(`v0:${input.timestamp}:`)
    .update(input.body)
    .digest('hex')
  return crypto.timingSafeEqual(Buffer.from(`v0=${expected}`), Buffer.from(input.signature))
}

export type SlackBotOptions = {
  token: string
  signingSecret: string
  workspaceId?: string
  apiUrl?: string
  port?: number
  hostname?: string
  taskPollIntervalMs?: number
}

const sendSchema = z.object({
  channel: z.string().optional(),
  thread: z.string().optional(),
  session: z.string().optional(),
  project: z.string().optional(),
  prompt: z.string().default(''),
  name: z.string().optional(),
  user: z.string().optional(),
  cwd: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  parentSession: z.string().optional(),
  permission: z.array(z.string()).optional(),
  injectionGuard: z.array(z.string()).optional(),
  notifyOnly: z.boolean().default(false),
  wait: z.boolean().default(false),
  sendAt: z.string().optional(),
  allowConcurrency: z.boolean().default(false),
})

export class NativeSlackBot {
  readonly api: SlackApi
  workspaceId = ''
  botUserId = ''
  private botId = ''
  private server: http.Server | null = null
  private stopped = false
  private drainPromise: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly threads = new Map<string, SlackChatThread>()
  private readonly runtimeBuilds = new Map<string, Promise<ThreadSessionRuntime | Error>>()
  private recoveryPromise: Promise<void> = Promise.resolve()
  private stopTasks: (() => Promise<void>) | null = null
  private restoreSendRunner: (() => void) | null = null
  private stopIdleSweep: (() => Promise<void>) | null = null

  constructor(readonly options: SlackBotOptions) {
    this.api = new SlackApi({ token: options.token, apiUrl: options.apiUrl })
  }
  get url() {
    const address = this.server?.address()
    return address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : ''
  }

  async start(): Promise<Error | void> {
    const auth = await this.api.call(
      'auth.test',
      {},
      z.object({ team_id: z.string(), user_id: z.string(), bot_id: z.string().optional() }),
    )
    if (auth instanceof Error) return auth
    if (this.options.workspaceId && auth.team_id !== this.options.workspaceId)
      return new SlackApiError({
        operation: 'startup',
        detail: 'bot token belongs to another workspace',
      })
    this.workspaceId = auth.team_id
    this.botUserId = auth.user_id
    this.botId = auth.bot_id ?? ''
    setChannelParentResolver((id) => parseSlackThreadId(id)?.channelId)
    this.server = http.createServer((request, response) => {
      void this.receive(request, response).catch((error) => {
        logger.error('Slack intake failed', error)
        if (!response.headersSent) response.writeHead(503)
        response.end()
      })
    })
    const started = await new Promise<Error | void>((resolve) => {
      this.server!.once('error', (cause) =>
        resolve(
          new SlackApiError({
            operation: 'startup',
            detail: 'cannot bind Slack endpoint; choose a free ROADIE_SLACK_PORT',
            cause,
          }),
        ),
      )
      this.server!.listen(this.options.port ?? 0, this.options.hostname ?? '127.0.0.1', resolve)
    })
    if (started instanceof Error) return started
    const resolveRuntime = async (id: string) => {
      const target = parseSlackThreadId(id)
      if (!target || target.workspaceId !== this.workspaceId) return undefined
      const runtime = await this.runtimeFor(target.channelId, target.threadTs)
      if (runtime instanceof Error) {
        logger.warn(runtime.message)
        return undefined
      }
      return runtime
    }
    this.recoveryPromise = (async () => {
      await resumeInterruptedSessions({ resolveRuntime })
      await restorePersistedLocalQueues({ resolveRuntime })
    })().catch((error) => logger.error('Slack session recovery failed', error))
    await startIpcPolling({ resolveChatThread: async (id) => (await resolveRuntime(id))?.chat })
    this.restoreSendRunner = setRemoteSendRunner(async (args, emit) => {
      const options: Record<string, unknown> = {}
      const filePaths: string[] = []
      for (const arg of args.slice(1)) {
        const separator = arg.indexOf('=')
        const flag = separator < 0 ? arg : arg.slice(0, separator)
        const value = separator < 0 ? true : arg.slice(separator + 1)
        if (flag === '--file' && typeof value === 'string') {
          filePaths.push(value)
          continue
        }
        const entry = Object.entries(REMOTE_SEND_OPTIONS).find(([, spec]) => spec.flag === flag)
        if (!entry) {
          emit({ stream: 'stderr', data: `Unsupported Slack send option: ${flag}\n` })
          return 1
        }
        const [key, spec] = entry
        options[key] =
          spec.kind === 'strings'
            ? [...(Array.isArray(options[key]) ? options[key] : []), value]
            : value
      }
      const result = await this.send(options, filePaths)
      if (result instanceof Error) {
        emit({ stream: 'stderr', data: `${result.message}\n` })
        return 1
      }
      emit({
        stream: 'stdout',
        data: `${'text' in result && typeof result.text === 'string' ? result.text : JSON.stringify(result)}\n`,
      })
      return 0
    })
    this.stopTasks = startTaskRunner({
      pollIntervalMs: this.options.taskPollIntervalMs,
      delivery: {
        execute: async ({ task, payload, prompt, runId }) => {
          const result = await this.send(
            {
              ...(payload.kind === 'thread'
                ? { thread: payload.threadId }
                : {
                    channel: payload.channelId,
                    name: payload.name ?? undefined,
                    notifyOnly: payload.notifyOnly,
                    cwd: payload.cwd ?? undefined,
                  }),
              prompt,
              user: payload.userId ?? undefined,
              agent: payload.agent ?? undefined,
              model: payload.model ?? undefined,
              permission: payload.permissions ?? undefined,
              injectionGuard: payload.injectionGuardPatterns ?? undefined,
              parentSession: payload.parentSessionId ?? undefined,
            },
            [],
            {
              scheduleKind: task.schedule_kind,
              scheduledTaskId: task.id,
              scheduledTaskRunId: runId,
            },
          )
          return result instanceof Error ? result : (result.threadId ?? null)
        },
        wake: async ({ sleep, threadId }) => {
          if (parseSlackThreadId(threadId)?.workspaceId !== this.workspaceId)
            return new Error('Sleep belongs to another chat workspace')
          await this.accept(`${this.workspaceId}:wake:${sleep.delivery_id}`, {
            kind: 'wake',
            event: {
              threadId,
              sessionId: sleep.session_id,
              deliveryId: sleep.delivery_id,
              wakeAt: sleep.wake_at.toISOString(),
              reason: sleep.reason,
            },
          })
          this.kick()
        },
      },
    })
    this.kick()
    this.stopIdleSweep = startRuntimeIdleSweeper()
    markChatPlatformReady('slack', true)
    await doAction('ready', {})
    logger.log(`Native Slack receiver ready at ${this.url}`)
  }

  async stop() {
    this.stopped = true
    markChatPlatformReady('slack', false)
    stopIpcPolling()
    await this.stopIdleSweep?.()
    await this.stopTasks?.()
    this.restoreSendRunner?.()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    )
    await this.drainPromise
    await this.recoveryPromise
    for (const id of this.threads.keys()) disposeRuntime(id)
    this.threads.clear()
  }

  async runtimeFor(channelId: string, threadTs: string): Promise<ThreadSessionRuntime | Error> {
    const id = slackThreadId({ workspaceId: this.workspaceId, channelId, threadTs })
    const existing = getRuntime(id)
    if (existing) return existing
    const building = this.runtimeBuilds.get(id)
    if (building) return building
    const build = this.buildRuntime(channelId, threadTs).finally(() =>
      this.runtimeBuilds.delete(id),
    )
    this.runtimeBuilds.set(id, build)
    return build
  }

  private async buildRuntime(channelId: string, threadTs: string) {
    const policy = resolveChannelPolicy(channelId)
    if (policy === null)
      return new SlackApiError({
        operation: 'session',
        detail: 'channel is not configured in ROADIE_CHANNELS_CONFIG',
      })
    const directory = policy?.directory ?? (await getChannelDirectory(channelId))?.directory
    if (!directory)
      return new SlackApiError({
        operation: 'session',
        detail: 'bind this channel to a project directory in ROADIE_CHANNELS_CONFIG',
      })
    await setChannelDirectory({
      channelId,
      directory,
      channelType: 'text',
      guildId: this.workspaceId,
    })
    const chat = await SlackChatThread.create({
      api: this.api,
      workspaceId: this.workspaceId,
      channelId,
      threadTs,
      botUserId: this.botUserId,
    })
    this.threads.set(chat.id, chat)
    const working = await getThreadWorkingDirectory(chat.id)
    return getOrCreateRuntime({
      threadId: chat.id,
      chat,
      projectDirectory: directory,
      sdkDirectory: applicationDirectory() ?? working?.workingDirectory ?? directory,
      channelId,
      sessionId: (await getThreadSession(chat.id)) || undefined,
    })
  }

  /** CLI/automation delivery is explicitly asserted, never a platform-authenticated person. */
  async send(
    input: unknown,
    filePaths: string[] = [],
    source?: IngressInput['sessionStartSource'],
  ): Promise<{ threadId?: string; sessionId?: string; taskId?: number; text?: string } | Error> {
    const parsed = sendSchema.safeParse(input)
    if (!parsed.success)
      return new SlackApiError({ operation: 'send', detail: parsed.error.message })
    const options = parsed.data
    if (options.project) return new SlackApiError({ operation: 'send', detail: '--project no longer selects channels; configure application.channel or use --channel' })
    const directoryError = validateApplicationDirectory(options.cwd)
    if (directoryError) return directoryError
    const sessionThread = options.session ? await getThreadIdBySessionId(options.session) : null
    const target = parseSlackThreadId(options.thread ?? sessionThread ?? '')
    if ((options.thread || options.session) && !target)
      return new SlackApiError({
        operation: 'send',
        detail: 'use a native Slack Roadie thread ID or session ID',
      })
    if (target && target.workspaceId !== this.workspaceId)
      return new SlackApiError({ operation: 'send', detail: 'thread belongs to another workspace' })
    const channelId = resolveSendChannel(target?.channelId ?? options.channel)
    if (channelId instanceof Error) return channelId
    if (options.channel && target && options.channel !== target.channelId)
      return new SlackApiError({ operation: 'send', detail: 'channel and thread targets disagree' })
    const policy = resolveChannelPolicy(channelId)
    if (
      policy === null ||
      policy?.respond === 'never' ||
      !channelAllowsCapability(channelId, 'sessions')
    )
      return new SlackApiError({
        operation: 'send',
        detail: 'channel policy does not permit sessions',
      })
    const directory = policy?.directory ?? (await getChannelDirectory(channelId))?.directory
    if (directory)
      await setChannelDirectory({
        channelId,
        directory,
        channelType: 'text',
        guildId: this.workspaceId,
      })
    if (options.sendAt) {
      if (!directory)
        return new SlackApiError({
          operation: 'schedule',
          detail: 'configure a project directory for this channel',
        })
      if (filePaths.length)
        return new SlackApiError({
          operation: 'schedule',
          detail: 'scheduled attachments are not supported; upload them before scheduling',
        })
      const schedule = parseSendAtValue({
        value: options.sendAt,
        now: new Date(),
        timezone: getLocalTimeZone(),
      })
      if (schedule instanceof Error) return schedule
      const common = {
        prompt: options.prompt,
        agent: options.agent ?? null,
        model: options.model ?? null,
        username: null,
        userId: options.user ?? null,
        permissions: options.permission ?? null,
        injectionGuardPatterns: options.injectionGuard ?? null,
        parentSessionId: options.parentSession ?? null,
        preRunCommand: null,
        allowConcurrency: options.allowConcurrency,
      }
      const payload: ScheduledTaskPayload = target
        ? { ...common, kind: 'thread', threadId: options.thread ?? sessionThread! }
        : {
            ...common,
            kind: 'channel',
            channelId,
            name: options.name ?? null,
            notifyOnly: options.notifyOnly,
            worktreeName: null,
            cwd: options.cwd ?? null,
          }
      const taskId = await createScheduledTask({
        scheduleKind: schedule.scheduleKind,
        runAt: schedule.runAt,
        cronExpr: schedule.cronExpr,
        timezone: schedule.timezone,
        nextRunAt: schedule.nextRunAt,
        payloadJson: serializeScheduledTaskPayload(payload),
        promptPreview: getPromptPreview(options.prompt),
        channelId,
        threadId: target ? slackThreadId(target) : undefined,
        projectDirectory: directory,
      })
      return { taskId }
    }
    if (options.notifyOnly && !filePaths.length) {
      const sent = await this.api.post({
        channel: channelId,
        threadTs: target?.threadTs,
        text: options.prompt,
        notify: true,
      })
      return sent instanceof Error ? sent : { threadId: target ? slackThreadId(target) : undefined }
    }
    const root = target
      ? { id: target.threadTs }
      : await this.api.post({
          channel: channelId,
          text: options.name || getPromptPreview(options.prompt) || 'Roadie files',
        })
    if (root instanceof Error) return root
    const id = slackThreadId({ workspaceId: this.workspaceId, channelId, threadTs: root.id })
    if (options.cwd && directory) {
      const stat = await fs
        .stat(options.cwd)
        .catch(
          (cause) =>
            new SlackApiError({
              operation: 'send',
              detail: 'working directory does not exist',
              cause,
            }),
        )
      if (stat instanceof Error) return stat
      if (!stat.isDirectory())
        return new SlackApiError({ operation: 'send', detail: '--cwd must be a directory' })
      if (getRuntime(id) && getRuntime(id)?.sdkDirectory !== path.resolve(options.cwd))
        return new SlackApiError({
          operation: 'send',
          detail: 'existing session has a different working directory; start a new thread',
        })
      await setThreadWorkingDirectory({
        threadId: id,
        projectDirectory: directory,
        workingDirectory: path.resolve(options.cwd),
        label: path.basename(options.cwd),
      })
    }
    for (const filePath of filePaths) {
      const uploaded = await this.api.uploadFile({
        channel: channelId,
        threadTs: root.id,
        filePath,
      })
      if (uploaded instanceof Error) return uploaded
    }
    if (options.notifyOnly) return { threadId: id }
    const runtime = await this.runtimeFor(channelId, root.id)
    if (runtime instanceof Error) return runtime
    if (target) {
      const notice = await runtime.chat.sendNotice(`» Roadie: ${options.prompt}`)
      if (notice instanceof Error) return notice
    }
    const waitStartedAtMs = Date.now()
    const attached: Array<{ name: string; mimetype: string; bytes: Buffer }> = []
    for (const filePath of filePaths) {
      const bytes = await fs.readFile(filePath)
      const contentType = mime.getType(filePath) ?? 'application/octet-stream'
      attached.push({ name: path.basename(filePath), mimetype: contentType, bytes })
    }
    const attachments = await prepareChatAttachments(attached)
    if (attachments instanceof Error) return attachments
    await runtime.enqueueIncoming({
      prompt: [options.prompt, attachments.context].filter(Boolean).join('\n\n'),
      userId: options.user ?? '',
      username: 'Roadie',
      actorVia: 'cli',
      agent: options.agent,
      model: options.model,
      permissions: options.permission,
      injectionGuardPatterns: options.injectionGuard,
      parentSessionId: options.parentSession,
      sessionStartSource: source,
      images: attachments.images,
      mode: 'opencode',
    })
    const sessionId = runtime.state?.sessionId
    if (options.wait && sessionId) {
      const waited = await waitForSessionComplete({
        projectDirectory: runtime.sdkDirectory,
        sessionId,
        waitStartedAtMs,
      }).catch(
        (cause) =>
          new SlackApiError({
            operation: 'send --wait',
            detail: 'session did not complete',
            cause,
          }),
      )
      if (waited instanceof Error) return waited
      const backend = await getAgentBackendProvider().initializeForDirectory(runtime.sdkDirectory)
      if (backend instanceof Error) return backend
      const messages = await backend().sessions.messages({
        sessionId,
        directory: runtime.sdkDirectory,
      })
      if (messages instanceof Error) return messages
      const last = messages.findLast(
        (entry) => entry.message.role === 'assistant' && !entry.message.summary,
      )
      const text =
        last?.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n\n') ?? ''
      return { threadId: id, sessionId, text }
    }
    return { threadId: id, sessionId }
  }

  private async authorize(channelId: string, userId: string, botName?: string) {
    if (!channelAllowsCapability(channelId, 'sessions') || decideRespond(channelId) === 'ignore')
      return null
    if (userId.startsWith('B')) {
      const actor = { platform: 'slack', id: userId, name: botName ?? userId }
      const person = await resolvePerson({
        actor,
        context: { guildId: this.workspaceId, channelId },
      })
      if (!person || !personHas(person, 'sessions')) return null
      if (
        !channelAllowsSpeaker(channelId, {
          userId,
          isGuildOwner: false,
          roleIds: [],
          roleNames: [],
          personId: person.personId,
        })
      )
        return null
      return { actor, person }
    }
    const info = await this.api.call(
      'users.info',
      { user: userId },
      z.object({
        user: z.object({
          id: z.string(),
          name: z.string().optional(),
          is_bot: z.boolean().optional(),
          is_owner: z.boolean().optional(),
          is_admin: z.boolean().optional(),
        }),
      }),
    )
    if (info instanceof Error) return info
    const actor = { platform: 'slack', id: userId, name: info.user.name ?? userId }
    const person = await resolvePerson({ actor, context: { guildId: this.workspaceId, channelId } })
    if (info.user.is_bot && !person) return null
    if (person && !personHas(person, 'sessions')) return null
    const policy = resolveChannelPolicy(channelId)
    if (
      !person &&
      !policy?.who &&
      !store.getState().allowAllUsers &&
      !info.user.is_admin &&
      !info.user.is_owner
    )
      return null
    if (
      !channelAllowsSpeaker(channelId, {
        userId,
        isGuildOwner: info.user.is_owner ?? false,
        roleIds: [],
        roleNames: [],
        personId: person?.personId,
      })
    )
      return null
    return { actor, person }
  }

  private async receive(request: http.IncomingMessage, response: http.ServerResponse) {
    const route = new URL(request.url ?? '/', 'http://localhost').pathname
    if (route === '/health' && request.method === 'GET') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            status: 'ok',
            platform: 'slack',
            ready: Boolean(this.botUserId),
            pid: process.pid,
          }),
        )
      return
    }
    if (
      request.method !== 'POST' ||
      !['/slack/events', '/slack/interactions', '/slack/commands'].includes(route)
    ) {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > 2 * 1024 * 1024) {
        response.writeHead(413).end()
        return
      }
      chunks.push(buffer)
    }
    const body = Buffer.concat(chunks)
    const timestamp = request.headers['x-slack-request-timestamp']
    const signature = request.headers['x-slack-signature']
    if (
      !verifySlackSignature({
        body,
        timestamp: typeof timestamp === 'string' ? timestamp : undefined,
        signature: typeof signature === 'string' ? signature : undefined,
        secret: this.options.signingSecret,
      })
    ) {
      response.writeHead(401).end()
      return
    }
    const raw = errore.try({
      try: (): unknown =>
        route === '/slack/events'
          ? JSON.parse(body.toString('utf8'))
          : route === '/slack/interactions'
            ? JSON.parse(new URLSearchParams(body.toString('utf8')).get('payload') ?? '{}')
            : Object.fromEntries(new URLSearchParams(body.toString('utf8'))),
      catch: (cause) => new SlackApiError({ operation: 'intake', detail: 'invalid JSON', cause }),
    })
    if (raw instanceof Error) {
      response.writeHead(400).end()
      return
    }
    if (route === '/slack/events') {
      const envelope = z
        .object({
          type: z.string(),
          challenge: z.string().optional(),
          team_id: z.string().optional(),
          event: z.unknown().optional(),
        })
        .safeParse(raw)
      if (!envelope.success) {
        response.writeHead(400).end()
        return
      }
      if (envelope.data.type === 'url_verification' && envelope.data.challenge) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ challenge: envelope.data.challenge }))
        return
      }
      if (envelope.data.team_id !== this.workspaceId) {
        response.writeHead(403).end()
        return
      }
      const message = messageSchema.safeParse(envelope.data.event)
      if (
        !message.success ||
        (!message.data.user && !message.data.bot_id) ||
        message.data.user === this.botUserId ||
        (message.data.bot_id && message.data.bot_id === this.botId) ||
        (message.data.subtype && !['file_share', 'bot_message'].includes(message.data.subtype))
      ) {
        response.writeHead(200).end()
        return
      }
      await this.accept(`${this.workspaceId}:${message.data.channel}:${message.data.ts}`, {
        kind: 'message',
        event: message.data,
      })
    } else if (route === '/slack/interactions') {
      const interaction = slackInteractionSchema.safeParse(raw)
      if (!interaction.success) {
        response.writeHead(400).end()
        return
      }
      if (interaction.data.team.id !== this.workspaceId) {
        response.writeHead(403).end()
        return
      }
      await this.accept(
        `${this.workspaceId}:interaction:${crypto.createHash('sha256').update(body).digest('hex')}`,
        { kind: 'interaction', event: interaction.data },
      )
    } else {
      const command = commandSchema.safeParse(raw)
      if (!command.success) {
        response.writeHead(400).end()
        return
      }
      if (command.data.team_id !== this.workspaceId) {
        response.writeHead(403).end()
        return
      }
      await this.accept(`${this.workspaceId}:command:${command.data.trigger_id}`, {
        kind: 'command',
        event: command.data,
      })
    }
    response.writeHead(200).end()
    this.kick()
  }

  /** Persist a verified host/platform delivery before acknowledging it. */
  private async accept(eventId: string, delivery: Delivery) {
    await (
      await getDb()
    )
      .insert(schema.chat_ingress_events)
      .values({ event_id: eventId, platform: 'slack', payload_json: JSON.stringify(delivery) })
      .onConflictDoNothing()
  }

  private kick() {
    if (this.stopped || this.drainPromise) return
    this.drainPromise = this.drain()
      .catch((error) => logger.error('Slack inbox drain failed', error))
      .finally(() => {
        this.drainPromise = null
        if (!this.stopped) this.retryTimer = setTimeout(() => this.kick(), 1000)
      })
  }

  private async drain() {
    const db = await getDb()
    const rows = await db
      .select()
      .from(schema.chat_ingress_events)
      .where(
        orm.and(
          orm.eq(schema.chat_ingress_events.platform, 'slack'),
          orm.like(schema.chat_ingress_events.event_id, `${this.workspaceId}:%`),
          orm.isNull(schema.chat_ingress_events.handled_at),
        ),
      )
      .orderBy(schema.chat_ingress_events.id)
      .limit(100)
    for (const row of rows) {
      if (this.stopped) return
      const delivery = deliverySchema.safeParse(JSON.parse(row.payload_json))
      if (!delivery.success) {
        logger.error(`Invalid inbox record ${row.event_id}`)
        continue
      }
      const result = await this.dispatch(delivery.data)
      if (result instanceof Error) {
        logger.warn(result.message)
        if (!(result instanceof SlackApiError) || result.retryable) continue
      }
      await db
        .update(schema.chat_ingress_events)
        .set({ handled_at: new Date() })
        .where(orm.eq(schema.chat_ingress_events.id, row.id))
    }
    for (const [id, thread] of this.threads) {
      if (getRuntime(id)) continue
      thread.interactions.dispose()
      this.threads.delete(id)
    }
  }

  private async dispatch(delivery: Delivery): Promise<void | Error> {
    if (delivery.kind === 'wake') {
      const event = delivery.event
      const target = parseSlackThreadId(event.threadId)
      if (
        !target ||
        target.workspaceId !== this.workspaceId ||
        (await getThreadSession(event.threadId)) !== event.sessionId
      )
        return
      const runtime = await this.runtimeFor(target.channelId, target.threadTs)
      if (runtime instanceof Error) return runtime
      const prompt = formatSessionSleepWakePrompt({
        wakeAt: new Date(event.wakeAt),
        reason: event.reason,
      })
      await runtime.enqueueIncoming({
        prompt,
        userId: '',
        username: 'Roadie',
        actorVia: 'cli',
        isSleepWake: true,
        expectedSessionId: event.sessionId,
        preprocess: async () => ({
          prompt,
          mode: 'opencode',
          skip: !(await consumeSessionSleepWake({ deliveryId: event.deliveryId })),
        }),
      })
      return
    }
    if (delivery.kind === 'command') return this.command(delivery.event)
    if (delivery.kind === 'interaction') {
      const hash =
        delivery.event.view?.private_metadata ??
        delivery.event.actions?.[0]?.action_id.split(':')[2]
      if (!hash) return
      const row = await (await getDb()).query.chat_interactions.findFirst({ where: { id: hash } })
      if (!row) return // Already answered/expired; redelivery is harmless.
      if (row.kind === 'command' && delivery.event.type === 'view_submission') {
        const saved = z
          .object({ event: commandSchema, operation: z.string(), target: z.string().optional() })
          .safeParse(JSON.parse(row.payload_json))
        if (
          !saved.success ||
          saved.data.event.user_id !== delivery.event.user.id ||
          saved.data.event.team_id !== this.workspaceId
        )
          return
        const choice = delivery.event.view?.state?.values.choice?.choice?.selected_option?.value
        if (!choice) return
        const extra = delivery.event.view?.state?.values.arguments?.arguments?.value ?? ''
        const text = saved.data.target
          ? `${saved.data.operation} ${saved.data.target} ${choice}`
          : `${saved.data.operation} ${choice} ${extra}`
        await this.command({ ...saved.data.event, text })
        await (
          await getDb()
        )
          .delete(schema.chat_interactions)
          .where(orm.eq(schema.chat_interactions.id, hash))
        return
      }
      const target = parseSlackThreadId(row.thread_id)
      if (!target || target.workspaceId !== this.workspaceId) return
      const identity = await this.authorize(target.channelId, delivery.event.user.id)
      if (identity instanceof Error) return identity
      if (!identity) return
      if (resolveChannelPolicy(target.channelId)?.intake) {
        const scope = { platform: 'slack', spaceId: this.workspaceId, threadId: row.thread_id }
        const admission = await readConversationAdmission(scope)
        const hasSession = Boolean(await getThreadSession(row.thread_id))
        const intake = await resolveConversationIntake({ actor: identity.actor, personId: identity.person?.personId, spaceId: this.workspaceId,
          channelId: target.channelId, threadId: row.thread_id, eligible: true, isNewConversation: !hasSession && !admission, createsThread: false,
          hasSession, mentionsBot: false, isCommand: true, text: 'interactive callback', legacyOutcome: 'respond' })
        if (intake.outcome !== 'respond') return
        await recordConversationAdmission({ scope, actor: identity.actor, starter: !hasSession && !admission, decision: intake })
      }
      const runtime = await this.runtimeFor(target.channelId, target.threadTs)
      if (runtime instanceof Error) return runtime
      const thread = this.threads.get(runtime.threadId)!
      const sessionId = runtime.state?.sessionId
      if (sessionId)
        await setSessionTurnAttribution({
          sessionId,
          threadId: runtime.threadId,
          channelId: target.channelId,
          actor: {
            platform: 'slack',
            id: identity.actor.id,
            name: identity.actor.name,
            via: 'chat',
          },
          personId: identity.person?.personId,
        })
      const result = await thread.handleInteraction(delivery.event)
      return result instanceof Error ? result : undefined
    }
    const message = delivery.event
    const identity = await this.authorize(
      message.channel,
      message.user ?? message.bot_id!,
      message.bot_profile?.name,
    )
    if (identity instanceof Error) return identity
    if (!identity) return
    const mentioned = message.text.includes(`<@${this.botUserId}>`)
    const decision = decideRespond(message.channel)
    // A host-relayed root may repeat its own ts as thread_ts. That is still a
    // new platform thread, not a continuation that bypasses start policy.
    const reply = Boolean(message.thread_ts && message.thread_ts !== message.ts)
    const threadTs = reply ? message.thread_ts! : message.ts
    const threadId = slackThreadId({ workspaceId: this.workspaceId, channelId: message.channel, threadTs })
    const scope = { platform: 'slack', spaceId: this.workspaceId, threadId }
    const hasSession = Boolean(await getThreadSession(threadId))
    const admission = await readConversationAdmission(scope)
    const legacyOutcome = (decision === 'needs-mention' || decision === 'builtin' && store.getState().defaultMentionMode) && !mentioned ? 'ignore' : 'respond'
    const intake = await resolveConversationIntake({
      actor: identity.actor, spaceId: this.workspaceId, channelId: message.channel, threadId,
      personId: identity.person?.personId, messageId: message.ts, text: message.text,
      eligible: true, isNewConversation: !hasSession && !admission, createsThread: !reply,
      hasSession, mentionsBot: mentioned, isCommand: message.text.trimStart().startsWith('/'),
      directedElsewhere: /^<@[A-Z0-9]+>/.test(message.text) && !mentioned,
      legacyOutcome,
    })
    if (intake.outcome === 'ignore') return
    await recordConversationAdmission({ scope, actor: identity.actor, starter: !hasSession && !admission, decision: intake })
    const runtime = await this.runtimeFor(message.channel, threadTs)
    if (runtime instanceof Error) return runtime
    const prompt = message.text.replaceAll(`<@${this.botUserId}>`, '').trim()
    const attached: Array<{ name: string; mimetype: string; bytes: Buffer }> = []
    for (const file of message.files ?? []) {
      const downloaded = await this.api.downloadFile(file.id)
      if (downloaded instanceof Error) return downloaded
      attached.push(downloaded)
    }
    const attachments = await prepareChatAttachments(attached)
    if (attachments instanceof Error) return attachments
    await runtime.enqueueIncoming({
      prompt: [prompt, attachments.context].filter(Boolean).join('\n\n'),
      userId: identity.actor.id,
      username: identity.actor.name,
      personId: identity.person?.personId,
      images: attachments.images,
      actorPlatform: 'slack',
      sourceMessageId: message.ts,
      sourceThreadId: runtime.threadId,
      sourceChannelId: message.channel,
      mode: 'opencode',
      noReply: intake.outcome === 'context',
      contextOnly: intake.outcome === 'context',
    })
  }

  // Slack slash commands do not carry a thread timestamp. Require an explicit
  // target for session operations instead of guessing which shared session.
  private async command(event: z.infer<typeof commandSchema>) {
    const identity = await this.authorize(event.channel_id, event.user_id)
    if (identity instanceof Error) return identity
    if (!identity) return
    const [name, target, ...words] = event.text.trim().split(/\s+/)
    if (name === 'new') {
      const intake = await resolveConversationIntake({ actor: identity.actor, spaceId: this.workspaceId, channelId: event.channel_id,
        personId: identity.person?.personId, text: event.text,
        eligible: true, isNewConversation: true, createsThread: true, hasSession: false, mentionsBot: false, isCommand: true, legacyOutcome: 'respond' })
      if (intake.outcome !== 'respond') return
      const root = await this.api.post({
        channel: event.channel_id,
        text: [target, ...words].filter(Boolean).join(' ') || 'New Roadie session',
      })
      if (root instanceof Error) return root
      const runtime = await this.runtimeFor(event.channel_id, root.id)
      if (runtime instanceof Error) return runtime
      await recordConversationAdmission({ scope: { platform: 'slack', spaceId: this.workspaceId, threadId: runtime.threadId }, actor: identity.actor, starter: true, decision: intake })
      await runtime.enqueueIncoming({
        prompt: [target, ...words].filter(Boolean).join(' '),
        userId: event.user_id,
        username: identity.actor.name,
      })
      return
    }
    if (!target || !/^\d+\.\d+$/.test(target)) {
      const rows = await (
        await getDb()
      )
        .select()
        .from(schema.thread_sessions)
        .where(
          orm.like(
            schema.thread_sessions.thread_id,
            `slack:${this.workspaceId}:${event.channel_id}:%`,
          ),
        )
        .orderBy(orm.desc(schema.thread_sessions.updated_at))
        .limit(100)
      if (rows.length && name && name !== 'help')
        return this.commandModal({
          event,
          operation: name,
          choices: rows.map((row) => ({
            label:
              row.last_synced_name ??
              `${row.session_id} · ${parseSlackThreadId(row.thread_id)?.threadTs}`,
            value: parseSlackThreadId(row.thread_id)!.threadTs,
          })),
          arguments: true,
        })
      const result = await this.api.post({
        channel: event.channel_id,
        text: 'Use /roadie new <prompt>, or /roadie <abort|model|agent> <thread timestamp> [value]. Session commands target an explicit thread.',
      })
      return result instanceof Error ? result : undefined
    }
    if (resolveChannelPolicy(event.channel_id)?.intake) {
      const id = slackThreadId({ workspaceId: this.workspaceId, channelId: event.channel_id, threadTs: target })
      const scope = { platform: 'slack', spaceId: this.workspaceId, threadId: id }
      const admission = await readConversationAdmission(scope)
      const hasSession = Boolean(await getThreadSession(id))
      const intake = await resolveConversationIntake({ actor: identity.actor, personId: identity.person?.personId, spaceId: this.workspaceId,
        channelId: event.channel_id, threadId: id, eligible: true, isNewConversation: !hasSession && !admission, createsThread: name === 'fork',
        hasSession, mentionsBot: false, isCommand: true, text: event.text, legacyOutcome: 'respond' })
      if (intake.outcome !== 'respond') return
      await recordConversationAdmission({ scope, actor: identity.actor, starter: !hasSession && !admission, decision: intake })
    }
    const runtime = await this.runtimeFor(event.channel_id, target)
    if (runtime instanceof Error) return runtime
    if (name === 'abort') {
      await runtime.abortActiveRun('Slack /roadie abort')
      return
    }
    const sessionId = runtime.state?.sessionId
    if (!sessionId) return
    const backend = await getAgentBackendProvider().initializeForDirectory(runtime.sdkDirectory)
    if (backend instanceof Error) return backend
    if (name === 'model') {
      const catalog = await backend().catalog.providers({ directory: runtime.sdkDirectory })
      if (catalog instanceof Error) return catalog
      const choices = catalog.providers
        .filter((provider) => catalog.connected.includes(provider.id))
        .flatMap((provider) =>
          Object.values(provider.models).map((model) => ({
            label: `${provider.name}: ${model.name}`,
            value: `${provider.id}/${model.id}`,
          })),
        )
      if (!words[0]) return this.commandModal({ event, operation: 'model', target, choices })
      if (!choices.some((choice) => choice.value === words[0])) {
        await runtime.chat.sendNotice(
          'Unknown or disconnected model. Use /roadie model to choose an available model.',
        )
        return
      }
      await setSessionModel({ sessionId, modelId: words[0] })
      await runtime.chat.sendNotice(`Model: ${words[0]}`)
      if (runtime.isBusy()) await runtime.retryLastUserPrompt()
      return
    }
    if (name === 'agent') {
      const agents = await backend().catalog.agents({ directory: runtime.sdkDirectory })
      if (agents instanceof Error) return agents
      const choices = agents
        .filter((agent) => !agent.hidden && agent.mode !== 'subagent')
        .map((agent) => ({ label: agent.name, value: agent.name }))
      if (!words[0]) return this.commandModal({ event, operation: 'agent', target, choices })
      if (!choices.some((choice) => choice.value === words[0])) {
        await runtime.chat.sendNotice(
          'Unknown agent. Use /roadie agent to choose an available agent.',
        )
        return
      }
      await runtime.enqueueIncoming({
        prompt: '',
        userId: event.user_id,
        username: identity.actor.name,
        agent: words[0],
        noReply: true,
      })
      await runtime.chat.sendNotice(`Agent: ${words[0]}`)
      return
    }
    if (name === 'fork') {
      const workspace = await resolveForkWorkspace({
        sourceSessionId: sessionId, sourceThreadId: runtime.threadId,
        projectDirectory: runtime.projectDirectory, sourceDirectory: runtime.sdkDirectory, platform: 'slack',
        spaceId: this.workspaceId, channelId: event.channel_id, userId: event.user_id, prompt: words.join(' '),
      })
      if (workspace instanceof Error) { await runtime.chat.sendNotice(workspace.message); return }
      const forkDirectory = workspace.binding?.workingDirectory ?? runtime.sdkDirectory
      const abandon = async () => {
        if (workspace.binding) await doAction('fork_workspace_abandoned', { request: workspace.request, binding: workspace.binding })
      }
      const client = getOpencodeClient(runtime.sdkDirectory)
      if (!client) {
        await abandon()
        return new SlackApiError({ operation: 'fork', detail: 'agent backend is unavailable' })
      }
      const forked = await forkOpenCodeSession({
        client, sessionId, sourceDirectory: runtime.sdkDirectory,
        ...(workspace.binding && { targetDirectory: forkDirectory }),
      })
      if (!forked.data) {
        await abandon()
        if (workspace.binding) {
          await runtime.chat.sendNotice(forked.error instanceof Error ? forked.error.message : 'The backend could not bind the fork workspace; no fork prompt was run.')
          return
        }
        return new SlackApiError({
          operation: 'fork',
          detail: 'agent could not fork the session',
          cause: forked.error,
        })
      }
      const copied = await copySessionSystemPrompt({
        sourceSessionId: sessionId,
        targetSessionId: forked.data.id,
      })
      if (copied instanceof Error) { await abandon(); return copied }
      await copySessionPreferences({
        sourceSessionId: sessionId,
        targetSessionId: forked.data.id,
        channelId: event.channel_id,
        directory: forkDirectory,
        getClient: () => ({ ...openCodeCatalogGetter(() => client)(), session: client.session }),
      })
      const root = await this.api.post({
        channel: event.channel_id,
        text: `Fork: ${forked.data.title}`,
      })
      if (root instanceof Error) { await abandon(); return root }
      const id = slackThreadId({
        workspaceId: this.workspaceId,
        channelId: event.channel_id,
        threadTs: root.id,
      })
      await setThreadSession(id, forked.data.id)
      await markPendingForkTitle(forked.data)
      const working = await getThreadWorkingDirectory(runtime.threadId)
      if (workspace.binding) {
        await setThreadWorkingDirectory({ threadId: id, ...workspace.binding })
      } else if (working)
        await setThreadWorkingDirectory({
          ...working,
          threadId: id,
          projectDirectory: runtime.projectDirectory,
        })
      const fork = await this.runtimeFor(event.channel_id, root.id)
      if (fork instanceof Error) return fork
      if (workspace.binding) await fork.chat.sendNotice(forkWorkspaceNotice(workspace.binding))
      if (words.length) {
        await fork.enqueueIncoming({
          prompt: words.join(' '),
          userId: event.user_id,
          username: identity.actor.name,
        })
        const info = await backend().sessions.get({ sessionId: forked.data.id, directory: runtime.sdkDirectory })
        if (info instanceof Error) logger.warn('Could not display generated fork title:', info)
        else if (info && info.title !== forked.data.title) await this.api.edit({ channel: event.channel_id, ts: root.id, text: `Fork: ${info.title}` })
      }
      return
    }
    if (name === 'session') {
      await runtime.chat.sendNotice(`Session: ${sessionId}\nThread: ${runtime.threadId}`)
      return
    }
    await runtime.enqueueIncoming({
      prompt: '',
      command: { name: name ?? '', arguments: words.join(' ') },
      userId: event.user_id,
      username: identity.actor.name,
    })
  }

  private async commandModal(input: {
    event: z.infer<typeof commandSchema>
    operation: string
    target?: string
    choices: Array<{ label: string; value: string }>
    arguments?: boolean
  }) {
    if (!input.choices.length)
      return new SlackApiError({
        operation: 'command',
        detail: 'no available choices; configure the agent backend first',
      })
    const id = crypto.randomBytes(8).toString('hex')
    await (
      await getDb()
    )
      .insert(schema.chat_interactions)
      .values({
        id,
        thread_id: `slack-channel:${this.workspaceId}:${input.event.channel_id}`,
        kind: 'command',
        message_id: '',
        payload_json: JSON.stringify({
          event: input.event,
          operation: input.operation,
          target: input.target,
        }),
      })
    const opened = await this.api.call(
      'views.open',
      {
        trigger_id: input.event.trigger_id,
        view: {
          type: 'modal',
          private_metadata: id,
          title: { type: 'plain_text', text: `Roadie ${input.operation}`.slice(0, 24) },
          submit: { type: 'plain_text', text: 'Apply' },
          blocks: [
            {
              type: 'input',
              block_id: 'choice',
              label: { type: 'plain_text', text: input.target ? 'Choose' : 'Session' },
              element: {
                type: 'static_select',
                action_id: 'choice',
                options: input.choices
                  .slice(0, 100)
                  .map((choice) => ({
                    text: { type: 'plain_text', text: choice.label.slice(0, 75) },
                    value: choice.value,
                  })),
              },
            },
            ...(input.arguments
              ? [
                  {
                    type: 'input',
                    block_id: 'arguments',
                    optional: true,
                    label: { type: 'plain_text', text: 'Arguments or prompt' },
                    element: { type: 'plain_text_input', action_id: 'arguments', multiline: true },
                  },
                ]
              : []),
          ],
        },
      },
      z.object({ ok: z.literal(true) }),
    )
    if (opened instanceof Error)
      await (
        await getDb()
      )
        .delete(schema.chat_interactions)
        .where(orm.eq(schema.chat_interactions.id, id))
    return opened instanceof Error ? opened : undefined
  }
}

/** CLI service entrypoint; configuration/hooks have already been applied. */
export async function runNativeSlack(): Promise<void | Error> {
  const { getDataDir, readRoadieSecret } = await import('./config.js')
  const { startHranaServer, stopHranaServer } = await import('./hrana-server.js')
  const { initDatabase, closeDatabase } = await import('./database.js')
  const { cleanupOrphanedAgentServer, markServiceProcess, recordInterruptedSessions } =
    await import('./service-lifecycle.js')
  const { snapshotBusyRuntimes } = await import('./session-handler/thread-session-runtime.js')
  const { stopOpencodeServer } = await import('./opencode.js')
  const path = await import('node:path')
  const token = readRoadieSecret('ROADIE_SLACK_BOT_TOKEN')
  const signingSecret = readRoadieSecret('ROADIE_SLACK_SIGNING_SECRET')
  if (!token || !signingSecret)
    return new SlackApiError({
      operation: 'startup',
      detail:
        'set ROADIE_SLACK_BOT_TOKEN and ROADIE_SLACK_SIGNING_SECRET (or their _FILE variants)',
    })
  process.env.ROADIE_PLATFORM = 'slack'
  // The agent gets the send capability, not Slack's reusable credentials or
  // credential-file paths. The native adapter alone owns those secrets.
  for (const name of [
    'ROADIE_SLACK_BOT_TOKEN',
    'ROADIE_SLACK_BOT_TOKEN_FILE',
    'ROADIE_SLACK_SIGNING_SECRET',
    'ROADIE_SLACK_SIGNING_SECRET_FILE',
  ])
    delete process.env[name]
  const port = Number(process.env.ROADIE_SLACK_PORT ?? '4000')
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return new SlackApiError({
      operation: 'startup',
      detail: 'ROADIE_SLACK_PORT must be between 1 and 65535',
    })
  markServiceProcess()
  const hrana = await startHranaServer({ dbPath: path.join(getDataDir(), 'discord-sessions.db') })
  if (hrana instanceof Error) return hrana
  await cleanupOrphanedAgentServer()
  await initDatabase()
  const bot = new NativeSlackBot({
    token,
    signingSecret,
    port,
    workspaceId: process.env.ROADIE_SLACK_WORKSPACE_ID,
  })
  const started = await bot.start()
  if (started instanceof Error) {
    await closeDatabase()
    await stopHranaServer()
    return started
  }
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    recordInterruptedSessions(snapshotBusyRuntimes())
    const deadline = setTimeout(() => process.exit(1), 15_000)
    void (async () => {
      await bot.stop()
      await stopOpencodeServer()
      await closeDatabase()
      await stopHranaServer()
      clearTimeout(deadline)
    })().catch((error) => logger.error('Slack shutdown failed', error))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
