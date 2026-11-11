// agent session prompt helpers.
// Creates the session-stable system message injected into every Pi
// session, plus per-turn synthetic context for Discord/user/working-directory metadata.
// Keep per-message data out of the system prompt so prompt caching can reuse
// the same session prefix across turns.
//
// The system prompt is pinned per session under
// <dataDir>/session-system-pinned/<sessionId>.txt on the first turn and sent
// unchanged on every later turn, so the provider prompt cache prefix stays
// valid. Channel topic, agent list and roadie prompt text changes therefore
// reach new sessions only; data that must change mid-session goes into the
// per-turn synthetic context. session.command has no `system` field, so the
// context-awareness plugin copies the pinned file onto command user messages.

import { applyFilters } from './hooks.js'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'
import { applyPromptConfig, getPromptConfig, type PromptSection } from './prompt-config.js'
import { store } from './store.js'
import { FilesystemOperationError } from './errors.js'
import { poolCatalog, type PoolCatalog } from './credentials/messages-proxy.js'
import { fetchRemotePoolCatalog, readRemotePoolConfig } from './credentials/remote-pool.js'
import { SHARED_POOL_ID } from './credentials/store.js'

/** Read once when generating a new session's pinned prompt, including remote hosts. */
export async function sessionPoolCatalog(): Promise<PoolCatalog | undefined> {
  if (!store.getState().credentialPoolsEnabled) return undefined
  const remote = readRemotePoolConfig()
  if (remote instanceof Error) return undefined
  if (!remote) return poolCatalog({ dataDir: getDataDir(), poolIds: [SHARED_POOL_ID] })
  const catalog = await fetchRemotePoolCatalog({ config: remote })
  return catalog instanceof Error ? undefined : catalog
}

export function renderModelRotations(catalog?: PoolCatalog): string {
  const lines = Object.entries(catalog?.rotations ?? {})
    .filter(([, rotation]) => rotation.entries.length > 0)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, rotation]) => `- roadie/${name}: ${rotation.entries.join(' → ')}${rotation.description ? ` — ${rotation.description}` : ''}`)
  return lines.length ? `\n## Model rotations\n\n${lines.join('\n')}\nPick a tier with --model roadie/<name>.\n` : ''
}

/**
 * Subfolder for pinned session system prompts. Not `session-system`: the old
 * command path rewrote those files on every command, so they may differ from
 * the prompt last sent and must not be trusted as pinned.
 */
export const SESSION_SYSTEM_PROMPT_DIR = 'session-system-pinned'

/** Stable marker present in every roadie system prompt; used by tests and plugins. */
export const ROADIE_SYSTEM_PROMPT_MARKER = 'via Roadie'

export function getSessionSystemPromptPath({
  sessionId,
  dataDir = getDataDir(),
}: {
  sessionId: string
  dataDir?: string
}) {
  return path.join(dataDir, SESSION_SYSTEM_PROMPT_DIR, `${sessionId}.txt`)
}

/**
 * Persist the roadie system prompt for a session so agent tools can
 * attach it when session.command creates a user message without a system field.
 * Fails loudly on I/O errors so callers do not run session.command without system.
 */
export async function writeSessionSystemPrompt({
  sessionId,
  system,
  dataDir = getDataDir(),
}: {
  sessionId: string
  system: string
  dataDir?: string
}) {
  const filePath = getSessionSystemPromptPath({ sessionId, dataDir })
  const dirPath = path.dirname(filePath)
  await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 })
  // mkdir recursive ignores mode on existing dirs; tighten permissions explicitly.
  await fs.promises.chmod(dirPath, 0o700).catch(() => undefined)
  await fs.promises.writeFile(filePath, system, { encoding: 'utf8', mode: 0o600 })
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined)
}

/**
 * Read a previously persisted session system prompt.
 * Returns null only when the file is missing (ENOENT) or empty.
 * Other I/O errors are rethrown so the plugin can surface them instead of
 * silently dropping roadie system context.
 */
export async function readSessionSystemPrompt({
  sessionId,
  dataDir,
}: {
  sessionId: string
  dataDir: string
}): Promise<string | null> {
  const filePath = getSessionSystemPromptPath({ sessionId, dataDir })
  const content = await fs.promises.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!content?.trim()) {
    return null
  }
  return content
}

/** Remove the side-channel system prompt file for a deleted agent session. */
export async function deleteSessionSystemPrompt({
  sessionId,
  dataDir,
}: {
  sessionId: string
  dataDir: string
}) {
  const filePath = getSessionSystemPromptPath({ sessionId, dataDir })
  await fs.promises.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  })
}

/**
 * Return the pinned system prompt for a session. The first turn pins a freshly
 * generated one. The system prompt precedes all history in the provider prompt
 * cache prefix, so it must never change mid-session. Data that changes later
 * (identity after a fork, user, working directory) goes into per-turn synthetic parts.
 */
export async function resolveSessionSystemPrompt({
  sessionId,
  generate,
  dataDir = getDataDir(),
}: {
  sessionId: string
  generate: () => string | Promise<string>
  dataDir?: string
}): Promise<FilesystemOperationError | string> {
  const pinned = await readSessionSystemPrompt({ sessionId, dataDir }).catch(
    (e) => new FilesystemOperationError({ operation: 'readSessionSystemPrompt', cause: e }),
  )
  if (pinned instanceof Error) return pinned
  if (pinned) return pinned
  const system = await generate()
  const written = await writeSessionSystemPrompt({ sessionId, system, dataDir }).catch(
    (e) => new FilesystemOperationError({ operation: 'writeSessionSystemPrompt', cause: e }),
  )
  if (written instanceof Error) return written
  return system
}

/**
 * Pin the source session's system prompt on a forked session so the fork sends
 * a byte-identical prefix and reuses the source prompt cache. Returns false
 * when the source has no pinned prompt yet; the fork then pins its own.
 */
export async function copySessionSystemPrompt({
  sourceSessionId,
  targetSessionId,
  dataDir = getDataDir(),
}: {
  sourceSessionId: string
  targetSessionId: string
  dataDir?: string
}): Promise<FilesystemOperationError | boolean> {
  const source = await readSessionSystemPrompt({ sessionId: sourceSessionId, dataDir }).catch(
    (e) => new FilesystemOperationError({ operation: 'readSessionSystemPrompt', cause: e }),
  )
  if (source instanceof Error) return source
  if (!source) return false
  const written = await writeSessionSystemPrompt({ sessionId: targetSessionId, system: source, dataDir }).catch(
    (e) => new FilesystemOperationError({ operation: 'writeSessionSystemPrompt', cause: e }),
  )
  if (written instanceof Error) return written
  return true
}

// Backend-neutral: the per-turn reminder names the backend.
const SESSION_ID_LINE_PREFIX = 'Your current session ID is: '
const PARENT_SESSION_ID_LINE_PREFIX = 'Your parent session ID is: '
const SESSION_ID_LINE_PREFIXES = [SESSION_ID_LINE_PREFIX]
const PARENT_SESSION_ID_LINE_PREFIXES = [PARENT_SESSION_ID_LINE_PREFIX]

function sessionIdFromLine(line: string, prefixes: string[]): string | undefined {
  const prefix = prefixes.find((candidate) => line.startsWith(candidate))
  return prefix ? line.slice(prefix.length) : undefined
}

function getParentSessionInstructions(parentSessionId: string) {
  return `${PARENT_SESSION_ID_LINE_PREFIX}${parentSessionId}\nYou can send a message back to the parent session with:\nroadie send --session ${parentSessionId} --prompt 'your update here' --agent <current_agent>\nDo NOT message the parent session unless the user explicitly asks you to.`
}

/** True when the pinned system prompt already names this parent session. */
export function systemPromptHasParentSession({
  system,
  parentSessionId,
}: {
  system: string
  parentSessionId: string
}) {
  return system.split('\n').some((line) => sessionIdFromLine(line, PARENT_SESSION_ID_LINE_PREFIXES) === parentSessionId)
}

/** False when a fork reuses the source session's pinned system prompt. */
export function isSystemPromptForSession({
  system,
  sessionId,
}: {
  system: string
  sessionId: string
}) {
  return system.split('\n').some((line) => sessionIdFromLine(line, SESSION_ID_LINE_PREFIXES) === sessionId)
}

/**
 * True when the pinned system prompt names a session ID other than this one.
 * Prompts without a session line (managed prompt configs) name no session.
 */
export function systemPromptNamesOtherSession({
  system,
  sessionId,
}: {
  system: string
  sessionId: string
}) {
  return system.split('\n').some((line) => {
    const named = sessionIdFromLine(line, SESSION_ID_LINE_PREFIXES)
    return named !== undefined && named !== sessionId
  })
}

/** Where a forked session came from, persisted when the fork is created. */
export type ForkOrigin = {
  sourceSessionId: string
  sourceThreadId: string
}

function getForkOriginNotice({ sourceSessionId, sourceThreadId }: ForkOrigin): string {
  return `This session was forked from thread ${sourceThreadId} (session ${sourceSessionId}); earlier history came from that thread, which continues independently. Message or act on the source session only when the user asks.`
}

/** A thread bound to a directory other than its project root. */
export type WorkingDirectoryInfo = {
  /** Where the session works (cwd). */
  workingDirectory: string
  /** The channel's project root. */
  projectDirectory: string
  /** Short label, such as the checked-out branch. */
  label: string
  /** "git-worktree" for a separate checkout of the project. */
  kind: string
}

export type RepliedMessageContext = {
  authorUsername?: string
  text: string
}

/** YAML marker embedded in thread starter message footer for bot to parse */
export type ThreadStartMarker = {
  /** Single-use nonce the agent API issued for a verified sending session; never a credential. */
  agentSendNonce?: string
  /** Whether to auto-start an AI session */
  start?: boolean
  /** Existing project subfolder or git worktree to bind the thread to */
  cwd?: string
  /** Discord username who initiated the thread */
  username?: string
  /** Discord user ID who initiated the thread */
  userId?: string
  /** Agent to use for the session */
  agent?: string
  /** Model to use (format: provider/model) */
  model?: string
  /** Schedule kind for sessions started by scheduled tasks */
  scheduledKind?: 'at' | 'cron'
  /** Scheduled task ID that triggered this message */
  scheduledTaskId?: number
  /** Scheduled task run ID used to track completion */
  scheduledTaskRunId?: number
  /**
   * Per-session permission overrides as raw "tool:action" or "tool:pattern:action"
   * strings. Parsed into PermissionRuleset entries by parsePermissionRules() in
   * the runtime and appended after buildSessionPermissions() so they win via
   * last-match-wins evaluation.
   */
  permissions?: string[]
  /**
   * Per-session injection guard scan patterns (e.g. "bash:*", "webfetch:*").
   * Written to a temp file after session creation so the injection guard plugin
   * can check per-session whether scanning is enabled.
   */
  injectionGuardPatterns?: string[]
  /**
   * Session ID of the parent session that spawned this thread via
   * `roadie send --parent-session`. Exposed in the child system message so the
    * child can message the parent only when the user explicitly asks.
    */
  parentSessionId?: string
  /** Wake prompt posted after roadie_sleep. Ingress must not cancel this sleep. */
  sleepWake?: boolean
  /** delivery_id of the session_sleeps row this wake delivers. */
  sleepId?: string
}

export function isInjectedPromptMarker({
  marker,
}: {
  marker: ThreadStartMarker | undefined
}): boolean {
  if (!marker) {
    return false
  }
  return Boolean(marker.start)
}

/**
 * How a sent or scheduled session runs. Scheduled-task payloads persist it and
 * start markers carry it to the bot, so both are built from this one shape.
 */
export type SessionRun = {
  agent: string | null
  model: string | null
  username: string | null
  userId: string | null
  permissions: string[] | null
  injectionGuardPatterns: string[] | null
  parentSessionId: string | null
}

/** The start marker for a session run, plus any caller-specific fields (cwd, schedule ids). */
export function buildStartMarker(run: SessionRun, extra: Omit<ThreadStartMarker, keyof SessionRun> = {}): ThreadStartMarker {
  const marker: ThreadStartMarker = { start: true, ...extra }
  if (run.agent) marker.agent = run.agent
  if (run.model) marker.model = run.model
  if (run.username) marker.username = run.username
  if (run.userId) marker.userId = run.userId
  if (run.permissions?.length) marker.permissions = run.permissions
  if (run.injectionGuardPatterns?.length) marker.injectionGuardPatterns = run.injectionGuardPatterns
  if (run.parentSessionId) marker.parentSessionId = run.parentSessionId
  return marker
}

export type AgentInfo = {
  name: string
  description?: string
}

/**
 * Info about the scheduled task that started this session, resolved once per
 * session and kept stable across turns so the system prompt prefix stays
 * cacheable.
 */
export type ScheduledTaskSystemContext = {
  /** Scheduled task ID. Missing for one-shot 'at' tasks (deleted after run). */
  taskId?: number
  scheduleKind: 'at' | 'cron'
  /** Cron expression in the task's timezone. Only set for 'cron' tasks. */
  cronExpr?: string | null
  /** IANA timezone the cron fires in. Defaults to UTC when unset. */
  timezone?: string | null
}

function getScheduledTaskSection(context: ScheduledTaskSystemContext): string {
  const origin = context.taskId
    ? `roadie scheduled task #${context.taskId}`
    : 'a one-time roadie scheduled task'
  const schedule = context.scheduleKind === 'cron' && context.cronExpr
    ? `Schedule: cron \`${context.cronExpr}\`${context.timezone ? ` in ${context.timezone}` : ' in UTC'}.`
    : context.scheduleKind === 'at'
      ? 'This task runs once and does not repeat.'
      : ''
  return `
## scheduled task session

This session was started automatically by ${origin}.
${schedule}
When your run is done, just stop: the task fires again on its schedule and starts a fresh session automatically.
Do NOT use \`roadie_sleep\` to wait for the next run. Sleeping pins this session and never triggers the next one; each firing of the task starts a new session on its own.
`
}

function escapePromptAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapePromptText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function formatWorkingDirectoryReminder(dir: WorkingDirectoryInfo): string {
  const checkout = dir.kind === 'git-worktree'
  const lines = [
    `This thread works in ${dir.workingDirectory}, not the project root. The working directory (cwd / pwd) has changed; read, write, edit, and run checks (tests, builds, lint) there from now on.`,
    checkout
      ? `- It is a separate git checkout of the project (branch: ${dir.label}). The project root ${dir.projectDirectory} is a different checkout that the user or another agent may be working in. Do not read, write, or edit files there.`
      : `- It is a folder inside the project root ${dir.projectDirectory}. Stay inside it unless the user asks otherwise.`,
  ]
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`
}

// A message held behind a busy turn reaches the agent late. Its original send
// time and the wait let the agent tell a late message from a fresh one.
function formatQueuedFor(sentAt: string | undefined, now: number): string | undefined {
  const sent = sentAt ? Date.parse(sentAt) : NaN
  const minutes = Math.floor((now - sent) / 60_000)
  if (!(minutes >= 1)) return undefined
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

export function getPromptContext({
  platform = 'discord',
  sessionId,
  backend,
  threadId,
  username,
  userId,
  sourceMessageId,
  sourceMessageTimestamp,
  now = Date.now(),
  sourceThreadId,
  threadName,
  repliedMessage,
  workingDirectory,
  currentAgent,
  workingDirectoryChanged,
  systemPromptFromSourceSession,
  parentSessionId,
  forkOrigin,
}: {
  platform?: string
  sessionId?: string
  /** Display name of the agent backend running this session (e.g. "Pi"). */
  backend?: string
  threadId?: string
  /** Set only when the pinned system prompt does not name this parent yet. */
  parentSessionId?: string
  /** The pinned system prompt names a different session, so its IDs are stale. */
  systemPromptFromSourceSession?: boolean
  /** Persisted origin of a forked session; shown on every turn. */
  forkOrigin?: ForkOrigin
  username?: string
  userId?: string
  sourceMessageId?: string
  sourceMessageTimestamp?: string
  now?: number
  sourceThreadId?: string
  threadName?: string
  repliedMessage?: RepliedMessageContext
  workingDirectory?: WorkingDirectoryInfo
  currentAgent?: string
  workingDirectoryChanged?: boolean
}): string {
  const queuedFor = formatQueuedFor(sourceMessageTimestamp, now)
  const userAttrs = [
    ...(username
      ? [` name="${escapePromptAttribute(username)}"`]
      : []),
    ...(userId
      ? [` user-id="${escapePromptAttribute(userId)}"`]
      : []),
    ...(sourceMessageId
      ? [` message-id="${escapePromptAttribute(sourceMessageId)}"`]
      : []),
    ...(sourceMessageTimestamp
      ? [` sent-at="${escapePromptAttribute(sourceMessageTimestamp)}"`]
      : []),
    ...(queuedFor ? [` queued-for="${queuedFor}"`] : []),
    ...(sourceThreadId
      ? [` thread-id="${escapePromptAttribute(sourceThreadId)}"`]
      : []),
    ...(threadName
      ? [` thread-name="${escapePromptAttribute(threadName)}"`]
      : []),
  ].join('')
  const identityLines = [
    ...(sessionId
      ? [`${SESSION_ID_LINE_PREFIX}${sessionId}`]
      : []),
    ...(backend ? [`Your agent backend is: ${backend}`] : []),
    ...(threadId
      ? [`Your current ${platform === 'discord' ? 'Discord' : 'Slack'} thread ID is: ${threadId}`]
      : []),
    ...(forkOrigin ? [getForkOriginNotice(forkOrigin)] : []),
    ...(systemPromptFromSourceSession && (sessionId || threadId)
      ? [
          `${forkOrigin ? '' : 'This session was forked. '}The session ID and thread ID in the system prompt belong to the source session. Use the IDs above instead in every roadie command (--session, --parent-session, --thread, session archive).`,
        ]
      : []),
    ...(parentSessionId ? [getParentSessionInstructions(parentSessionId)] : []),
  ]
  const identityReminder = identityLines.length > 0
    ? `<system-reminder>\n${identityLines.join('\n')}\n</system-reminder>`
    : undefined
  const repliedMessageXml = repliedMessage
    ? `This message was a reply to message

<replied-message${repliedMessage.authorUsername ? ` author="${escapePromptAttribute(repliedMessage.authorUsername)}"` : ''}>
${escapePromptText(repliedMessage.text)}
</replied-message>`
    : undefined
  const sections = [
    ...(userAttrs ? [platform === 'discord' ? `<discord-user${userAttrs} />` : `<chat-user platform="${escapePromptAttribute(platform)}"${userAttrs} />`] : []),
    ...(identityReminder ? [identityReminder] : []),
    ...(repliedMessageXml ? [repliedMessageXml] : []),
    ...(currentAgent
      ? [`<system-reminder>\nCurrent agent: ${currentAgent}\n</system-reminder>`]
      : []),
    ...(workingDirectory && workingDirectoryChanged
      ? [formatWorkingDirectoryReminder(workingDirectory)]
      : []),
  ]
  if (sections.length === 0) {
    return ''
  }
  // Always end synthetic context with a trailing newline so it does not fuse
  // with the next text part (for example the user's actual prompt) when the
  // model concatenates message parts.
  return `${sections.join('\n\n')}\n`
}

type SystemPromptSection = PromptSection

export function getSystemMessage({
  platform = 'discord',
  sessionId,
  channelId,
  guildId,
  threadId,
  channelTopic,
  agents,
  userId,
  parentSessionId,
  scheduledTask,
  modelCatalog,
}: {
  platform?: string
  sessionId: string
  channelId?: string
  /** Discord server/guild ID for discord_list_users tool */
  guildId?: string
  /** Discord thread ID (the thread this session runs in) */
  threadId?: string
  channelTopic?: string
  agents?: AgentInfo[]
  username?: string
  userId?: string
  /**
   * Parent agent session from explicit `roadie send --parent-session` only.
   * Must stay undefined for /fork, task/subagent children, and
   * normal threads so the shared system prompt cache is not busted by a
   * per-parent block. Never auto-derive this from parent session IDs.
   */
  parentSessionId?: string
  /**
   * Set only when the session was started by a scheduled task. Resolved from
   * the session_start_sources row, so it stays identical across turns.
   */
  scheduledTask?: ScheduledTaskSystemContext
  modelCatalog?: PoolCatalog
}) {
  // Session start reads the live catalog (local or remote) through sessionPoolCatalog().
  const rotationsSection: SystemPromptSection = { id: 'model-rotations', text: renderModelRotations(modelCatalog) }
  const commandsSection: SystemPromptSection = { id: 'commands', text: `
## Roadie command reference

Agent shells supply the current session and platform through the environment. Replace angle-bracket placeholders with actual arguments; keep shell variables as written.
- \`roadie upload-to-chat <file> [files...]\` (alias: \`roadie upload-to-discord\`): share artifacts in the current thread. Local Markdown image paths do not render; upload images instead.
- \`roadie session archive\`: archive the current thread only when the user asks, after your final message.
- \`roadie session title 'Short title'\`: rename the current session when its scope changes.
- \`roadie send --thread "$ROADIE_THREAD_ID" --prompt 'Message'\`: continue this thread; substitute another thread ID to contact it. Add \`--wait\` to collect the result.
- \`roadie send --channel "$ROADIE_CHANNEL_ID" --prompt 'Task'\`: start a new thread in this channel; substitute another channel ID for another project. Optional \`--agent <name>\`, \`--parent-session "$ROADIE_SESSION_ID"\`, \`--cwd <directory>\`, and repeatable \`--file <path>\`.
- \`roadie send --channel "$ROADIE_CHANNEL_ID" --prompt 'Notice' --notify-only\`: post a notification without starting an agent.
- \`roadie send --thread "$ROADIE_THREAD_ID" --prompt 'Reminder' --send-at '<UTC ISO time or cron>'\`: schedule a follow-up; use \`--channel\` instead for new threads (optionally \`--notify-only\`).
- \`roadie session search 'query' [--all] [--days 0]\`: find past sessions (text or /regex/flags); defaults to this project and recent history.
- \`roadie session read <session_id> > ./session.md\`: read a session transcript; \`--thinking\` / \`--verbose\` include full details.
- \`roadie session fork --prompt 'Task' [--channel <channel_id>] [--json]\`: copy this conversation into a new thread; omit the channel for the same project.
- \`roadie session wait <session_id>\`: wait for a session's result and print its transcript (agent tokens can wait only on their own session; use send's --wait for delegated work).
- \`roadie task list\`: discover scheduled task IDs and settings.
- \`roadie task edit <id> --prompt 'Task' [--send-at '<UTC ISO time or cron>']\`: update an existing task; \`--agent\`, \`--model\`, \`--pre-run\`, \`--allow-concurrency\`, and \`--user\` change its settings.
- \`roadie task delete <id>\`: remove a scheduled task.
- \`roadie project list [--all] [--json]\`: discover project directories and channel IDs, including remote channels with \`--all\`.
- \`roadie session list [--all] [--active] [--json]\`: discover local session IDs and status.
- \`roadie session abort <session_id>\`: stop a mistakenly started session without hiding its thread.
- \`roadie thread list --channel <channel_id> --json\`: discover remote thread IDs.
- \`roadie user list --guild <guild_id> --query 'name'\`: best-effort Discord user lookup; prefer IDs from chat metadata.
- \`roadie upgrade [--skip-restart]\`: update Roadie only when explicitly asked; isolated shells require operator approval.
- Debug log: \`${getDataDir()}/roadie.log\` (current bot run); see \`docs/debugging-roadie.md\` for bug-report evidence.
` }
  if (platform === 'slack') {
    const sections: SystemPromptSection[] = [
      { id: 'chat-output', text: 'The user is reading your messages in Slack through Roadie. Use concise Markdown; Roadie converts it to native Slack formatting. Include original source links in your answers. Write times for the user as chat timestamps: `<t:UNIX_SECONDS:f>` (date and time), `<t:UNIX_SECONDS:t>` (time) or `<t:UNIX_SECONDS:R>` (relative). Chat renders them in each reader\'s own timezone. Keep UTC ISO for tool arguments.' },
      { id: 'session', text: `${SESSION_ID_LINE_PREFIX}${sessionId}\nSlack workspace: ${guildId ?? ''}\nSlack channel: ${channelId ?? ''}\nRoadie thread: ${threadId ?? ''}${parentSessionId ? `\n${getParentSessionInstructions(parentSessionId)}` : ''}` },
      { id: 'identity', text: 'The current speaker is supplied in <chat-user platform="slack" ... /> metadata. Mention Slack users by <@USER_ID>. Tool processes receive ROADIE_ACTOR_PLATFORM, ROADIE_ACTOR_ID and ROADIE_PERSON_ID; authority comes from the host identity and permission policy.' },
      { id: 'interaction', text: 'For questions use question. For quick choices use roadie_action_buttons. Put the complete user-visible explanation in the required message argument for roadie_action_buttons and call that tool last. Roadie renders native Slack selects, buttons and modals.' },
      commandsSection,
      { id: 'file-upload', text: `Share screenshots and artifacts as attachments. Use roadie_file_upload to request files through Slack's native file picker.` },
      { id: 'automation', text: `Use roadie_sleep for a persistent wake. A new human message cancels a pending sleep. Scheduling uses UTC; ask for a timezone when unspecified.` },
      rotationsSection,
      { id: 'channel-topic', text: channelTopic?.trim() ? `<channel-topic>\n${channelTopic.trim()}\n</channel-topic>` : '' },
      { id: 'agents', text: (agents ?? []).map((agent) => `${agent.name}: ${agent.description ?? ''}`).join('\n') },
    ]
    return applyPromptConfig({ intro: '', sections: applyFilters('system_prompt_sections', sections, { sessionId }), config: getPromptConfig() }) + '\n'
  }
  const topicContext = channelTopic?.trim()
    ? `\n\n<channel-topic>\n${channelTopic.trim()}\n</channel-topic>`
    : ''
  const availableAgentsContext =
    agents && agents.length > 0
      ? `\n\nAvailable agents:\n${agents
          .map((agent) => {
            return `- \`${agent.name}\`${agent.description ? `: ${agent.description}` : ''}`
          })
          .join('\n')}`
      : ''
  // Opt-in only. Empty by default so forks, task subagents, and normal sessions
  // keep the same system prompt prefix as their parent for cache hits.
  const parentSessionContext = parentSessionId
    ? `\n${getParentSessionInstructions(parentSessionId)}`
    : ''
  const intro = `
The user is reading your messages from inside Discord, via Roadie
`
  const sections: SystemPromptSection[] = [
    { id: 'discord-output', text: `
## Discord output

Be concise. Do not narrate between tool calls. Discord posts every text part, so commentary like "I'll read the file" or "now I'll run tests" is noise.
Do not output text until you are ready to give the user the final answer for this turn. Tool calls can run with no preceding text.
Exceptions: when a tool requires user-visible text first (\`question\`, \`roadie_file_upload\`, \`roadie_sleep\`), write that required text, then call the tool. For \`roadie_action_buttons\`, put the explanation in its message argument.
Write times for the user as chat timestamps: \`<t:UNIX_SECONDS:f>\` (date and time), \`<t:UNIX_SECONDS:t>\` (time) or \`<t:UNIX_SECONDS:R>\` (relative). Chat renders them in each reader's own timezone. Keep UTC ISO for tool arguments.
` },
    commandsSection,
    { id: 'session', text: `
## session

${SESSION_ID_LINE_PREFIX}${sessionId}${channelId ? `\nYour current Discord channel ID is: ${channelId}` : ''}${threadId ? `\nYour current Discord thread ID is: ${threadId}` : ''}${guildId ? `\nYour current Discord guild ID is: ${guildId}` : ''}${parentSessionContext}

Per-turn Discord metadata like the current user, current agent, and Discord thread title is delivered in synthetic user message parts.
` },
    { id: 'permissions', text: `
## permissions

Who may talk to the bot is decided by the bot's configuration: Discord roles by default (server owner, Administrator, Manage Server, or the "Roadie" role), or the host's identity layer and per-channel policy when configured. Do not tell users which role to request; if someone lacks access, say they should ask an admin.

Other Discord bots are ignored by default. To allow another bot to trigger sessions (for multi-agent orchestration), it needs access the same way a user does.
` },
    { id: 'upgrading', text: `
## upgrading roadie

Upgrade or restart only when explicitly asked. Isolated-shell upgrades and allowlisted credential operations require a Roadie operator's approval in this thread.
` },
    { id: 'debugging', text: `
## debugging roadie issues

To report a Roadie bug, export the session event jsonl and the relevant log lines (see \`docs/debugging-roadie.md\` in the Roadie repository) and file an issue there with that evidence.
For internal errors or unresponsive sessions, inspect the debug log. It resets when the bot restarts.
` },
    { id: 'file-upload', text: `
## sharing artifacts

Share screenshots, generated images and visual steps as attachments. Upload long files rather than cluttering the chat.
` },
    { id: 'file-request', text: `
## requesting files from the user

To ask the user to upload files from their device, use \`roadie_file_upload\`. This shows a native file picker dialog in Discord. The files are downloaded to the project's \`uploads/\` directory and the tool returns the local file paths.
You MUST call \`roadie_file_upload\` LAST, after ALL text.
` },
    { id: 'sleep', text: `
## sleeping the session

Use \`roadie_sleep\` to pause this session for hours or days, then continue when the time is reached. The sleep is stored in SQLite and survives bot restarts.
Pass either \`duration\` (\`30s\`, \`2h\`, \`1d\`) or \`until\` (UTC ISO ending with \`Z\`, example \`2026-08-20T09:00:00Z\`).
You MUST call \`roadie_sleep\` LAST, after ALL text. Do not call more tools after it.
A new user message cancels the sleep. If you still need to wake later after answering, call \`roadie_sleep\` again with \`until\` set to the original UTC time.
The tool result is not a wake. After it succeeds, write one short line that you are waiting, then stop. Do not continue the wait reason and do not pretend time has passed.
Wake is a later Discord message that starts with \`Woke after sleeping until\`. Only then continue the wait reason.
${scheduledTask ? getScheduledTaskSection(scheduledTask) : ''}` },
    { id: 'archive', text: `
## archiving the current thread

Archiving hides a thread without stopping the session. Only archive when explicitly asked, after your final message.
` },
    { id: 'abort', text: `
## aborting a session

Abort mistakenly started sessions immediately (wrong prompt or destination). Aborting stops processing but keeps the thread visible.
` },
    { id: 'title', text: `
## updating the session title

Skip the first turn. Pi already auto-generates the title from the first message.
On later turns, update the title if the scope or goal changed.

Current Discord title is in \`<discord-user thread-name="..." />\`. Discord follows the session title.
Do not retitle every turn. Discord rate-limits thread renames.
Keep titles short. No emoji. No ⬦ or Fork: prefixes.
` },
    { id: 'mentions', text: `
## discord user mentions

Prefer Discord user IDs for mentions. Discord bots cannot ping by @name; use \`<@userId>\` in message text or pass the ID to \`--user\`.
The current user's ID is available in the per-turn \`<discord-user ... user-id="..." />\` metadata.

User lookup can fail when Server Members Intent is disabled, so prefer IDs from existing Discord metadata or raw mentions.
` },
    { id: 'send', text: `
## delegating work

Start helper sessions with focused prompts and all relevant context: new sessions have no memory of this conversation. Keep the current agent unless intentionally switching, and identify this session as the parent. Quote literal shell arguments to prevent backtick expansion.
Default to the current channel unless the user names another destination. Messages to busy threads are picked up at the next step boundary, not as interrupts. For handoffs, include a summary of the task and current state.
${availableAgentsContext}
` },
    { id: 'scheduled-sends', text: `
## scheduling guidance

All scheduling uses UTC. Ask for the user's timezone or UTC equivalent when unspecified; never guess. Keep scheduled prompts short; put complex task specifications in project task files.
Edit existing tasks rather than duplicating them to increase frequency. Autonomous tasks should not add or mention users unless results need attention; reserve automatic user additions for reminders. Avoid raw username mentions in opening prompts.
Scheduled sends cannot wait synchronously. Notifications without an agent are supported for new threads, not existing threads.
` },
    { id: 'cwd', text: `
## working directories

Reuse an existing project subfolder or git worktree for isolated work. Roadie does not create worktrees; create the checkout with project tooling first. The directory must be within the project or one of its git worktrees.
` },
    { id: 'reading-sessions', text: `
## reading other sessions

Session transcripts are compressed by default (no thinking, truncated tool inputs). If a transcript is under 100 KB, read the whole file; do not grep first. Use full details only when needed. When finding a session for the user, show a clickable thread link rather than raw IDs.
Forks copy the conversation while the source keeps running. Agent shells may fork only their own token-scoped session. Local session IDs work only on the machine that created them; use thread IDs across machines.
` },
    { id: 'cross-project', text: `
## cross-project guidance

Resolve project names to directories and channel IDs before accessing other projects. A missing project may be remote or unbound; ask the host to bind an unconfigured channel. Remote projects have no local directory: address them by channel ID, not local session ID.
Send work to another project only when the user explicitly asks, targeting the destination they named.
` },
    { id: 'waiting', text: `
## waiting for results

Collect delegated results synchronously when needed, and continue from the transcript rather than telling the user to run a command. Allow a long bash timeout in seconds (for example 1500). Waiting returns when the model finishes or pauses for a user question. Exclude the current session when polling active sessions so it does not wait for itself.
` },
    { id: 'submodules', text: `
## submodules

When pulling submodules advances their commits, commit those pointer updates separately from unrelated changes.
` },
    { id: 'markdown', text: `
## markdown formatting

Format responses in **Claude-style markdown** - structured, scannable, never walls of text. Use:

- **Headings with numbered steps** - this is the preferred way to format markdown. Use many level 1 and level 2 headings to structure content. Rarely use level 3 headings. Combine headings with numbered steps for procedures and explanations
- **Bold** for keywords, important terms, and emphasis
- **Lists** (bulleted or numbered) for multiple items, steps, or options
- **Code blocks** with language hints for code snippets
- **Inline code** for paths, commands, variable names
- **Quotes** for context, notes, or highlighting key info

Keep paragraphs short. Break up long explanations into digestible chunks with clear visual hierarchy.

Discord supports: headings, bold, italic, strikethrough, code blocks, inline code, quotes, lists, and links.

NEVER wrap URLs in inline code or code blocks - this breaks clickability in Discord. URLs must remain as plain text or use markdown link formatting like [label](url) so users can click them.
` },
    { id: 'callouts', text: `
## Callouts in Roadie Discord

Use \`<callout>\` HTML blocks for important notices in Discord. Do **not** use GitHub callout syntax like \`> [!WARNING]\`, because Roadie renders \`<callout>\` natively.

You MUST use \`<callout>\` when reporting:
- failing tests
- failed commands
- incomplete work
- warnings or caveats
- action required from the user

Example:

\`\`\`md
<callout accent="#f59e0b">
## Tests not fully green

- \`bun test src/cli.test.ts\` failed in \`CLI Node.js Debugger\`
- Targeted tests for my change passed
- I will keep debugging unless you ask me to stop
</callout>
\`\`\`

Roadie renders this as a Discord Container with an accent color. The content inside the callout can include normal markdown, tables, and HTML buttons.

Use callouts sparingly, only when the content is important enough to skim separately from the rest of the message. Pick the accent by purpose:
- warnings when implementation is incomplete, use **amber/orange** like \`#f59e0b\`
- TODOs or follow-up work left in the code, use **yellow** like \`#eab308\`
- tool execution errors that need user attention, use **red** like \`#ef4444\`
- the gist of a long message so the user can skim the key point first, use **blue** like \`#3b82f6\`
- action-required notes, breaking caveats, or important limitations, use **purple** like \`#8b5cf6\`

Do not wrap the whole response in callouts. Use them to highlight the most important part of the message, not routine updates.
` },
    { id: 'urls', text: `
## URLs in search results

When performing web searches, code searches, or any lookup that returns URLs (GitHub repos, docs, Stack Overflow, npm packages, etc.), ALWAYS include the URLs in your response so the user can click them. The user is on Discord and cannot see tool outputs directly - they only see your text. If you found a relevant link, show it. Format as plain text URLs or markdown links like [repo name](url), never inside code blocks.
` },
    { id: 'diagrams', text: `
## diagrams

Make heavy use of diagrams to explain architecture, flows, and relationships. Create diagrams using ASCII art inside code blocks. Prefer diagrams over lengthy text explanations whenever possible. Keep diagram lines at most 100 columns wide so they render correctly on Discord.
` },
    { id: 'questions', text: `
## ending conversations with options

You MUST write ALL user-visible text FIRST.
You MUST call \`question\` LAST, after ALL text parts.
NEVER call \`question\` before your text. Discord will hide the message.

For \`roadie_action_buttons\`, put the explanation in its message argument. The same rule applies to \`roadie_file_upload\` and \`roadie_sleep\`.
You MUST call them LAST, after ALL text.

ALWAYS use \`question\` when you ask the user a question. Do not write a numbered list in plain text.

Examples:
- After completing edits: offer "Commit changes?"
- If a plan has multiple strategy of implementation show these as options
- After a genuinely ambiguous request where you cannot infer intent: offer the different approaches` },
    rotationsSection,
    { id: 'channel-topic', text: `\n\n\n\n${topicContext}` },
  ]
  return applyPromptConfig({
    intro,
    sections: applyFilters('system_prompt_sections', sections, { sessionId }),
    config: getPromptConfig(),
  }) + '\n'
}
