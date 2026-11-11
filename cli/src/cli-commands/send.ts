// Terminal send command for creating Discord threads and scheduling prompts.
// Designed to work in CI/headless environments with just ROADIE_BOT_TOKEN.
// The local SQLite database (channel_directories) is NOT required for the basic
// flow: post message → create thread → remote bot picks it up. The local project
// directory mapping is only needed for --send-at, --wait, and --cwd.
import { goke } from 'goke'
import { z } from 'zod'
import { note } from '@clack/prompts'
import * as errore from 'errore'
import { Events, ActivityType, type PresenceStatusData, type Guild, Routes } from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createLogger, LogPrefix, initLogFile } from '../logger.js'
import { initDatabase, getChannelDirectory } from '../discord-bot.js'
import { applicationDirectory, resolveSendChannel, validateApplicationDirectory } from '../channel-policy.js'
import { getBotToken, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, getDb, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory } from '../database.js'
import { ShareMarkdown } from '../markdown.js'
import { parseSessionSearchPattern, findFirstSessionSearchHit, buildSessionSearchSnippet, getPartSearchTexts } from '../session-search.js'
import { QUEUE_PREFIX, sendPromptSender } from '../message-formatting.js'
import { buildStartMarker, type SessionRun } from '../system-message.js'
import { createDiscordRest } from '../discord-urls.js'
import { archiveThread, buildThreadStartEmbeds, ensureThreadMember, uploadFilesToDiscord, stripMentions } from '../discord-utils.js'
import { setDataDir, getDataDir, getLockPort } from '../config.js'
import { getSendToken, remoteSendOptions, sendViaRunningBot, shouldSendRemotely } from '../remote-send.js'
import { AGENT_TOKEN_ENV } from '../agent-token.js'
import { AGENT_SEND_PATH, resolveAgentCredentials } from '../agent-remote.js'
import { execAsync, resolveSessionWorkingDirectory } from '../git-utils.js'
import { upgrade, getCurrentVersion } from '../upgrade.js'
import { getPromptPreview, parseSendAtValue, parseScheduledTaskPayload, serializeScheduledTaskPayload, type ScheduledTaskPayload } from '../task-schedule.js'
import {
  EXIT_NO_RESTART,
  formatMemberLookupUnavailableMessage,
  formatRelativeTime,
  formatTaskScheduleLine,
  isDiscordMemberLookupUnavailable,
  isGuildMemberSearchResult,
  isThreadChannelType,
  printDiscordInstallUrlAndExit,
  resolveBotCredentials,
  resolveDiscordUserOption,
  sendDiscordMessageWithOptionalAttachment,
} from '../cli-runner.js'
import { validateCliModelOption } from '../session-handler/model-utils.js'

/**
 * Where a send goes when this process cannot open the bot's database itself:
 * the running bot, reached with an agent token (scoped endpoint) or the
 * service send token. Undefined means send directly.
 */
function resolveRunningBotSend(options: { platform?: string }): { port: number; token: string; path?: string } | Error | undefined {
  if ((options.platform ?? process.env.ROADIE_PLATFORM) === 'slack') {
    const token = getSendToken()
    if (!token) return new Error('Set ROADIE_SERVICE_TOKEN (or its _FILE variant) to send through the running Slack bot')
    return { port: getLockPort(), token }
  }
  const agent = resolveAgentCredentials()
  if (!(agent instanceof Error)) return { ...agent, path: AGENT_SEND_PATH }
  if (shouldSendRemotely({ dataDir: getDataDir() })) return { port: getLockPort(), token: getSendToken()! }
  return undefined
}

/** How the sent session runs, from the send options and the resolved target user. */
function sessionRun(
  options: { agent?: string; model?: string; permission?: string[]; injectionGuard?: string[]; parentSession?: string },
  user: { id: string; username?: string } | undefined,
): SessionRun {
  return {
    agent: options.agent || null,
    model: options.model || null,
    username: user?.username || null,
    userId: user?.id || null,
    permissions: options.permission?.length ? options.permission : null,
    injectionGuardPatterns: options.injectionGuard?.length ? options.injectionGuard : null,
    parentSessionId: options.parentSession || null,
  }
}

const cliLogger = createLogger(LogPrefix.CLI)

/** Everything both send modes need once the options are validated. */
type SendContext = {
  options: Parameters<typeof sessionRun>[0] & {
    allowConcurrency?: boolean
    cwd?: string
    model?: string
    preRun?: string
    sourceSession?: string
    user?: string
    wait?: boolean
  }
  prompt: string
  notifyOnly?: boolean
  threadId?: string
  sessionId?: string
  channelId?: string
  name?: string
  filePaths?: string[]
  parsedSchedule: Exclude<ReturnType<typeof parseSendAtValue>, Error> | null
  waitStartedAtMs?: number
  rest: ReturnType<typeof createDiscordRest>
  botToken: string
}

/** `--thread`/`--session`: schedule, plain-post to the caller's own thread, or prompt an existing thread. */
async function sendToThread(ctx: SendContext): Promise<void> {
  const { options, prompt, notifyOnly, threadId, sessionId, channelId, name, filePaths, parsedSchedule, waitStartedAtMs, rest, botToken } = ctx
  const targetThreadId = await (async (): Promise<string> => {
    if (threadId) {
      return threadId
    }
    if (!sessionId) {
      throw new Error('Thread ID not resolved')
    }
    const resolvedThreadId = await getThreadIdBySessionId(sessionId)
    if (!resolvedThreadId) {
      throw new Error(
        `No Discord thread found for session: ${sessionId}`,
      )
    }
    return resolvedThreadId
  })()

  const threadData = (await rest.get(
    Routes.channel(targetThreadId),
  )) as {
    id: string
    name: string
    type: number
    parent_id?: string
    guild_id: string
  }

  if (!isThreadChannelType(threadData.type)) {
    throw new Error(`Channel is not a thread: ${targetThreadId}`)
  }

  if (!threadData.parent_id) {
    throw new Error(`Thread has no parent channel: ${targetThreadId}`)
  }
  const destination = resolveSendChannel(threadData.parent_id)
  if (destination instanceof Error) throw destination

  // Adding the user as a thread member is what makes the thread appear
  // in their Discord left sidebar. Without it a scheduled reminder posts
  // into a thread the user may have already left or never joined, so
  // they never see it.
  const threadTargetUser = await resolveDiscordUserOption({
    user: options.user,
    guildId: threadData.guild_id,
    rest,
  })
  if (threadTargetUser instanceof Error) {
    cliLogger.error(threadTargetUser.message)
    process.exit(EXIT_NO_RESTART)
  }

  // channelConfig is optional: in CI/headless environments the local DB
  // has no channel_directories rows because the bot hasn't synced yet.
  // The running bot on the other end resolves the directory from its own DB.
  // We only require it for features that genuinely need a local directory
  // (scheduled tasks).
  const storedConfig = await getChannelDirectory(threadData.parent_id)
  const fixedDirectory = applicationDirectory()
  const channelConfig = fixedDirectory ? { directory: fixedDirectory } : storedConfig
  const threadModelCheck = await validateCliModelOption({
    model: options.model,
    directory: channelConfig?.directory,
  })
  if (threadModelCheck instanceof Error) {
    cliLogger.error(threadModelCheck.message)
    process.exit(EXIT_NO_RESTART)
  }

  // Guard early: fail before sending the message if a feature that
  // needs local project directory mapping is requested.
  if (!channelConfig && parsedSchedule) {
    throw new Error(
      'Thread parent channel is not configured with a project directory. ' +
      '--send-at requires a local project mapping. Run the bot first to sync channel data.',
    )
  }

  if (parsedSchedule) {
    const payload: ScheduledTaskPayload = {
      kind: 'thread',
      threadId: targetThreadId,
      prompt,
      ...sessionRun(options, threadTargetUser),
      preRunCommand: options.preRun || null,
      allowConcurrency: Boolean(options.allowConcurrency),
    }
    const taskId = await createScheduledTask({
      scheduleKind: parsedSchedule.scheduleKind,
      runAt: parsedSchedule.runAt,
      cronExpr: parsedSchedule.cronExpr,
      timezone: parsedSchedule.timezone,
      nextRunAt: parsedSchedule.nextRunAt,
      payloadJson: serializeScheduledTaskPayload(payload),
      promptPreview: getPromptPreview(prompt),
      channelId: threadData.parent_id,
      threadId: targetThreadId,
      sessionId: sessionId || undefined,
      // channelConfig is guaranteed: early guard threw if missing with --send-at
      projectDirectory: channelConfig!.directory,
    })

    const threadUrl = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
    note(
      `Task ID: ${taskId}\nTarget thread: ${threadData.name}\nSchedule: ${formatTaskScheduleLine(parsedSchedule)}\n\nURL: ${threadUrl}`,
      '✅ Task Scheduled',
    )
    cliLogger.log(threadUrl)
    process.exit(0)
  }

  // An agent's own replies already reach its thread, so a send to that
  // same thread is a plain post: prompting it would hand the session
  // its own words back as a new turn.
  const sourceSessionId: string | undefined = options.sourceSession || undefined
  const sourceThreadId = sourceSessionId
    ? (await getThreadIdBySessionId(sourceSessionId)) ?? undefined
    : undefined
  const threadUrl = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
  if (sourceThreadId === targetThreadId) {
    if (options.wait) {
      cliLogger.error('Cannot use --wait when sending to your own thread')
      process.exit(EXIT_NO_RESTART)
    }
    await sendDiscordMessageWithOptionalAttachment({
      channelId: targetThreadId,
      prompt,
      botToken,
      rest,
      files: filePaths,
    })
    note(
      `Posted to this session's own thread: ${threadData.name}\nIt does not start a turn; your replies already appear in this thread.\n\nURL: ${threadUrl}`,
      '✅ Message Sent',
    )
    process.stdout.write(`${threadUrl}\n`)
    process.exit(0)
  }

  const threadPromptMarker = buildStartMarker(sessionRun(options, threadTargetUser), { agentToken: process.env[AGENT_TOKEN_ENV] || undefined })
  const promptEmbed = await buildThreadStartEmbeds(threadPromptMarker)

  // Prefix the prompt so it's clear who sent it (matches /queue format).
  // Use a newline between prefix and prompt so leading /command
  // detection can find the command on its own line.
  const prefixedPrompt = `${QUEUE_PREFIX}${sendPromptSender({ sourceThreadId, sourceSessionId })}\n${prompt}`

  if (threadTargetUser) {
    cliLogger.log(
      `Adding user ${threadTargetUser.username || threadTargetUser.id} to thread...`,
    )
    const addMemberResult = await ensureThreadMember({
      rest,
      threadId: targetThreadId,
      userId: threadTargetUser.id,
    })
    if (addMemberResult instanceof Error) {
      cliLogger.error(addMemberResult.message)
      process.exit(EXIT_NO_RESTART)
    }
  }

  await sendDiscordMessageWithOptionalAttachment({
    channelId: targetThreadId,
    prompt: prefixedPrompt,
    botToken,
    embeds: promptEmbed,
    rest,
    files: filePaths,
  })

  const existingSessionId = sessionId || await getThreadSession(targetThreadId)
  const sessionLine = existingSessionId ? `Session: ${existingSessionId}\n` : ''
  note(
    `Prompt sent to thread: ${threadData.name}\n${sessionLine}\nURL: ${threadUrl}`,
    '✅ Message Sent',
  )
  if (existingSessionId) process.stdout.write(`Session: ${existingSessionId}\n`)
  process.stdout.write(`${threadUrl}\n`)

  if (options.wait) {
    const { waitAndOutputSession } = await import('../wait-session.js')
    await waitAndOutputSession({
      threadId: targetThreadId,
      waitStartedAtMs,
    })
  }
}

/** `--channel` (or the configured channel): post a starter message and open a thread the bot picks up. */
async function sendToChannel(ctx: SendContext): Promise<void> {
  const { options, prompt, notifyOnly, threadId, sessionId, channelId, name, filePaths, parsedSchedule, waitStartedAtMs, rest, botToken } = ctx
  cliLogger.log('Fetching channel info...')

  if (!channelId) {
    throw new Error('Channel ID not resolved')
  }

  // Get channel info to extract directory from topic
  const channelData = (await rest.get(Routes.channel(channelId))) as {
    id: string
    name: string
    topic?: string
    guild_id: string
  }

  // channelConfig is optional: in CI/headless environments the local DB
  // has no channel_directories rows because the bot hasn't synced yet.
  // The running bot on the other end resolves the directory from its own DB.
  // We only require it for features that genuinely need a local directory
  // (--send-at, --cwd).
  const storedConfig = await getChannelDirectory(channelData.id)
  const fixedDirectory = applicationDirectory()
  const channelConfig = fixedDirectory ? { directory: fixedDirectory } : storedConfig
  const projectDirectory = channelConfig?.directory
  const channelModelCheck = await validateCliModelOption({
    model: options.model,
    directory: projectDirectory,
  })
  if (channelModelCheck instanceof Error) {
    cliLogger.error(channelModelCheck.message)
    process.exit(EXIT_NO_RESTART)
  }

  // Features that require a local project directory mapping
  if (!channelConfig && (parsedSchedule || options.cwd)) {
    throw new Error(
      `Channel #${channelData.name} is not configured with a project directory. ` +
      `${parsedSchedule ? '--send-at' : '--cwd'} requires a local project mapping. ` +
      'Run the bot first to sync channel data.',
    )
  }

  // Validate --cwd is inside the project or an existing git worktree.
  let resolvedCwd: string | undefined
  if (options.cwd) {
    // projectDirectory is guaranteed here: needsProjectDirectory check above
    // already threw if channelConfig is missing when --cwd is used.
    const cwdResult = await resolveSessionWorkingDirectory({
      projectDirectory: projectDirectory!,
      candidatePath: options.cwd,
    })
    if (cwdResult instanceof Error) {
      cliLogger.error(cwdResult.message)
      process.exit(EXIT_NO_RESTART)
    }
    resolvedCwd = cwdResult.directory
  }

  const resolvedUser = await resolveDiscordUserOption({
    user: options.user,
    guildId: channelData.guild_id,
    rest,
  })
  if (resolvedUser instanceof Error) {
    cliLogger.error(resolvedUser.message)
    process.exit(EXIT_NO_RESTART)
  }

  cliLogger.log('Creating starter message...')

  const cleanPrompt = stripMentions(prompt)
  const baseThreadName =
    name ||
    (cleanPrompt.length > 80
      ? cleanPrompt.slice(0, 77) + '...'
      : cleanPrompt)
  const threadName = baseThreadName

  if (parsedSchedule) {
    const payload: ScheduledTaskPayload = {
      kind: 'channel',
      channelId,
      prompt,
      name: name || null,
      notifyOnly: Boolean(notifyOnly),
      cwd: resolvedCwd || null,
      ...sessionRun(options, resolvedUser),
      preRunCommand: options.preRun || null,
      allowConcurrency: Boolean(options.allowConcurrency),
    }
    const taskId = await createScheduledTask({
      scheduleKind: parsedSchedule.scheduleKind,
      runAt: parsedSchedule.runAt,
      cronExpr: parsedSchedule.cronExpr,
      timezone: parsedSchedule.timezone,
      nextRunAt: parsedSchedule.nextRunAt,
      payloadJson: serializeScheduledTaskPayload(payload),
      promptPreview: getPromptPreview(prompt),
      channelId,
      projectDirectory,
    })

    const channelUrl = `https://discord.com/channels/${channelData.guild_id}/${channelId}`
    note(
      `Task ID: ${taskId}\nTarget channel: #${channelData.name}\nSchedule: ${formatTaskScheduleLine(parsedSchedule)}\n\nURL: ${channelUrl}`,
      '✅ Task Scheduled',
    )
    cliLogger.log(channelUrl)
    process.exit(0)
  }

  // Embed marker for auto-start sessions (unless --notify-only)
  // Bot parses this YAML to know it should start a session and set the initial user
  const embedMarker = notifyOnly ? undefined : buildStartMarker(sessionRun(options, resolvedUser), { cwd: resolvedCwd, agentToken: process.env[AGENT_TOKEN_ENV] || undefined })
  const autoStartEmbed = embedMarker
    ? await buildThreadStartEmbeds(embedMarker)
    : undefined

  const starterMessage = await sendDiscordMessageWithOptionalAttachment({
    channelId,
    prompt,
    botToken,
    embeds: autoStartEmbed,
    rest,
    splitInsteadOfAttach: notifyOnly,
    files: filePaths,
  })

  // For notify-only on non-project channels, just post the message without
  // creating a thread. There's no session to start, so a thread is unnecessary.
  if (notifyOnly && !channelConfig) {
    const messageUrl = `https://discord.com/channels/${channelData.guild_id}/${channelId}/${starterMessage.id}`
    note(
      `Channel: #${channelData.name}\n\nMessage sent.\n\nURL: ${messageUrl}`,
      '✅ Message Sent',
    )
    process.stdout.write(`${messageUrl}\n`)
    process.exit(0)
  }

  cliLogger.log('Creating thread...')

  const threadData = (await rest.post(
    Routes.threads(channelId, starterMessage.id),
    {
      body: {
        name: threadName.slice(0, 100),
        auto_archive_duration: 1440, // 1 day
      },
    },
  )) as { id: string; name: string }

  cliLogger.log('Thread created!')

  // Add user to thread if specified
  if (resolvedUser) {
    cliLogger.log(
      `Adding user ${resolvedUser.username || resolvedUser.id} to thread...`,
    )
    await rest.put(Routes.threadMembers(threadData.id, resolvedUser.id))
  }

  const threadUrl = `https://discord.com/channels/${channelData.guild_id}/${threadData.id}`

  // Poll for session ID if the bot is expected to auto-start (not --notify-only).
  // The bot picks up the thread and creates a session asynchronously;
  // we wait briefly so the caller can reference the session immediately.
  let newSessionId: string | undefined
  if (!notifyOnly) {
    const { waitForSessionId } = await import('../wait-session.js')
    newSessionId = await waitForSessionId({
      threadId: threadData.id,
      timeoutMs: 15_000,
    }).catch((e) => {
      cliLogger.warn(`Could not resolve session ID: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    })
  }

  const cwdLine = resolvedCwd
    ? `\nWorking directory: ${resolvedCwd}`
    : ''
  const sessionLine = newSessionId ? `\nSession: ${newSessionId}` : ''
  const directoryLine = projectDirectory ? `\nDirectory: ${projectDirectory}` : ''
  const successMessage = notifyOnly
    ? `Thread: ${threadData.name}${directoryLine}\n\nNotification created. Reply to start a session.\n\nURL: ${threadUrl}`
    : `Thread: ${threadData.name}${directoryLine}${cwdLine}${sessionLine}\n\nThe running bot will pick this up and start the session.\n\nURL: ${threadUrl}`

  note(successMessage, '✅ Thread Created')

  if (newSessionId) process.stdout.write(`Session: ${newSessionId}\n`)
  process.stdout.write(`${threadUrl}\n`)

  if (options.wait) {
    const { waitAndOutputSession } = await import('../wait-session.js')
    await waitAndOutputSession({
      threadId: threadData.id,
      waitStartedAtMs,
    })
  }
}
const cli = goke()

cli
  .command(
    'send',
    'Send a message to a Discord channel/thread. Default creates a thread; use --thread/--session to continue existing.',
  )
  .alias('start-session') // backwards compatibility
  .option('--platform <name>', 'Chat platform: discord or slack. Defaults to ROADIE_PLATFORM')
  .option('-c, --channel <channelId>', 'Discord channel ID')
  .option(
    '-p, --prompt <prompt>',
    'Message content. Verified same-person sends steer busy sessions at the next step boundary; other sends wait for the turn to settle',
  )
  .option(
    '-n, --name [name]',
    'Thread name (optional, defaults to prompt preview)',
  )
  .option(
    '-a, --app-id [appId]',
    'Bot application ID (required if no local database)',
  )
  .option(
    '--notify-only',
    'Create notification thread without starting AI session',
  )
  .option(
    '--cwd <path>',
    'Start session in an existing project subfolder or git worktree directory',
  )
  .option('-u, --user <user>', 'Discord user ID, mention, or username to add to thread')
  .option('--agent <agent>', 'Agent to use for the session')
  .option('--model <model>', 'Model to use (format: provider/model)')
  .option(
    '--permission <rule>',
    z.array(z.string()).describe(
      'Session permission rule (repeatable). Format: "tool:action" or "tool:pattern:action". ' +
      'Actions: allow, deny, ask. Examples: --permission "bash:deny" --permission "edit:deny"',
    ),
  )
  .option(
    '--injection-guard <pattern>',
    z.array(z.string()).describe(
      'Injection guard scan pattern (repeatable). Enables prompt injection detection for this session. ' +
      'Format: "tool:argsGlob". Examples: --injection-guard "bash:*" --injection-guard "webfetch:*"',
    ),
  )
  .option(
    '-f, --file <path>',
    z.array(z.string()).describe(
      'Local file to attach (repeatable). Images, text files, PDFs, etc. ' +
      'Examples: --file screenshot.png --file report.pdf',
    ),
  )
  .option(
    '--send-at <schedule>',
    'Schedule send for future (UTC ISO date/time ending in Z, or cron expression)',
  )
  .option(
    '--pre-run <command>',
    'Run a shell command in the project before starting a scheduled task',
  )
  .option(
    '--allow-concurrency',
    'Allow concurrent sessions from the same scheduled task',
  )
  .option(
    '--thread <threadId>',
    'Post to an existing thread (own thread: plain post). Busy sessions steer verified same-person sends; other sends wait for the turn to settle',
  )
  .option(
    '--session <sessionId>',
    'Post prompt to thread mapped to an existing session',
  )
  .option(
    '--parent-session <sessionId>',
    'Parent session ID for newly created child sessions',
  )
  .option(
    '--wait',
    'Wait for session to complete, then print session text to stdout',
  )
  .option(
    '--source-session <sessionId>',
    'Sending session. Set by the running bot for agent-shell sends; the target thread sees where the prompt came from',
  )
  .action(async (options) => {
      // Sends that cannot open the bot's database go through the running bot:
      // Slack, agent tool shells (per-session token, POST /roadie/agent/send,
      // see agent-remote.ts) and host users without data-dir access
      // (see remote-send.ts).
      const runningBot = resolveRunningBotSend(options)
      if (runningBot instanceof Error) {
        cliLogger.error(runningBot.message)
        process.exit(EXIT_NO_RESTART)
      }
      if (runningBot) {
        if (options.preRun) {
          cliLogger.error('--pre-run is not available when sending through the running bot')
          process.exit(EXIT_NO_RESTART)
        }
        const exitCode = await sendViaRunningBot({
          ...runningBot,
          options: remoteSendOptions(options),
          filePaths: (options.file ?? []).map((file: string) => path.resolve(file)),
        })
        process.exit(exitCode)
      }
      try {
        // `--name` / `--app-id` are optional-value flags: `undefined` when
        // omitted, `''` when passed bare, a real string when given a value.
        // `||` collapses `''` to `undefined` for downstream consumers.
        const optionAppId = options.appId || undefined
        let {
          channel: channelId,
          prompt,
          notifyOnly,
          thread: threadId,
          session: sessionId,
        } = options
        let name: string | undefined = options.name || undefined
        const sendAt = options.sendAt

        const existingThreadMode = Boolean(threadId || sessionId)

        if ((options.preRun || options.allowConcurrency) && !sendAt) {
          cliLogger.error('--pre-run and --allow-concurrency require --send-at')
          process.exit(EXIT_NO_RESTART)
        }

        if (threadId && sessionId) {
          cliLogger.error('Use either --thread or --session, not both')
          process.exit(EXIT_NO_RESTART)
        }

        if (existingThreadMode && channelId) {
          cliLogger.error(
            'Cannot combine --thread/--session with --channel',
          )
          process.exit(EXIT_NO_RESTART)
        }

        const directoryError = validateApplicationDirectory(options.cwd)
        if (directoryError) throw directoryError
        if (!existingThreadMode) {
          const destination = resolveSendChannel(channelId)
          if (destination instanceof Error) throw destination
          channelId = destination
        }

        if (!prompt) {
          cliLogger.error('Prompt is required. Use --prompt <prompt>')
          process.exit(EXIT_NO_RESTART)
        }

        const earlyModelCheck = await validateCliModelOption({
          model: options.model,
        })
        if (earlyModelCheck instanceof Error) {
          cliLogger.error(earlyModelCheck.message)
          process.exit(EXIT_NO_RESTART)
        }

        const filePaths = options.file?.length
          ? options.file.map((f: string) => path.resolve(f))
          : undefined

        if (sendAt) {
          if (options.wait) {
            cliLogger.error('Cannot use --wait with --send-at')
            process.exit(EXIT_NO_RESTART)
          }
          if (filePaths?.length) {
            cliLogger.error('Cannot use --file with --send-at')
            process.exit(EXIT_NO_RESTART)
          }
        }

        // Validate all --file paths exist and are regular files
        if (filePaths?.length) {
          // Discord allows max 10 attachments per message. Long prompts also
          // consume one slot (prompt.md), so reserve space for that.
          const maxUserFiles = prompt.length > 2000 ? 9 : 10
          if (filePaths.length > maxUserFiles) {
            cliLogger.error(
              `Too many files: ${filePaths.length} provided, Discord allows at most ${maxUserFiles} attachments per message` +
              (maxUserFiles === 9 ? ' (1 slot reserved for long prompt)' : ''),
            )
            process.exit(EXIT_NO_RESTART)
          }
          for (const file of filePaths) {
            if (!fs.existsSync(file)) {
              cliLogger.error(`File not found: ${file}`)
              process.exit(EXIT_NO_RESTART)
            }
            const stat = fs.statSync(file)
            if (!stat.isFile()) {
              cliLogger.error(`Not a regular file: ${file}`)
              process.exit(EXIT_NO_RESTART)
            }
          }
        }

        const parsedSchedule = (() => {
          if (!sendAt) {
            return null
          }
          // Cron expressions use UTC so the schedule is consistent regardless of
          // which machine runs the bot. The system message tells the model to use UTC.
          return parseSendAtValue({
            value: sendAt,
            now: new Date(),
            timezone: 'UTC',
          })
        })()
        if (parsedSchedule instanceof Error) {
          cliLogger.error(parsedSchedule.message)
          if (parsedSchedule.cause instanceof Error) {
            cliLogger.error(parsedSchedule.cause.message)
          }
          process.exit(EXIT_NO_RESTART)
        }

        const waitStartedAtMs = options.wait ? Date.now() : undefined

        if (options.cwd && notifyOnly) {
          cliLogger.error('Cannot use --cwd with --notify-only')
          process.exit(EXIT_NO_RESTART)
        }

        if (options.wait && notifyOnly) {
          cliLogger.error('Cannot use --wait with --notify-only')
          process.exit(EXIT_NO_RESTART)
        }

        if (existingThreadMode) {
          const incompatibleFlags: string[] = []
          if (notifyOnly) {
            incompatibleFlags.push('--notify-only')
          }
          if (options.cwd) {
            incompatibleFlags.push('--cwd')
          }
          if (name) {
            incompatibleFlags.push('--name')
          }

          if (incompatibleFlags.length > 0) {
            cliLogger.error(
              `Incompatible options with --thread/--session: ${incompatibleFlags.join(', ')}`,
            )
            process.exit(EXIT_NO_RESTART)
          }
        }

        // Initialize database first
        await initDatabase()

        const { token: botToken } = await resolveBotCredentials({
          appIdOverride: optionAppId,
        })

        const rest = createDiscordRest(botToken)

        const ctx: SendContext = { options, prompt, notifyOnly, threadId, sessionId, channelId, name, filePaths, parsedSchedule, waitStartedAtMs, rest, botToken }
        await (existingThreadMode ? sendToThread(ctx) : sendToChannel(ctx))
        process.exit(0)
      } catch (error) {
        cliLogger.error(
          'Error:',
          error instanceof Error ? error.stack : String(error),
        )
        process.exit(EXIT_NO_RESTART)
      }
    },
  )


export default cli
