// Native Slack Web API boundary. No Discord IDs, objects, gateway or REST emulation.
import * as errore from 'errore'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebClient, LogLevel } from '@slack/web-api'
import { createLogger } from '../logger.js'

export class SlackApiError extends errore.createTaggedError({
  name: 'SlackApiError',
  message: 'Slack $operation failed: $detail',
}) {
  get retryable(): boolean {
    return /request failed|HTTP (429|5\d\d)|backend is unavailable/.test(String(this.detail))
  }
}

export const slackMessageSchema = z
  .object({ ts: z.string(), text: z.string().default('') })
  .passthrough()
const logger = createLogger('SLACK_API')

export class SlackApi {
  private readonly client: WebClient
  constructor(readonly options: { token: string; apiUrl?: string }) {
    this.client = new WebClient(options.token, {
      slackApiUrl: options.apiUrl,
      timeout: 30_000,
      retryConfig: { retries: 2, minTimeout: 500, maxTimeout: 2000 },
      rejectRateLimitedCalls: false,
      allowAbsoluteUrls: false,
      // Axios request objects can contain Authorization headers. Keep those
      // out of error chains while preserving the SDK's own typed failure.
      attachOriginalToWebAPIRequestError: false,
      logger: {
        debug() {},
        info() {},
        warn: (...data: unknown[]) => logger.warn(...data),
        error: (...data: unknown[]) => logger.error(...data),
        getLevel: () => LogLevel.ERROR,
        setLevel() {},
        setName() {},
      },
    })
  }

  async call<T extends z.ZodType>(
    operation: string,
    body: Record<string, unknown>,
    schema: T,
  ): Promise<z.infer<T> | SlackApiError> {
    const payload = await this.client.apiCall(operation, body).catch((cause: unknown) => {
      const failure = z
        .object({ data: z.object({ error: z.string() }).optional() })
        .safeParse(cause)
      return new SlackApiError({
        operation,
        detail: failure.success ? (failure.data.data?.error ?? 'request failed') : 'request failed',
        cause,
      })
    })
    if (payload instanceof Error) return payload
    const parsed = schema.safeParse(payload)
    if (!parsed.success) return new SlackApiError({ operation, detail: parsed.error.message })
    return parsed.data
  }

  async post(input: {
    channel: string
    threadTs?: string
    text: string
    blocks?: unknown[]
    notify?: boolean
  }) {
    const result = await this.call(
      'chat.postMessage',
      {
        channel: input.channel,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        text: slackText(input.text, input.notify),
        ...(input.blocks ? { blocks: input.blocks } : {}),
        unfurl_links: false,
        unfurl_media: false,
        link_names: false,
      },
      z.object({ ts: z.string() }),
    )
    if (result instanceof Error) return result
    return { id: result.ts }
  }

  async edit(input: { channel: string; ts: string; text: string; blocks?: unknown[] }) {
    const result = await this.call(
      'chat.update',
      {
        channel: input.channel,
        ts: input.ts,
        text: slackText(input.text),
        ...(input.blocks ? { blocks: input.blocks } : {}),
      },
      z.object({ ok: z.literal(true) }),
    )
    return result instanceof Error ? result : undefined
  }

  async read(input: { channel: string; threadTs: string; ts: string }) {
    const result = await this.call(
      'conversations.replies',
      {
        channel: input.channel,
        ts: input.threadTs,
        oldest: input.ts,
        latest: input.ts,
        inclusive: true,
        limit: 1,
      },
      z.object({ messages: z.array(slackMessageSchema) }),
    )
    if (result instanceof Error) return result
    const message = result.messages.find((item) => item.ts === input.ts)
    return (
      message?.text ??
      new SlackApiError({ operation: 'conversations.replies', detail: 'message not found' })
    )
  }

  async downloadFile(fileId: string) {
    const info = await this.call(
      'files.info',
      { file: fileId },
      z.object({
        file: z.object({
          id: z.string(),
          name: z.string(),
          mimetype: z.string().default('application/octet-stream'),
          url_private: z.string(),
        }),
      }),
    )
    if (info instanceof Error) return info
    const target = new URL(info.file.url_private)
    const localOrigin = this.options.apiUrl ? new URL(this.options.apiUrl).origin : null
    const trusted =
      target.protocol === 'https:' &&
      (target.hostname === 'files.slack.com' || target.hostname.endsWith('.slack-files.com'))
    if (!trusted && !(localOrigin && target.origin === localOrigin))
      return new SlackApiError({
        operation: 'files.info',
        detail: 'file download URL is not a Slack file origin',
      })
    const response = await fetch(target, {
      headers: { authorization: `Bearer ${this.options.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }).catch(
      (cause) =>
        new SlackApiError({ operation: 'files.download', detail: 'request failed', cause }),
    )
    if (response instanceof Error) return response
    if (!response.ok)
      return new SlackApiError({ operation: 'files.download', detail: `HTTP ${response.status}` })
    const chunks: Uint8Array[] = []
    let size = 0
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 20 * 1024 * 1024)
          return new SlackApiError({ operation: 'files.download', detail: 'file exceeds 20 MiB' })
        chunks.push(chunk)
      }
    return { ...info.file, bytes: Buffer.concat(chunks) }
  }

  async uploadFile(input: { channel: string; threadTs: string; filePath: string }) {
    const bytes = await fs
      .readFile(input.filePath)
      .catch(
        (cause) =>
          new SlackApiError({ operation: 'files.upload', detail: 'cannot read local file', cause }),
      )
    if (bytes instanceof Error) return bytes
    const prepared = await this.call(
      'files.getUploadURLExternal',
      { filename: path.basename(input.filePath), length: bytes.length },
      z.object({ upload_url: z.string(), file_id: z.string() }),
    )
    if (prepared instanceof Error) return prepared
    const uploaded = await fetch(prepared.upload_url, {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(30_000),
    }).catch(
      (cause) => new SlackApiError({ operation: 'files.upload', detail: 'request failed', cause }),
    )
    if (uploaded instanceof Error) return uploaded
    if (!uploaded.ok)
      return new SlackApiError({ operation: 'files.upload', detail: `HTTP ${uploaded.status}` })
    const completed = await this.call(
      'files.completeUploadExternal',
      {
        files: [{ id: prepared.file_id, title: path.basename(input.filePath) }],
        channel_id: input.channel,
        thread_ts: input.threadTs,
      },
      z.object({ ok: z.literal(true) }),
    )
    return completed instanceof Error ? completed : undefined
  }
}

/** Convert only prose; fenced and inline code are left byte-for-byte intact. */
export function slackText(markdown: string, notify = false): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, index) => {
      if (index % 2) return part
      return part
        .replace(/^\s*-#\s?/gm, '')
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/\*\*([^*]+)\*\*/g, '*$1*')
        .replace(/~~([^~]+)~~/g, '~$1~')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>')
        .replace(/<@([A-Z0-9]+)>/g, notify ? '<@$1>' : '&lt;@$1&gt;')
        .replace(/<!([^>]+)>/g, '&lt;!$1&gt;')
    })
    .join('')
}

export function slackThreadId(input: {
  workspaceId: string
  channelId: string
  threadTs: string
}): string {
  return `slack:${input.workspaceId}:${input.channelId}:${input.threadTs}`
}

export function parseSlackThreadId(
  id: string,
): { workspaceId: string; channelId: string; threadTs: string } | null {
  const match = /^slack:([A-Z0-9]+):([A-Z0-9]+):(\d+\.\d+)$/.exec(id)
  return match ? { workspaceId: match[1]!, channelId: match[2]!, threadTs: match[3]! } : null
}
