// Terminal send command for creating Discord threads and scheduling prompts.
// Designed to work in CI/headless environments with just ROADIE_BOT_TOKEN.
// The local SQLite database (channel_directories) is NOT required for the basic
// flow: post message → create thread → remote bot picks it up. The local project
// directory mapping is only needed for --send-at, --wait, and --cwd.
import { goke } from 'goke'
import { z } from 'zod'
import { note } from '@clack/prompts'
import * as errore from 'errore'
import type { OpencodeClient, Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { Events, ActivityType, type PresenceStatusData, type Guild, Routes } from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createLogger, LogPrefix, initLogFile } from '../logger.js'
import { initDatabase, getChannelDirectory, initializeOpencodeForDirectory } from '../discord-bot.js'
import { applicationDirectory, resolveSendChannel, validateApplicationDirectory } from '../channel-policy.js'
import { getBotTokenWithMode, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, getDb, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory } from '../database.js'
import { ShareMarkdown } from '../markdown.js'
import { parseSessionSearchPattern, findFirstSessionSearchHit, buildSessionSearchSnippet, getPartSearchTexts } from '../session-search.js'
import { QUEUE_PREFIX } from '../message-formatting.js'
import type { ThreadStartMarker } from '../system-message.js'
import { buildOpencodeEventLogLine } from '../session-handler/opencode-session-event-log.js'
import { createDiscordRest } from '../discord-urls.js'
import { archiveThread, buildThreadStartEmbeds, ensureThreadMember, uploadFilesToDiscord, stripMentions } from '../discord-utils.js'
import { setDataDir, setProjectsDir, getDataDir, getProjectsDir, getLockPort } from '../config.js'
import { getSendToken, remoteSendOptions, sendViaRunningBot, shouldSendRemotely } from '../remote-send.js'
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

const cliLogger = createLogger(LogPrefix.CLI)
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
    '-d, --project <path>',
    'Removed: channels are application configuration; use --channel',
  )
  .option(
    '-p, --prompt <prompt>',
    'Message content. A busy --thread/--session takes it at its next step boundary; it never interrupts the run',
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
    '--worktree [name]',
    'Removed: create the checkout with your host tooling, then pass it with --cwd',
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
    'Post prompt to an existing thread. A busy session takes it at its next step boundary',
  )
  .option(
    '--session <sessionId>',
    'Post prompt to thread mapped to an existing session',
  )
  .option(
    '--parent-session <sessionId>',
    'Parent OpenCode session ID for newly created child sessions',
  )
  .option(
    '--wait',
    'Wait for session to complete, then print session text to stdout',
  )
  .action(async (options) => {
       if ((options.platform ?? process.env.ROADIE_PLATFORM) === 'slack') {
         const token = getSendToken()
         if (!token) { cliLogger.error('Set ROADIE_SERVICE_TOKEN (or its _FILE variant) to send through the running Slack bot'); process.exit(EXIT_NO_RESTART) }
         if (options.preRun || options.worktree || options.appId) { cliLogger.error('Use --cwd for native Slack working directories; --pre-run, --worktree and --app-id are not supported on this send path'); process.exit(EXIT_NO_RESTART) }
         const picked = remoteSendOptions(options)
         if (options.project) picked.project = options.project
         const exitCode = await sendViaRunningBot({ port: getLockPort(), token, options: picked, filePaths: (options.file ?? []).map((file: string) => path.resolve(file)) })
         process.exit(exitCode)
       }
      // A host user with a send token but no access to the bot's data dir
      // sends through the running bot instead (see remote-send.ts).
      if (shouldSendRemotely({ dataDir: getDataDir() })) {
        if (options.preRun) {
          cliLogger.error('--pre-run is not available when sending through the running bot')
          process.exit(EXIT_NO_RESTART)
        }
        const exitCode = await sendViaRunningBot({
          port: getLockPort(),
          token: getSendToken()!,
          options: remoteSendOptions(options),
          filePaths: (options.file ?? []).map((f: string) => path.resolve(f)),
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
        const { project: projectPath } = options
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

        if (existingThreadMode && (channelId || projectPath)) {
          cliLogger.error(
            'Cannot combine --thread/--session with --channel/--project',
          )
          process.exit(EXIT_NO_RESTART)
        }

        if (projectPath) {
          throw new Error('--project no longer selects channels. Use --channel or configure application.channel')
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
          if (prompt.length > 1900) {
            cliLogger.error(
              '--send-at currently supports prompts up to 1900 characters',
            )
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

        if (options.worktree) {
          cliLogger.error(
            '--worktree was removed: Roadie no longer creates git worktrees. Create the checkout with your own tooling and pass it with --cwd <path>.',
          )
          process.exit(EXIT_NO_RESTART)
        }

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

        if (existingThreadMode) {
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
          // (scheduled tasks and --wait).
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
          if (!channelConfig && (parsedSchedule || options.wait)) {
            const flag = parsedSchedule ? '--send-at' : '--wait'
            throw new Error(
              'Thread parent channel is not configured with a project directory. ' +
              `${flag} requires a local project mapping. Run the bot first to sync channel data.`,
            )
          }

          if (parsedSchedule) {
            const payload: ScheduledTaskPayload = {
              kind: 'thread',
              threadId: targetThreadId,
              prompt,
              agent: options.agent || null,
              model: options.model || null,
              username: threadTargetUser?.username || null,
              userId: threadTargetUser?.id || null,
              permissions: options.permission?.length ? options.permission : null,
              injectionGuardPatterns: options.injectionGuard?.length ? options.injectionGuard : null,
              parentSessionId: options.parentSession || null,
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

          const threadPromptMarker: ThreadStartMarker = {
            start: true,
            ...(threadTargetUser && {
              userId: threadTargetUser.id,
              ...(threadTargetUser.username && { username: threadTargetUser.username }),
            }),
            ...(options.agent && { agent: options.agent }),
            ...(options.model && { model: options.model }),
            ...(options.permission?.length ? { permissions: options.permission } : {}),
            ...(options.injectionGuard?.length ? { injectionGuardPatterns: options.injectionGuard } : {}),
            ...(options.parentSession && { parentSessionId: options.parentSession }),
          }
          const promptEmbed = await buildThreadStartEmbeds(threadPromptMarker)

          // Prefix the prompt so it's clear who sent it (matches /queue format).
          // Use a newline between prefix and prompt so leading /command
          // detection can find the command on its own line.
          const prefixedPrompt = `${QUEUE_PREFIX}**roadie-cli:**\n${prompt}`

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

          const threadUrl = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
          const existingSessionId = sessionId || await getThreadSession(targetThreadId)
          const sessionLine = existingSessionId ? `Session: ${existingSessionId}\n` : ''
          note(
            `Prompt sent to thread: ${threadData.name}\n${sessionLine}\nURL: ${threadUrl}`,
            '✅ Message Sent',
          )
          if (existingSessionId) process.stdout.write(`Session: ${existingSessionId}\n`)
          process.stdout.write(`${threadUrl}\n`)

          if (options.wait) {
            // channelConfig is guaranteed here: early guard above already
            // threw if channelConfig is missing when --wait is used.
            const { waitAndOutputSession } = await import('../wait-session.js')
            await waitAndOutputSession({
              threadId: targetThreadId,
              projectDirectory: channelConfig!.directory,
              waitStartedAtMs,
            })
          }

          process.exit(0)
        }

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
        // (--send-at, --wait, --cwd).
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
        const needsProjectDirectory = Boolean(parsedSchedule || options.wait || options.cwd)
        if (!channelConfig && needsProjectDirectory) {
          throw new Error(
            `Channel #${channelData.name} is not configured with a project directory. ` +
            `${parsedSchedule ? '--send-at' : options.wait ? '--wait' : '--cwd'} requires a local project mapping. ` +
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

        // Compute thread name and worktree name early (needed for embed)
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
            worktreeName: null,
            cwd: resolvedCwd || null,
            agent: options.agent || null,
            model: options.model || null,
            username: resolvedUser?.username || null,
            userId: resolvedUser?.id || null,
            permissions: options.permission?.length ? options.permission : null,
            injectionGuardPatterns: options.injectionGuard?.length ? options.injectionGuard : null,
            parentSessionId: options.parentSession || null,
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
        const embedMarker: ThreadStartMarker | undefined = notifyOnly
          ? undefined
          : {
              start: true,
              ...(resolvedCwd && { cwd: resolvedCwd }),
              ...(resolvedUser && {
                userId: resolvedUser.id,
                ...(resolvedUser.username && { username: resolvedUser.username }),
              }),
              ...(options.agent && { agent: options.agent }),
              ...(options.model && { model: options.model }),
              ...(options.permission?.length && { permissions: options.permission }),
              ...(options.injectionGuard?.length && { injectionGuardPatterns: options.injectionGuard }),
              ...(options.parentSession && { parentSessionId: options.parentSession }),
            }
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

        const worktreeNote = resolvedCwd
          ? `\nWorking directory: ${resolvedCwd}`
          : ''
        const sessionLine = newSessionId ? `\nSession: ${newSessionId}` : ''
        const directoryLine = projectDirectory ? `\nDirectory: ${projectDirectory}` : ''
        const successMessage = notifyOnly
          ? `Thread: ${threadData.name}${directoryLine}\n\nNotification created. Reply to start a session.\n\nURL: ${threadUrl}`
          : `Thread: ${threadData.name}${directoryLine}${worktreeNote}${sessionLine}\n\nThe running bot will pick this up and start the session.\n\nURL: ${threadUrl}`

        note(successMessage, '✅ Thread Created')

        if (newSessionId) process.stdout.write(`Session: ${newSessionId}\n`)
        process.stdout.write(`${threadUrl}\n`)

        if (options.wait) {
          // projectDirectory is guaranteed here: needsProjectDirectory check above
          // already threw if channelConfig is missing when --wait is used.
          const { waitAndOutputSession } = await import('../wait-session.js')
          await waitAndOutputSession({
            threadId: threadData.id,
            projectDirectory: projectDirectory!,
            waitStartedAtMs,
          })
        }

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
