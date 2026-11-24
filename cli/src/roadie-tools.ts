// Roadie's own agent tools, independent of the agent backend:
// - roadie_file_upload: prompts the chat user to upload files via native picker
// - roadie_action_buttons: shows clickable action buttons in the thread
// - roadie_sleep: persist a wake time so the session can sleep hours or days
// - roadie_user_lookup: find guild members' mention IDs without a shell
//
// IPC tools talk to the bot via SQLite rows; sleep writes session_sleeps.
// Pi forwards each call to the bot process (./agent-backend/pi/backend.ts).

import dedent from 'string-dedent'
import { z } from 'zod'

const FILE_UPLOAD_TIMEOUT_MS = 6 * 60 * 1000
const DEFAULT_FILE_UPLOAD_MAX_FILES = 5
const ACTION_BUTTON_TIMEOUT_MS = 30 * 1000

/** What a tool returns: plain output, or output with a short title for the chat tool line. */
export type RoadieToolResult = string | { title: string; output: string }

export type RoadieToolContext = { sessionId: string; directory: string }

export type RoadieTool<Args extends z.ZodRawShape = z.ZodRawShape> = {
  name: string
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: RoadieToolContext): Promise<RoadieToolResult>
}

function defineTool<Args extends z.ZodRawShape>(tool: RoadieTool<Args>): RoadieTool<Args> {
  return tool
}

async function loadDatabaseModule() {
  // Lazy: tool definitions can load before bot-side Hrana configuration.
  return import('./database.js')
}

async function pollIpcResponse({ id, timeoutMs, intervalMs }: { id: string; timeoutMs: number; intervalMs: number }) {
  const { getIpcRequestById } = await loadDatabaseModule()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs)
    })
    const updated = await getIpcRequestById({ id })
    if (!updated || updated.status === 'cancelled') return 'cancelled' as const
    if (updated.response) return updated.response
  }
  return 'timeout' as const
}

export const roadieFileUpload = defineTool({
  name: 'roadie_file_upload',
  description:
    'Prompt the chat user to upload files using a native file picker modal. ' +
    'The user sees a button, clicks it, and gets a file upload dialog. ' +
    'Returns the local attachment paths of downloaded files. ' +
    'Use this when you need the user to provide files (images, documents, configs, etc.). ' +
    'You MUST call roadie_file_upload LAST, after ALL text. NEVER call it before your text.',
  args: {
    prompt: z.string().describe('Message shown to the user explaining what files to upload'),
    maxFiles: z.number().min(1).max(10).optional().describe('Maximum number of files the user can upload (1-10, default 5)'),
  },
  async execute({ prompt, maxFiles }, context) {
    const { getThreadIdBySessionId, createIpcRequest } = await loadDatabaseModule()
    const threadId = await getThreadIdBySessionId(context.sessionId)
    if (!threadId) return 'Could not find thread for current session'
    const ipcRow = await createIpcRequest({
      type: 'file_upload',
      sessionId: context.sessionId,
      threadId,
      payload: JSON.stringify({ prompt, maxFiles: maxFiles || DEFAULT_FILE_UPLOAD_MAX_FILES, directory: context.directory }),
    })
    const response = await pollIpcResponse({ id: ipcRow.id, timeoutMs: FILE_UPLOAD_TIMEOUT_MS, intervalMs: 300 })
    if (response === 'cancelled') return 'File upload was cancelled'
    if (response === 'timeout') return 'File upload timed out - user did not upload files within the time limit'
    const parsed = JSON.parse(response) as { filePaths?: string[]; error?: string }
    if (parsed.error) return `File upload failed: ${parsed.error}`
    const filePaths = parsed.filePaths || []
    if (filePaths.length === 0) return 'No files were uploaded (user may have cancelled or sent a new message)'
    return `Files uploaded successfully:\n${filePaths.join('\n')}`
  },
})

export const roadieActionButtons = defineTool({
  name: 'roadie_action_buttons',
  description: dedent`
    Show action buttons in the current chat thread for quick confirmations.
    Use this when the user can respond by clicking one of up to 3 buttons.
    Prefer a single button whenever possible.
    Default color is white (same visual style as permission deny button).
    If you need more than 3 options, use \`question\` instead.
    Put everything the user should read before clicking (explanation, links,
    codes, instructions) in \`message\`. Roadie posts it verbatim ahead of the
    buttons; do not repeat it as text. Call roadie_action_buttons LAST.

    Examples:
    - message: "Deploy **v2.3** to production?"
      buttons: [{"label":"Yes, proceed"}]
    - message: "Open https://example.com/approve and approve the request, then click below."
      buttons: [{"label":"Approved","color":"green"}]
  `,
  args: {
    message: z.string().min(1).describe('Markdown the user reads with the buttons, posted verbatim. Put every link, code and instruction here; do not repeat it as text.'),
    buttons: z
      .array(
        z.object({
          label: z.string().min(1).max(80).describe('Button label shown to the user (1-80 chars)'),
          color: z.enum(['white', 'blue', 'green', 'red']).optional().describe('Optional button color. white is default and preferred for most confirmations.'),
        }),
      )
      .min(1)
      .max(3)
      .describe('Array of 1-3 action buttons. Prefer one button whenever possible.'),
  },
  async execute({ buttons }, context) {
    const { getThreadIdBySessionId, createIpcRequest } = await loadDatabaseModule()
    const threadId = await getThreadIdBySessionId(context.sessionId)
    if (!threadId) return 'Could not find thread for current session'
    const ipcRow = await createIpcRequest({
      type: 'action_buttons',
      sessionId: context.sessionId,
      threadId,
      payload: JSON.stringify({ buttons, directory: context.directory }),
    })
    const response = await pollIpcResponse({ id: ipcRow.id, timeoutMs: ACTION_BUTTON_TIMEOUT_MS, intervalMs: 200 })
    if (response === 'cancelled') return 'Action button request was cancelled'
    if (response === 'timeout') return 'Action button request timed out'
    const parsed = JSON.parse(response) as { ok?: boolean; error?: string }
    if (parsed.error) return `Action button request failed: ${parsed.error}`
    return `Action button(s) shown: ${buttons.map((button) => button.label).join(', ')}`
  },
})

export const roadieSleep = defineTool({
  name: 'roadie_sleep',
  description: dedent`
    Sleep this session until a future time. Roadie later posts a wake
    message in this thread and the same session continues.
    Use this to wait hours or days for CI, a deploy, a date, or any later event.
    The sleep is stored in SQLite and survives bot restarts.

    Pass either duration (2h, 30m, 1d) or until (UTC ISO ending with Z).
    Do not pass both. You MUST call roadie_sleep LAST, after ALL text.
    Do not call more tools after it.

    The tool result is not a wake. After it succeeds, write one short
    waiting line and stop. Do not continue the waited work until a later
    chat message that starts with "Woke after sleeping until".
    A new user message cancels the sleep. If you still need that later
    wake after answering, call roadie_sleep again with until set to the
    original UTC time.
  `,
  args: {
    duration: z.string().optional().describe('Relative wait. Examples: 30s, 2h, 1d. Do not pass with until.'),
    until: z.string().optional().describe('UTC ISO date ending with Z. Example: 2026-08-20T09:00:00Z.'),
    reason: z.string().optional().describe('Why the session is sleeping. Shown when it wakes.'),
  },
  async execute({ duration, until, reason }, context) {
    const { parseSleepWakeAt, formatSessionSleepToolOutput } = await import('./task-schedule.js')
    const { formatChatTime } = await import('./message-formatting.js')
    const wakeAt = parseSleepWakeAt({ duration, until, now: new Date() })
    if (wakeAt instanceof Error) return wakeAt.message
    const { getThreadIdBySessionId, upsertSessionSleep } = await loadDatabaseModule()
    // Only a check that a thread owns this session: subagents have none.
    // The wake resolves the thread again at delivery time, so nothing
    // here can go stale if the session is rebound later.
    const threadId = await getThreadIdBySessionId(context.sessionId)
    if (!threadId) return 'sleep is only available in the main session'
    await upsertSessionSleep({ sessionId: context.sessionId, wakeAt, reason })
    // The title carries the resolved absolute time so the chat shows the
    // real wake instant instead of a relative input like "2h".
    return { title: `until ${formatChatTime(wakeAt)}`, output: formatSessionSleepToolOutput({ wakeAt, reason }) }
  },
})

const USER_LOOKUP_LIMIT = 20

/**
 * Side effects of roadie_user_lookup, injectable for tests. The guild always
 * comes from the session's own thread, never from model input, so a lookup
 * stays scoped to the guild the session lives in.
 */
export type UserLookupDeps = {
  getThreadId(sessionId: string): Promise<string | undefined>
  getGuildId(threadId: string): Promise<string | undefined | Error>
  searchMembers(args: { guildId: string; query: string; limit: number }): Promise<unknown | Error>
}

async function defaultUserLookupDeps(): Promise<UserLookupDeps> {
  const { Routes } = await import('discord.js')
  const { createDiscordRest } = await import('./discord-urls.js')
  const { readRoadieSecret } = await import('./config.js')
  const { getThreadIdBySessionId, getBotToken } = await loadDatabaseModule()
  // Runs inside the bot process (the backend forwards tool calls there), so
  // the bot's own credentials do the lookup, same as `roadie user list`.
  let rest: ReturnType<typeof createDiscordRest> | undefined
  const getRest = async () => {
    if (rest) return rest
    const token = readRoadieSecret('ROADIE_BOT_TOKEN') || (await getBotToken().catch(() => undefined))?.token
    if (!token) return new Error('No bot token available for member lookup')
    rest = createDiscordRest(token)
    return rest
  }
  return {
    getThreadId: async (sessionId) => (await getThreadIdBySessionId(sessionId)) ?? undefined,
    async getGuildId(threadId) {
      const client = await getRest()
      if (client instanceof Error) return client
      const channel = await client.get(Routes.channel(threadId)).catch((cause: unknown) => new Error('Could not fetch thread', { cause }))
      if (channel instanceof Error) return channel
      const guildId = typeof channel === 'object' && channel !== null ? Reflect.get(channel, 'guild_id') : undefined
      return typeof guildId === 'string' ? guildId : undefined
    },
    async searchMembers({ guildId, query, limit }) {
      const client = await getRest()
      if (client instanceof Error) return client
      return client
        .get(Routes.guildMembersSearch(guildId), { query: new URLSearchParams({ query, limit: String(limit) }) })
        .catch((cause: unknown) => new Error('Discord member search failed', { cause }))
    },
  }
}

/** Resolve guild members matching `query` in the guild of the session's thread. */
export async function lookupThreadGuildUsers({ query, sessionId, deps }: { query: string; sessionId: string; deps: UserLookupDeps }): Promise<string> {
  const { isDiscordMemberLookupUnavailable, formatMemberLookupUnavailableMessage, isGuildMemberSearchResult } = await import('./cli-runner.js')
  const trimmed = query.trim()
  if (!trimmed) return 'Provide a non-empty name fragment to search for'
  const threadId = await deps.getThreadId(sessionId)
  if (!threadId) return 'Could not find thread for current session; user lookup is only available in a chat thread'
  const guildId = await deps.getGuildId(threadId)
  if (guildId instanceof Error) return `User lookup failed: ${guildId.message}`
  if (!guildId) return 'This thread is not in a Discord server, so there are no guild members to look up'
  const result = await deps.searchMembers({ guildId, query: trimmed, limit: USER_LOOKUP_LIMIT })
  if (result instanceof Error) {
    if (isDiscordMemberLookupUnavailable(result) || (result.cause instanceof Error && isDiscordMemberLookupUnavailable(result.cause))) {
      return `${formatMemberLookupUnavailableMessage()}\nIn chat, mention a known user ID from chat metadata as <@ID>.`
    }
    return `User lookup failed: ${result.message}`
  }
  const members = (Array.isArray(result) ? result : [])
    .filter((member): member is object => typeof member === 'object' && member !== null)
    .filter(isGuildMemberSearchResult)
    .slice(0, USER_LOOKUP_LIMIT)
  if (members.length === 0) return `No users found matching "${trimmed}"`
  const lines = members.map((member) => {
    const displayName = member.nick || member.user.global_name || member.user.username
    return `${displayName} (ID: ${member.user.id}) - mention: <@${member.user.id}>`
  })
  return `Found ${members.length} users matching "${trimmed}":\n${lines.join('\n')}`
}

export const roadieUserLookup = defineTool({
  name: 'roadie_user_lookup',
  description: dedent`
    Look up members of this thread's Discord server by name to get their
    user ID and mention. Use it to ping someone who has not spoken in the
    thread: put the returned <@ID> mention in your reply.
    Prefer IDs already in chat metadata. Returns at most 20 matches.
  `,
  args: {
    query: z.string().min(1).describe('Name fragment to search for (username, display name or nickname).'),
  },
  async execute({ query }, context) {
    return lookupThreadGuildUsers({ query, sessionId: context.sessionId, deps: await defaultUserLookupDeps() })
  },
})

export const ROADIE_TOOLS: RoadieTool[] = [roadieFileUpload, roadieActionButtons, roadieSleep, roadieUserLookup] as unknown as RoadieTool[]

/** Name, description and JSON Schema of each tool, for backends that register tools by schema. */
export function roadieToolSchemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return ROADIE_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(z.object(tool.args)) as Record<string, unknown>,
  }))
}

/** Validate and run a tool by name. Unknown tools and bad arguments come back as an Error. */
export async function runRoadieTool({ name, args, context }: { name: string; args: unknown; context: RoadieToolContext }): Promise<RoadieToolResult | Error> {
  const tool = ROADIE_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return new Error(`Unknown Roadie tool ${name}`)
  const parsed = z.object(tool.args).safeParse(args)
  if (!parsed.success) return new Error(`Invalid arguments for ${name}: ${parsed.error.message}`)
  return tool.execute(parsed.data, context).catch((cause: unknown) => new Error(`${name} failed`, { cause }))
}
