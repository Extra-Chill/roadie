import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as orm from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../database.js'
import * as schema from '../schema.js'
import { getPermissionTimeoutMs, getDataDir } from '../config.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import { getOpencodeClient } from '../opencode.js'
import { getRuntime } from '../session-handler/thread-session-runtime.js'
import { createLogger } from '../logger.js'
import type { ChatThread, ChatInteractions } from './types.js'
import { SlackApi, SlackApiError, slackText, slackThreadId } from './slack-api.js'

const logger = createLogger('SLACK')
const questionSchema = z.object({
  question: z.string(),
  header: z.string(),
  multiple: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
})
const pendingSchema = z.object({
  directory: z.string(),
  sessionId: z.string(),
  requestIds: z.array(z.string()).default([]),
  questions: z.array(questionSchema).default([]),
  answers: z.record(z.string(), z.array(z.string())).default({}),
  buttons: z.array(z.object({ label: z.string(), color: z.string().optional() })).default([]),
  maxFiles: z.number().int().min(1).max(10).default(5),
})
type Pending = z.infer<typeof pendingSchema> & {
  kind: string
  messageId: string
  createdAt: number
}

export const slackInteractionSchema = z.object({
  type: z.enum(['block_actions', 'view_submission', 'view_closed']),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string(), username: z.string().optional(), name: z.string().optional() }),
  channel: z.object({ id: z.string() }).optional(),
  message: z.object({ ts: z.string(), thread_ts: z.string().optional() }).optional(),
  trigger_id: z.string().optional(),
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        value: z.string().optional(),
        selected_option: z.object({ value: z.string() }).nullable().optional(),
        selected_options: z.array(z.object({ value: z.string() })).optional(),
      }),
    )
    .optional(),
  view: z
    .object({
      private_metadata: z.string(),
      state: z
        .object({
          values: z.record(
            z.string(),
            z.record(
              z.string(),
              z
                .object({
                  value: z.string().nullable().optional(),
                  selected_option: z.object({ value: z.string() }).nullable().optional(),
                  files: z.array(z.union([z.string(), z.object({ id: z.string() })])).optional(),
                })
                .passthrough(),
            ),
          ),
        })
        .optional(),
    })
    .optional(),
})
export type SlackInteraction = z.infer<typeof slackInteractionSchema>

const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 75) })
const section = (text: string) => ({
  type: 'section',
  text: { type: 'mrkdwn', text: slackText(text).slice(0, 3000) },
})
const button = (label: string, actionId: string, style?: string) => ({
  type: 'button',
  text: plain(label),
  action_id: actionId,
  ...(style ? { style } : {}),
})

/** One native Slack thread, including durable Block Kit interaction contexts. */
export class SlackChatThread implements ChatThread {
  readonly platform = 'slack'
  readonly capabilities = { rename: false, typing: false }
  readonly id: string
  readonly name = ''
  readonly parentId: string
  readonly spaceId: string
  readonly createdAt: number
  readonly botUserId: string
  readonly interactions: ChatInteractions
  private readonly pending = new Map<string, Pending>()
  private readonly permissionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly uploadWaiters = new Map<string, (paths: string[]) => void>()

  private constructor(
    readonly options: {
      api: SlackApi
      workspaceId: string
      channelId: string
      threadTs: string
      botUserId: string
    },
  ) {
    this.id = slackThreadId(options)
    this.parentId = options.channelId
    this.spaceId = options.workspaceId
    this.createdAt = Math.floor(Number(options.threadTs) * 1000)
    this.botUserId = options.botUserId
    this.interactions = {
      permission: async ({ permission, directory, subtaskLabel }) => {
        const contextHash = await this.show({
          kind: 'permission',
          directory,
          sessionId: permission.sessionId,
          requestIds: [permission.id],
          text: `**Permission Required**\n${subtaskLabel ? `From: ${subtaskLabel}\n` : ''}${permission.permission}: ${permission.patterns.join(', ')}`,
          blocks: (hash) => [
            {
              type: 'actions',
              elements: [
                button('Accept', `roadie:p:${hash}:once`, 'primary'),
                button('Accept Always', `roadie:p:${hash}:always`, 'primary'),
                button('Deny', `roadie:p:${hash}:reject`, 'danger'),
              ],
            },
          ],
        })
        const pending = this.pending.get(contextHash)!
        this.armPermissionTimeout(contextHash, pending)
        return { contextHash, messageId: pending.messageId }
      },
      addPermissionRequest: ({ contextHash, requestId }) => {
        const pending = this.pending.get(contextHash)
        if (!pending) return false
        if (!pending.requestIds.includes(requestId)) pending.requestIds.push(requestId)
        void this.persist(contextHash, pending).catch((error) =>
          logger.error('Cannot persist permission request', error),
        )
        return true
      },
      clearPermission: (hash) => {
        void this.remove(hash).catch((error) => logger.error('Cannot clear permission', error))
      },
      question: async (input) => {
        if (
          [...this.pending.values()].some(
            (item) => item.kind === 'question' && item.requestIds.includes(input.requestId),
          )
        )
          return
        await this.show({
          kind: 'question',
          directory: input.directory,
          sessionId: input.sessionId,
          requestIds: [input.requestId],
          questions: input.input.questions,
          text: input.input.questions.map((q) => q.question).join('\n'),
          blocks: (hash) => [
            ...input.input.questions.flatMap((question, index) => [
              section(question.question),
              {
                type: 'actions',
                elements: [
                  {
                    type: question.multiple ? 'multi_static_select' : 'static_select',
                    action_id: `roadie:q:${hash}:${index}`,
                    placeholder: plain(question.header),
                    options: question.options.map((option, choice) => ({
                      text: plain(option.label),
                      value: String(choice),
                      ...(option.description ? { description: plain(option.description) } : {}),
                    })),
                  },
                ],
              },
            ]),
            {
              type: 'actions',
              elements: [
                button('Type your own answer', `roadie:c:${hash}:custom`),
                ...(input.input.questions.some((question) => question.multiple)
                  ? [button('Submit answers', `roadie:s:${hash}:submit`, 'primary')]
                  : []),
              ],
            },
          ],
        })
      },
      actions: async (input) => {
        await this.show({
          kind: 'actions',
          directory: input.directory,
          sessionId: input.sessionId,
          buttons: input.buttons,
          text: '**Action Required**',
          blocks: (hash) => [
            {
              type: 'actions',
              elements: input.buttons.map((option, index) =>
                button(
                  option.label,
                  `roadie:a:${hash}:${index}`,
                  option.color === 'red'
                    ? 'danger'
                    : option.color === 'green'
                      ? 'primary'
                      : undefined,
                ),
              ),
            },
          ],
        })
      },
      upload: async (input) => {
        const hash = await this.show({
          kind: 'upload',
          directory: input.directory,
          sessionId: input.sessionId,
          maxFiles: input.maxFiles,
          text: input.prompt,
          blocks: (id) => [
            { type: 'actions', elements: [button('Upload files', `roadie:f:${id}:open`)] },
          ],
        })
        return new Promise<string[]>((resolve) => this.uploadWaiters.set(hash, resolve))
      },
      hasQuestion: () => [...this.pending.values()].some((item) => item.kind === 'question'),
      hasPending: () => this.pending.size > 0,
      cancelQuestion: async () => {
        for (const [hash, item] of this.pending)
          if (item.kind === 'question') await this.remove(hash)
      },
      // Disposal releases timers, not durable prompts. Restarted sessions restore them.
      dispose: () => {
        for (const timer of this.permissionTimers.values()) clearTimeout(timer)
        this.permissionTimers.clear()
        for (const resolve of this.uploadWaiters.values()) resolve([])
        this.uploadWaiters.clear()
      },
    }
  }

  static async create(options: SlackChatThread['options']) {
    const thread = new SlackChatThread(options)
    const rows = await (
      await getDb()
    ).query.chat_interactions.findMany({ where: { thread_id: thread.id } })
    for (const row of rows) {
      const payload = pendingSchema.safeParse(JSON.parse(row.payload_json))
      if (!payload.success) {
        logger.warn(`Invalid Slack interaction ${row.id}`)
        continue
      }
      const pending = {
        ...payload.data,
        kind: row.kind,
        messageId: row.message_id,
        createdAt: row.created_at.getTime(),
      }
      thread.pending.set(row.id, pending)
      if (pending.kind === 'permission') thread.armPermissionTimeout(row.id, pending)
    }
    return thread
  }

  async footerMentionUserId(sessionUserId?: string) {
    return sessionUserId?.startsWith('U') ? sessionUserId : undefined
  }
  async sendNotice(content: string) {
    return this.options.api.post({
      channel: this.parentId,
      threadTs: this.options.threadTs,
      text: content,
    })
  }
  async sendMessage(content: string, options?: { notify?: boolean }) {
    const result = await this.options.api.post({
      channel: this.parentId,
      threadTs: this.options.threadTs,
      text: content,
      notify: options?.notify,
    })
    if (result instanceof Error) throw result
    return result
  }
  async sendPart(content: string, options?: { leadWithBlankLine?: boolean; notify?: boolean }) {
    return this.sendMessage(`${options?.leadWithBlankLine ? '\n' : ''}${content}`, options)
  }
  readMessageText(messageId: string) {
    return this.options.api.read({
      channel: this.parentId,
      threadTs: this.options.threadTs,
      ts: messageId,
    })
  }
  editMessageText(messageId: string, content: string) {
    return this.options.api.edit({ channel: this.parentId, ts: messageId, text: content })
  }
  async sendTyping() {}
  async rename() {}
  async channelTopic() {
    const result = await this.options.api.call(
      'conversations.info',
      { channel: this.parentId },
      z.object({ channel: z.object({ topic: z.object({ value: z.string() }).optional() }) }),
    )
    if (result instanceof Error) {
      logger.warn(result.message)
      return undefined
    }
    return result.channel.topic?.value
  }

  private async persist(hash: string, item: Pending) {
    const db = await getDb()
    await db
      .insert(schema.chat_interactions)
      .values({
        id: hash,
        thread_id: this.id,
        kind: item.kind,
        payload_json: JSON.stringify(item),
        message_id: item.messageId,
      })
      .onConflictDoUpdate({
        target: schema.chat_interactions.id,
        set: { payload_json: JSON.stringify(item) },
      })
  }

  private async remove(hash: string) {
    this.pending.delete(hash)
    clearTimeout(this.permissionTimers.get(hash))
    this.permissionTimers.delete(hash)
    await (
      await getDb()
    )
      .delete(schema.chat_interactions)
      .where(orm.eq(schema.chat_interactions.id, hash))
    getRuntime(this.id)?.onInteractiveUiStateChanged()
  }

  private async show(input: {
    kind: string
    directory: string
    sessionId: string
    requestIds?: string[]
    questions?: Pending['questions']
    buttons?: Pending['buttons']
    maxFiles?: number
    text: string
    blocks: (hash: string) => unknown[]
  }) {
    const hash = crypto.randomBytes(8).toString('hex')
    const result = await this.options.api.post({
      channel: this.parentId,
      threadTs: this.options.threadTs,
      text: input.text,
      blocks: [section(input.text), ...input.blocks(hash)],
      notify: true,
    })
    if (result instanceof Error) throw result
    const item: Pending = {
      kind: input.kind,
      directory: input.directory,
      sessionId: input.sessionId,
      requestIds: input.requestIds ?? [],
      questions: input.questions ?? [],
      answers: {},
      buttons: input.buttons ?? [],
      maxFiles: input.maxFiles ?? 5,
      messageId: result.id,
      createdAt: Date.now(),
    }
    this.pending.set(hash, item)
    await this.persist(hash, item)
    return hash
  }

  private armPermissionTimeout(hash: string, item: Pending) {
    const timer = setTimeout(
      () => {
        void this.replyPermission({ hash, item, reply: 'reject' })
          .then((result) => {
            if (result instanceof Error) logger.error('Slack permission expiry failed', result)
          })
          .catch((error) => logger.error('Slack permission expiry failed', error))
      },
      Math.max(1, item.createdAt + getPermissionTimeoutMs() - Date.now()),
    )
    timer.unref()
    this.permissionTimers.set(hash, timer)
  }

  private async replyPermission(input: {
    hash: string
    item: Pending
    reply: 'once' | 'always' | 'reject'
  }) {
    const backend = await getAgentBackendProvider().initializeForDirectory(input.item.directory)
    if (backend instanceof Error) return backend
    for (const requestId of input.item.requestIds) {
      const result = await backend().sessions.replyPermission({
        directory: input.item.directory,
        requestId,
        reply: input.reply,
      })
      if (result instanceof Error) return result
    }
    await this.remove(input.hash)
    return this.options.api.edit({
      channel: this.parentId,
      ts: input.item.messageId,
      text: `Permission: ${input.reply}`,
      blocks: [],
    })
  }

  private async replyQuestion(hash: string, item: Pending) {
    const client = getOpencodeClient(item.directory)
    if (!client)
      return new SlackApiError({
        operation: 'question',
        detail: 'agent backend is unavailable; retry after it restarts',
      })
    const result = await client.question.reply({
      directory: item.directory,
      requestID: item.requestIds[0]!,
      answers: item.questions.map((_, i) => item.answers[String(i)] ?? []),
    })
    if (result.error)
      return new SlackApiError({
        operation: 'question',
        detail: 'agent rejected answer',
        cause: result.error,
      })
    await this.remove(hash)
    return this.options.api.edit({
      channel: this.parentId,
      ts: item.messageId,
      text: `Answered: ${Object.values(item.answers).flat().join(', ')}`,
      blocks: [],
    })
  }

  /** Called after the native receiver authenticates the actor and channel. */
  async handleInteraction(payload: SlackInteraction) {
    const action = payload.actions?.[0]
    const match = action?.action_id.match(/^roadie:([pqacfs]):([a-f0-9]{16}):(.+)$/)
    const hash = payload.view?.private_metadata ?? match?.[2]
    if (!hash) return new SlackApiError({ operation: 'interaction', detail: 'unknown action' })
    const item = this.pending.get(hash)
    if (!item)
      return new SlackApiError({
        operation: 'interaction',
        detail: 'prompt already answered or expired',
      })
    if (payload.channel && payload.channel.id !== this.parentId)
      return new SlackApiError({ operation: 'interaction', detail: 'channel mismatch' })
    if (payload.message && payload.message.ts !== item.messageId)
      return new SlackApiError({ operation: 'interaction', detail: 'message mismatch' })
    if (payload.type === 'view_closed') {
      if (item.kind === 'upload') {
        this.uploadWaiters.get(hash)?.([])
        this.uploadWaiters.delete(hash)
        await this.remove(hash)
      }
      return
    }
    if (payload.type === 'view_submission') {
      if (item.kind === 'upload') {
        const files = payload.view?.state?.values.files?.files?.files ?? []
        if (files.length > item.maxFiles)
          return new SlackApiError({
            operation: 'files',
            detail: `choose at most ${item.maxFiles} files`,
          })
        const directory = path.join(getDataDir(), 'attachments', hash)
        await fs.mkdir(directory, { recursive: true })
        const paths: string[] = []
        for (const file of files) {
          const downloaded = await this.options.api.downloadFile(
            typeof file === 'string' ? file : file.id,
          )
          if (downloaded instanceof Error) return downloaded
          const filePath = path.join(directory, `${paths.length}-${path.basename(downloaded.name)}`)
          await fs.writeFile(filePath, downloaded.bytes)
          paths.push(filePath)
        }
        this.uploadWaiters.get(hash)?.(paths)
        this.uploadWaiters.delete(hash)
        await this.remove(hash)
        return this.options.api.edit({
          channel: this.parentId,
          ts: item.messageId,
          text: `Uploaded ${paths.length} file(s)`,
          blocks: [],
        })
      }
      if (item.kind !== 'question')
        return new SlackApiError({ operation: 'interaction', detail: 'unexpected modal' })
      for (let i = 0; i < item.questions.length; i++) {
        const answer = payload.view?.state?.values[`q${i}`]?.answer?.value?.trim()
        if (!answer)
          return new SlackApiError({ operation: 'interaction', detail: 'answer every question' })
        item.answers[String(i)] = [answer]
      }
      return this.replyQuestion(hash, item)
    }
    if (match?.[1] === 'f' && item.kind === 'upload' && payload.trigger_id) {
      return this.options.api.call(
        'views.open',
        {
          trigger_id: payload.trigger_id,
          view: {
            type: 'modal',
            private_metadata: hash,
            notify_on_close: true,
            title: plain('Upload files'),
            submit: plain('Upload'),
            close: plain('Cancel'),
            blocks: [
              {
                type: 'input',
                block_id: 'files',
                label: plain('Files'),
                element: { type: 'file_input', action_id: 'files', max_files: item.maxFiles },
              },
            ],
          },
        },
        z.object({ ok: z.literal(true) }),
      )
    }
    if (match?.[1] === 'c' && item.kind === 'question' && payload.trigger_id) {
      return this.options.api.call(
        'views.open',
        {
          trigger_id: payload.trigger_id,
          view: {
            type: 'modal',
            private_metadata: hash,
            title: plain('Answer questions'),
            submit: plain('Submit'),
            close: plain('Cancel'),
            blocks: item.questions.map((question, i) => ({
              type: 'input',
              block_id: `q${i}`,
              label: plain(question.header),
              element: { type: 'plain_text_input', action_id: 'answer', multiline: true },
            })),
          },
        },
        z.object({ ok: z.literal(true) }),
      )
    }
    if (match?.[1] === 'p' && item.kind === 'permission') {
      const reply = z.enum(['once', 'always', 'reject']).safeParse(match[3])
      if (!reply.success)
        return new SlackApiError({ operation: 'permission', detail: 'invalid choice' })
      return this.replyPermission({ hash, item, reply: reply.data })
    }
    if (match?.[1] === 'q' && item.kind === 'question') {
      const index = Number(match[3])
      const question = item.questions[index]
      if (!question || !Number.isInteger(index))
        return new SlackApiError({ operation: 'question', detail: 'invalid question' })
      const choices = question.multiple
        ? (action?.selected_options ?? [])
        : action?.selected_option
          ? [action.selected_option]
          : []
      const labels = choices.map((choice) =>
        /^\d+$/.test(choice.value) ? question.options[Number(choice.value)]?.label : undefined,
      )
      if (!labels.length || labels.some((label) => label === undefined))
        return new SlackApiError({ operation: 'question', detail: 'invalid answer' })
      item.answers[String(index)] = labels.filter((label): label is string => label !== undefined)
      await this.persist(hash, item)
      if (
        !item.questions.some((question) => question.multiple) &&
        item.questions.every((_, i) => item.answers[String(i)]?.length)
      )
        return this.replyQuestion(hash, item)
      return
    }
    if (match?.[1] === 's' && item.kind === 'question') {
      if (!item.questions.every((_, i) => item.answers[String(i)]?.length))
        return new SlackApiError({
          operation: 'question',
          detail: 'answer every question before submitting',
        })
      return this.replyQuestion(hash, item)
    }
    if (match?.[1] === 'a' && item.kind === 'actions') {
      const choice = /^\d+$/.test(match[3]!) ? item.buttons[Number(match[3])]?.label : undefined
      if (!choice) return new SlackApiError({ operation: 'actions', detail: 'invalid choice' })
      const runtime = getRuntime(this.id)
      if (!runtime || runtime.state?.sessionId !== item.sessionId)
        return new SlackApiError({
          operation: 'actions',
          detail: 'session changed; send a new message',
        })
      await this.remove(hash)
      await this.options.api.edit({
        channel: this.parentId,
        ts: item.messageId,
        text: `Selected: ${choice}`,
        blocks: [],
      })
      await runtime.enqueueIncoming({
        prompt: choice,
        userId: payload.user.id,
        username: payload.user.username ?? payload.user.name ?? payload.user.id,
        actorPlatform: 'slack',
      })
      return
    }
    return new SlackApiError({
      operation: 'interaction',
      detail: 'action does not match this prompt',
    })
  }
}
