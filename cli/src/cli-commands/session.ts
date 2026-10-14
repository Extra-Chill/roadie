// Session inspection and archival terminal commands.
import { goke } from 'goke'
import { z } from 'zod'
import dedent from 'string-dedent'
import { note } from '@clack/prompts'
import YAML from 'yaml'
import * as errore from 'errore'
import { Events, ActivityType, type PresenceStatusData, type Guild, Routes } from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createLogger, LogPrefix, initLogFile } from '../logger.js'
import { createDiscordClient, initDatabase, getChannelDirectory, createProjectChannels } from '../discord-bot.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import { AgentRequestError, type AgentBackend, type AgentBackendGetter } from '../agent-backend/types.js'
import type { AgentSession } from '../agent-backend/events.js'
import { getBotToken, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, getDb, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory, getThreadWorkingDirectory, getAllTextChannelDirectories } from '../database.js'
import { ShareMarkdown } from '../markdown.js'
import { parseSessionSearchPattern, collectSessionSearchMatches, validateSessionSearchScope, resolveSessionSearchDirectories, parseSessionSearchDays, sessionSearchMinUpdated, SESSION_SEARCH_DEFAULT_DAYS, type SessionSearchMatch } from '../session-search.js'
import { formatTimeAgo } from '../time-format.js'
import { editorsForFile, loadFileEditEvents } from '../file-edit-log.js'
import type { ThreadStartMarker } from '../system-message.js'
import { buildSessionEventLogLine, persistedEventProjectDirectory } from '../session-handler/session-event-log.js'
import { createDiscordRest } from '../discord-urls.js'
import { archiveThread, uploadFilesToDiscord, stripMentions } from '../discord-utils.js'
import { setDataDir, getDataDir } from '../config.js'
import { execAsync, validateWorktreeDirectory } from '../git-utils.js'
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
import {
  AGENT_SESSIONS_PATH,
  AGENT_SESSION_ARCHIVE_PATH,
  AGENT_SESSION_EDITORS_PATH,
  AGENT_SESSION_SEARCH_PATH,
  AGENT_SESSION_TITLE_PATH,
  AGENT_OPERATOR_ONLY_MESSAGE,
  resolveAgentCredentials,
  runAgentCommand,
  sessionArchiveBody,
  sessionDiscordUrlQuery,
  sessionEditorsQuery,
  sessionListQuery,
  sessionReadQuery,
  sessionSearchQuery,
  sessionTitleBody,
  isAgentMode,
} from '../agent-remote.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

async function resolveSessionDirectoryFromDatabase({
  sessionId,
}: {
  sessionId: string
}): Promise<Error | string> {
  const threadId = await getThreadIdBySessionId(sessionId)
  if (threadId) {
    const threadDir = await getThreadWorkingDirectory(threadId)
    if (threadDir) {
      return threadDir.workingDirectory
    }

    const { token: botToken } = await resolveBotCredentials({})
    const rest = createDiscordRest(botToken)
    const threadData = (await rest.get(Routes.channel(threadId))) as {
      id: string
      type: number
      parent_id?: string
    }
    if (!isThreadChannelType(threadData.type)) {
      return new Error(`Channel is not a thread: ${threadId}`)
    }
    if (!threadData.parent_id) {
      return new Error(`Thread has no parent channel: ${threadId}`)
    }
    const channelConfig = await getChannelDirectory(threadData.parent_id)
    if (!channelConfig) {
      return new Error(
        `Thread parent channel is not configured with a project directory: ${threadData.parent_id}`,
      )
    }
    return channelConfig.directory
  }

  return new Error(
    `Session is not linked to a Roadie thread in the local database: ${sessionId}`,
  )
}

// Compact token count: 1234 -> "1k", 200000 -> "200k", 1_500_000 -> "1.5M".
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`
  }
  if (count >= 1_000) {
    return `${Math.round(count / 1_000)}k`
  }
  return String(count)
}

cli
  .command(
    'session list',
    'List all agent sessions, marking which were started via Roadie',
  )
  .option(
    '--project <path>',
    'Project directory to list sessions for (defaults to cwd)',
  )
  .option('--all', 'List sessions across every locally registered project')
  .option('--active', 'Only list active sessions; exits 1 when none remain')
  .option('--exclude <sessionId>', 'Exclude one session ID from the results')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      // Agent tool shells hold a per-session token, not database credentials;
      // the running bot executes the listing and streams the same output back.
      const agent = resolveAgentCredentials()
      if (!(agent instanceof Error)) {
        // The bot's child process runs from the home directory, so the
        // caller's default project (cwd) must be sent explicitly. Keep
        // --project present whenever the caller passed it so the child
        // reproduces the use-either validation error identically.
        const project = options.project !== undefined
          ? path.resolve(options.project)
          : (options.all ? undefined : path.resolve('.'))
        const exitCode = await runAgentCommand({
          agent,
          request: {
            method: 'GET',
            path: AGENT_SESSIONS_PATH,
            query: sessionListQuery({ ...options, project }),
          },
        })
        process.exit(exitCode)
      }

      await initDatabase()

      if (options.all && options.project) {
        cliLogger.error('Use either --all or --project, not both')
        process.exit(EXIT_NO_RESTART)
      }

      const projectDirectories = options.all
        ? Array.from(
            new Set(
              (await getAllTextChannelDirectories()).map((directory) =>
                path.resolve(directory),
              ),
            ),
          )
        : [path.resolve(options.project || '.')]

      if (projectDirectories.length === 0) {
        cliLogger.error(
          'No registered project directories found. Bind channels to directories in the channels config (ROADIE_CHANNELS_CONFIG).',
        )
        process.exit(EXIT_NO_RESTART)
      }

      // Connect to each project's backend and gather sessions plus
      // their live idle/busy status. Only session.list + session.status are
      // called per project so the command stays fast; per-session token totals
      // come straight from the session objects with no message fetching.
      // A session parked on a `question` tool reports session.status busy but
      // is really waiting for the user, so it is not "active". Treat it as
      // `showing-question` (excluded by --active) using the backend's
      // server-authoritative pending-question list.
      type GatheredSession = {
        session: AgentSession
        projectDirectory: string
        status: 'idle' | 'busy' | 'showing-question'
      }

      const gathered: GatheredSession[] = []
      for (const projectDirectory of projectDirectories) {
        cliLogger.log(`Connecting to agent backend for ${projectDirectory}...`)
        const getBackend = await getAgentBackendProvider().initializeForDirectory(projectDirectory)
        if (getBackend instanceof Error) {
          if (options.all) {
            cliLogger.warn(
              `Skipping ${projectDirectory}: failed to connect to the agent backend: ${getBackend.message}`,
            )
            continue
          }
          cliLogger.error('Failed to connect to the agent backend:', getBackend.message)
          process.exit(EXIT_NO_RESTART)
        }

        const backend = getBackend()
        const [sessionsResult, statusResult, questionsResult] = await Promise.all([
          backend.sessions.list({}),
          backend.sessions.status({ directory: projectDirectory }),
          backend.sessions.questions?.({ directory: projectDirectory }),
        ])
        // Listing used to throw on a transport failure and ignore a rejection.
        if (sessionsResult instanceof Error && !(sessionsResult instanceof AgentRequestError)) {
          throw sessionsResult
        }

        const statuses = statusResult instanceof Error ? {} : statusResult
        const sessionsWithPendingQuestion = new Set(
          (questionsResult instanceof Error ? [] : questionsResult ?? []).map((request) => request.sessionId),
        )

        for (const session of sessionsResult instanceof Error ? [] : sessionsResult) {
          const status = statuses[session.id]
          const isBusy = Boolean(status && status.state !== 'idle')
          // Only relabel to showing-question when the session is actually busy.
          // An orphaned question left in the list after an abort (session idle)
          // must not hide or relabel an otherwise-idle session.
          gathered.push({
            session,
            projectDirectory,
            status: isBusy && sessionsWithPendingQuestion.has(session.id)
              ? 'showing-question'
              : isBusy
                ? 'busy'
                : 'idle',
          })
        }
      }

      const selected = gathered
        .filter((entry) => {
          if (entry.session.id === options.exclude) return false
          if (options.active && entry.status !== 'busy') return false
          return true
        })
        .sort((a, b) => (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0))

      if (selected.length === 0) {
        if (options.json) console.log('[]')
        else
          cliLogger.log(
            options.active ? 'No active sessions found' : 'No sessions found',
          )
        process.exit(options.active ? 1 : 0)
      }

      // Look up which sessions were started via roadie (have a thread mapping)
      const db = await getDb()
      const threadSessions = await db.query.thread_sessions.findMany({
        columns: { thread_id: true, session_id: true },
      })
      const sessionToThread = new Map(
        threadSessions
          .filter((row) => row.session_id !== '')
          .map((row) => [row.session_id, row.thread_id]),
      )
      const sessionStartSources = await getSessionStartSourcesBySessionIds(
        selected.map((entry) => entry.session.id),
      )

      const scheduleModeLabel = ({
        scheduleKind,
      }: {
        scheduleKind: 'at' | 'cron'
      }): 'delay' | 'cron' => {
        if (scheduleKind === 'at') {
          return 'delay'
        }
        return 'cron'
      }

      // Token footprint straight from the session object (no message fetch).
      // Session.tokens is a per-session aggregate, so it is reported as a token
      // count rather than a context-window percentage.
      const contextInfo = (entry: GatheredSession): number | null => {
        const usage = entry.session.usage
        if (!usage) return null
        const total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
        return total > 0 ? total : null
      }

      if (options.json) {
        const output = selected.map((entry) => {
          const session = entry.session
          const startSource = sessionStartSources.get(session.id)
          const startedBy = startSource
            ? `scheduled-${scheduleModeLabel({ scheduleKind: startSource.schedule_kind })}`
            : null
          return {
            id: session.id,
            title: session.title || 'Untitled Session',
            directory: session.directory ?? entry.projectDirectory,
            updated: new Date(session.updatedAt ?? 0).toISOString(),
            // Backend-neutral source label: 'roadie' threads were started via
            // Roadie, everything else came from the agent backend directly.
            source: sessionToThread.has(session.id) ? 'roadie' : 'agent',
            threadId: sessionToThread.get(session.id) || null,
            status: entry.status,
            model: session.model?.modelId || null,
            tokens: contextInfo(entry),
            startedBy,
            scheduledTaskId: startSource?.scheduled_task_id || null,
          }
        })
        console.log(JSON.stringify(output, null, 2))
        process.exit(0)
      }

      for (const entry of selected) {
        const session = entry.session
        const threadId = sessionToThread.get(session.id)
        const startSource = sessionStartSources.get(session.id)
        const source = threadId ? '(roadie)' : '(agent)'
        const startedBy = startSource
          ? ` | started-by: ${scheduleModeLabel({ scheduleKind: startSource.schedule_kind })}${startSource.scheduled_task_id ? ` (#${startSource.scheduled_task_id})` : ''}`
          : ''
        const updatedAt = new Date(session.updatedAt ?? 0).toISOString()
        const threadInfo = threadId ? ` | thread: ${threadId}` : ''
        const statusLabel = entry.status === 'busy'
          ? 'working'
          : entry.status === 'showing-question'
            ? 'showing-question'
            : 'idle'
        const statusInfo = ` | status: ${statusLabel}`
        const tokens = contextInfo(entry)
        const tokensText = tokens ? ` | tokens: ${formatTokenCount(tokens)}` : ''
        console.log(
          `${session.id} | ${session.title || 'Untitled Session'} | ${session.directory ?? entry.projectDirectory} | ${updatedAt} | ${source}${statusInfo}${tokensText}${threadInfo}${startedBy}`,
        )
      }

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session editors <file>',
    dedent`
      List sessions that last edited a file, newest first.

      Use this before a commit in another session so the \`Session:\` line
      uses the session that actually edited the file.
    `,
  )
  .option('--json', 'Output as JSON')
  .option(
    '--limit <n>',
    z.number().default(20).describe('Max sessions to show'),
  )
  .example('roadie session editors src/cli.ts')
  .example('roadie session editors src/cli.ts --json')
  .action(async (file, options, { console, process }) => {
    try {
      // Agent tool shells hold a per-session token, not database credentials;
      // the running bot executes the lookup and streams the same output back.
      const agent = resolveAgentCredentials()
      if (!(agent instanceof Error)) {
        // The bot's child process runs from the home directory, so the
        // caller's file path is resolved against the caller's cwd.
        const exitCode = await runAgentCommand({
          agent,
          request: {
            method: 'GET',
            path: AGENT_SESSION_EDITORS_PATH,
            query: sessionEditorsQuery({
              file: path.resolve(process.cwd, file),
              json: options.json,
              limit: options.limit,
            }),
          },
        })
        process.exit(exitCode)
      }

      const cwd = process.cwd
      const loaded = loadFileEditEvents({ dataDir: getDataDir() })
      if (loaded instanceof Error) {
        console.error(loaded.message)
        process.exit(EXIT_NO_RESTART)
        return
      }

      const editors = editorsForFile({
        events: loaded,
        filePath: file,
        cwd,
      }).slice(0, options.limit)
      if (editors.length === 0) {
        console.error(`No recorded editors for ${path.resolve(cwd, file)}`)
        process.exit(1)
        return
      }

      const titles = new Map<string, string>()
      try {
        await initDatabase()
        const db = await getDb()
        const sessionRows = await db.query.thread_sessions.findMany({
          columns: { session_id: true, last_synced_name: true },
          where: { session_id: { in: editors.map((editor) => editor.sessionId) } },
          orderBy: { updated_at: 'desc' },
        })
        for (const row of sessionRows) {
          if (!titles.has(row.session_id) && row.last_synced_name) {
            titles.set(row.session_id, row.last_synced_name)
          }
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
      }

      const rows = editors.map((editor) => {
        const title = titles.get(editor.sessionId) || '-'
        const editedAt = new Date(editor.at)
        return {
          sessionId: editor.sessionId,
          title,
          editedAt: editedAt.toISOString(),
          ago: formatTimeAgo(editedAt),
        }
      })

      if (options.json) {
        console.log(JSON.stringify(rows, null, 2))
        process.exit(0)
        return
      }

      for (const row of rows) {
        console.log(`${row.sessionId} | ${row.title} | ${row.ago}`)
      }
      process.exit(0)
    } catch (error) {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session read <sessionId>',
    dedent`
      Read a session conversation as markdown (pipe to file to grep).

      Thinking is omitted by default. Tool inputs are truncated. Use
      \`--thinking\` and \`--verbose\` for the full dump.
    `,
  )
  .option('--project <path>', 'Project directory (defaults to cwd)')
  .option('--verbose', 'Show full tool inputs and outputs instead of compact summaries')
  .option('--thinking', 'Include reasoning / thinking parts')
  .option(
    '--tool-input-max-chars <n>',
    z.number().default(80).describe('Max characters for compact tool input'),
  )
  .example('roadie session read ses_xxx > ./tmp/session.md')
  .example('roadie session read ses_xxx --thinking --verbose')
  .action(async (sessionId, options) => {
    try {
      // Agent tool shells hold a per-session token, not database credentials;
      // the running bot executes the read and streams the same output back.
      const agent = resolveAgentCredentials()
      if (!(agent instanceof Error)) {
        // Resolve the caller's default project (cwd) explicitly: the bot's
        // child process runs from the home directory.
        const exitCode = await runAgentCommand({
          agent,
          request: {
            method: 'GET',
            path: `${AGENT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}`,
            query: sessionReadQuery({ ...options, project: path.resolve(options.project || '.') }),
          },
        })
        process.exit(exitCode)
      }

      const projectDirectory = path.resolve(options.project || '.')

      await initDatabase()

      cliLogger.log('Connecting to agent backend...')
      const getBackend = await getAgentBackendProvider().initializeForDirectory(projectDirectory)
      if (getBackend instanceof Error) {
        cliLogger.error('Failed to connect to the agent backend:', getBackend.message)
        process.exit(EXIT_NO_RESTART)
      }

      // Try current project first (fast path)
      const compactTools = !options.verbose
      const markdown = new ShareMarkdown(getBackend())
      const result = await markdown.generate({
        sessionID: sessionId,
        compactTools,
        includeThinking: options.thinking,
        toolInputMaxChars: options.toolInputMaxChars,
      })
      if (!(result instanceof Error)) {
        process.stdout.write(result)
        process.exit(0)
      }

      // Session not found in the current project, search the other locally
      // registered projects. Backends are per directory, so every candidate
      // gets its own initializeForDirectory; unreadable directories are
      // skipped. This is the same project scope `session list --all` and
      // `session search --all` use.
      cliLogger.log('Session not in current project, searching all projects...')
      const otherDirectories = (await getAllTextChannelDirectories())
        .map((directory) => path.resolve(directory))
        .filter((directory) => directory !== projectDirectory)
        .filter((directory) => {
          try {
            fs.accessSync(directory, fs.constants.R_OK)
            return true
          } catch {
            return false
          }
        })

      for (const directory of otherDirectories) {
        cliLogger.log(`Trying project: ${directory}`)
        const otherBackend = await getAgentBackendProvider().initializeForDirectory(directory)
        if (otherBackend instanceof Error) continue
        const otherMarkdown = new ShareMarkdown(otherBackend())
        const otherResult = await otherMarkdown.generate({
          sessionID: sessionId,
          compactTools,
          includeThinking: options.thinking,
          toolInputMaxChars: options.toolInputMaxChars,
        })
        if (!(otherResult instanceof Error)) {
          process.stdout.write(otherResult)
          process.exit(0)
        }
      }

      cliLogger.error(`Session ${sessionId} not found in any project`)
      process.exit(EXIT_NO_RESTART)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session wait <sessionId>',
    'Wait until a session finishes or pauses for a user question, then print its conversation as markdown',
  )
  .action(async (sessionId) => {
    try {
      // Agent tool shells wait through the running bot; the token only
      // waits on its own session.
      const agent = resolveAgentCredentials()
      if (!(agent instanceof Error)) {
        const exitCode = await runAgentCommand({
          agent,
          request: {
            method: 'POST',
            path: `${AGENT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}/wait`,
          },
        })
        process.exit(exitCode)
      }

      await initDatabase()

      // Only a session this bot knows has persisted events to wait on.
      const known = await resolveSessionDirectoryFromDatabase({
        sessionId,
      })
      if (known instanceof Error) {
        cliLogger.error(known.message)
        process.exit(EXIT_NO_RESTART)
      }

      const { waitAndOutputExistingSession } = await import('../wait-session.js')
      await waitAndOutputExistingSession({ sessionId })

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session search <query>',
    `Search past sessions for text or /regex/flags. Defaults to the last ${SESSION_SEARCH_DEFAULT_DAYS} days; use --days 0 for all time. Add --all for every locally registered project.`,
  )
  .option('--project <path>', 'Project directory (defaults to cwd)')
  .option('--channel <channelId>', 'Resolve project from a Discord channel ID')
  .option('--all', 'Search every locally registered project')
  .option(
    '--days <n>',
    `Only search sessions updated in the last n days (default: ${SESSION_SEARCH_DEFAULT_DAYS}; 0 = all time)`,
  )
  .option('--limit <n>', 'Maximum matched sessions to return (default: 20)')
  .option('--json', 'Output as JSON')
  .example('roadie session search "auth timeout"')
  .example('roadie session search "auth timeout" --days 0')
  .example('roadie session search "auth timeout" --all')
  .action(async (query, options) => {
    try {
      // Agent tool shells hold a per-session token, not database credentials;
      // the running bot executes the search and streams the same output back.
      const agent = resolveAgentCredentials()
      if (!(agent instanceof Error)) {
        // The bot's child process runs from the home directory, so the
        // caller's implicit default project (cwd) must be sent explicitly.
        // Keep --project present whenever the caller passed it so scope
        // validation errors stay identical.
        const project = options.project !== undefined
          ? path.resolve(options.project)
          : (options.all || options.channel ? undefined : path.resolve('.'))
        const exitCode = await runAgentCommand({
          agent,
          request: {
            method: 'GET',
            path: AGENT_SESSION_SEARCH_PATH,
            query: { q: query, ...sessionSearchQuery({ ...options, project }) },
          },
        })
        process.exit(exitCode)
      }

      await initDatabase()

      const scopeError = validateSessionSearchScope({
        all: options.all,
        project: options.project,
        channel: options.channel,
      })
      if (scopeError) {
        cliLogger.error(scopeError.message)
        process.exit(EXIT_NO_RESTART)
      }

      const limit = (() => {
        const rawLimit =
          typeof options.limit === 'string' ? options.limit : '20'
        const parsed = Number.parseInt(rawLimit, 10)
        if (Number.isNaN(parsed) || parsed < 1) {
          return new Error(`Invalid --limit value: ${rawLimit}`)
        }
        return parsed
      })()

      if (limit instanceof Error) {
        cliLogger.error(limit.message)
        process.exit(EXIT_NO_RESTART)
      }

      const days = parseSessionSearchDays(
        typeof options.days === 'string' ? options.days : undefined,
      )
      if (days instanceof Error) {
        cliLogger.error(days.message)
        process.exit(EXIT_NO_RESTART)
      }
      const minUpdated = sessionSearchMinUpdated({ days })

      const explicitDirectory = await (async (): Promise<string | Error | undefined> => {
        if (options.all) {
          return undefined
        }
        if (options.channel) {
          const channelConfig = await getChannelDirectory(options.channel)
          if (!channelConfig) {
            return new Error(
              `No project mapping found for channel: ${options.channel}`,
            )
          }
          return path.resolve(channelConfig.directory)
        }
        if (options.project) {
          return path.resolve(options.project)
        }
        return undefined
      })()

      if (explicitDirectory instanceof Error) {
        cliLogger.error(explicitDirectory.message)
        process.exit(EXIT_NO_RESTART)
      }

      const registeredDirectories = options.all
        ? (await getAllTextChannelDirectories()).map((directory) => {
            return path.resolve(directory)
          })
        : []
      const projectDirectories = resolveSessionSearchDirectories({
        all: Boolean(options.all),
        registeredDirectories,
        cwd: path.resolve('.'),
        explicitDirectory,
      })
      if (projectDirectories instanceof Error) {
        cliLogger.error(projectDirectories.message)
        process.exit(EXIT_NO_RESTART)
      }

      const existingDirectories: string[] = []
      for (const directory of projectDirectories) {
        if (fs.existsSync(directory)) {
          existingDirectories.push(directory)
          continue
        }
        if (options.all) {
          cliLogger.warn(`Skipping missing directory: ${directory}`)
          continue
        }
        cliLogger.error(`Directory does not exist: ${directory}`)
        process.exit(EXIT_NO_RESTART)
      }
      if (existingDirectories.length === 0) {
        cliLogger.error(
          'No searchable project directories found. Bind channels to directories in the channels config (ROADIE_CHANNELS_CONFIG), or pass --project.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      const searchPattern = parseSessionSearchPattern(query)
      if (searchPattern instanceof Error) {
        cliLogger.error(searchPattern.message)
        process.exit(EXIT_NO_RESTART)
      }

      const clientsBySessionId = new Map<string, AgentBackendGetter>()
      const searchedDirectories: string[] = []
      const searchableSessions: Array<{
        id: string
        title: string
        directory: string
        updated: number
      }> = []

      const listedDirectories = await Promise.all(
        existingDirectories.map(async (projectDirectory) => {
          cliLogger.log(`Connecting to agent backend for ${projectDirectory}...`)
          const getClient = await getAgentBackendProvider().initializeForDirectory(projectDirectory)
          if (getClient instanceof Error) {
            return { projectDirectory, getClient, sessions: [] }
          }
          // A transport failure threw before; a rejection listed nothing.
          const sessions = await getClient().sessions.list({})
          if (sessions instanceof Error && !(sessions instanceof AgentRequestError)) throw sessions
          return {
            projectDirectory,
            getClient,
            sessions: sessions instanceof Error ? [] : sessions,
          }
        }),
      )
      for (const listed of listedDirectories) {
        if (listed.getClient instanceof Error) {
          if (options.all) {
            cliLogger.warn(
              `Skipping ${listed.projectDirectory}: failed to connect to the agent backend: ${listed.getClient.message}`,
            )
            continue
          }
          cliLogger.error(
            'Failed to connect to the agent backend:',
            listed.getClient.message,
          )
          process.exit(EXIT_NO_RESTART)
        }
        searchedDirectories.push(listed.projectDirectory)
        for (const session of listed.sessions) {
          clientsBySessionId.set(session.id, listed.getClient)
          searchableSessions.push({
            id: session.id,
            title: session.title || 'Untitled Session',
            directory: session.directory || listed.projectDirectory,
            updated: session.updatedAt ?? 0,
          })
        }
      }

      if (searchableSessions.length === 0) {
        cliLogger.log('No sessions found')
        process.exit(0)
      }

      const db = await getDb()
      const threadSessions = await db.query.thread_sessions.findMany({
        columns: { thread_id: true, session_id: true },
      })
      const sessionToThread = new Map(
        threadSessions
          .filter((row) => row.session_id !== '')
          .map((row) => [row.session_id, row.thread_id]),
      )

      const scopeLabel = options.all
        ? `${searchedDirectories.length} project(s)`
        : searchedDirectories[0] || path.resolve('.')
      const daysLabel =
        days === 0 ? 'all time' : `the last ${days} day${days === 1 ? '' : 's'}`
      const printMatch = (match: SessionSearchMatch) => {
        const threadInfo = match.threadId ? ` | thread: ${match.threadId}` : ''
        console.log(
          `${match.id} | ${match.title} | ${match.updated} | ${match.source}${threadInfo}`,
        )
        console.log(`  Directory: ${match.directory}`)
        match.snippets.forEach((snippet) => {
          console.log(`  - ${snippet}`)
        })
      }

      let printedHeader = false
      const { matches: matchedSessions, scannedSessions } =
        await collectSessionSearchMatches({
          sessions: searchableSessions,
          searchPattern,
          sessionToThread,
          limit,
          minUpdated,
          onMatch: options.json
            ? undefined
            : (match) => {
                if (!printedHeader) {
                  printedHeader = true
                  cliLogger.log(
                    `Found matching session(s) for ${searchPattern.raw} in ${scopeLabel} (${daysLabel})`,
                  )
                }
                printMatch(match)
              },
          loadMessages: async (session) => {
            const getClient = clientsBySessionId.get(session.id)
            if (!getClient) {
              return []
            }
            const messages = await getClient().sessions.messages({
              sessionId: session.id,
            })
            if (messages instanceof Error && !(messages instanceof AgentRequestError)) throw messages
            return messages instanceof Error ? [] : messages
          },
        })

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              query: searchPattern.raw,
              mode: searchPattern.mode,
              all: Boolean(options.all),
              days,
              projectDirectories: searchedDirectories,
              scannedSessions,
              matches: matchedSessions,
            },
            null,
            2,
          ),
        )
        process.exit(0)
      }

      if (matchedSessions.length === 0) {
        const cutoffHint =
          days === 0 ? '' : '. Use --days 0 to search all time'
        cliLogger.log(
          `No matches found for ${searchPattern.raw} in ${scopeLabel} (${scannedSessions} sessions scanned, ${daysLabel})${cutoffHint}`,
        )
        process.exit(0)
      }

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session export-events-jsonl',
    'Export persisted session events from SQLite to JSONL for debugging Roadie runtime bugs',
  )
  .option(
    '--session <sessionId>',
    'Session ID whose persisted event stream should be exported',
  )
  .option(
    '--out <file>',
    'Output .jsonl path (useful for reproducing Roadie issues in event-stream-state tests)',
  )
  .action(async (options) => {
    // Persisted event exports stay operator-only: agents never read the
    // event store directly.
    if (isAgentMode()) {
      cliLogger.error(AGENT_OPERATOR_ONLY_MESSAGE)
      process.exit(EXIT_NO_RESTART)
    }

    const sessionId =
      typeof options.session === 'string' ? options.session.trim() : ''
    if (!sessionId) {
      cliLogger.error('Missing --session value')
      process.exit(EXIT_NO_RESTART)
    }

    const outFile = typeof options.out === 'string' ? options.out.trim() : ''
    if (!outFile) {
      cliLogger.error('Missing --out value')
      process.exit(EXIT_NO_RESTART)
    }
    if (path.extname(outFile).toLowerCase() !== '.jsonl') {
      cliLogger.error('--out must point to a .jsonl file')
      process.exit(EXIT_NO_RESTART)
    }

    const outPath = path.resolve(outFile)
    const rows = await getSessionEventSnapshot({ sessionId })
    if (rows.length === 0) {
      cliLogger.error(
        `No persisted events found for session ${sessionId}. The session may not have emitted events yet.`,
      )
      process.exit(EXIT_NO_RESTART)
    }

    // Persisted rows hold Roadie agent events; rows written by an older
    // backend may hold other shapes, so nothing here assumes one.
    const parsedRows = rows.flatMap((row) => {
      const parsed = errore.try(
        { try: () => {
          return JSON.parse(row.event_json) as unknown
        }, catch: (error) => {
          return new Error('Failed to parse persisted event JSON', {
            cause: error,
          })
        } },
      )
      if (parsed instanceof Error) {
        cliLogger.warn(
          `Skipping invalid persisted event row ${row.id}: ${parsed.message}`,
        )
        return []
      }

      return [{ row, event: parsed }]
    })

    if (parsedRows.length === 0) {
      cliLogger.error(
        `No valid persisted events found for session ${sessionId}.`,
      )
      process.exit(EXIT_NO_RESTART)
    }

    const projectDirectory = parsedRows.reduce((directory, { event }) => {
      return directory || persistedEventProjectDirectory(event) || ''
    }, '')

    const lines = parsedRows.map(({ row, event }) => {
      return JSON.stringify(
        buildSessionEventLogLine({
          timestamp: Number(row.timestamp),
          threadId: row.thread_id,
          projectDirectory,
          event,
        }),
      )
    })
    const jsonl = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`

    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, jsonl, 'utf8')
    cliLogger.log(
      `Exported ${lines.length} events from ${sessionId} to ${outPath}`,
    )
    process.exit(0)
  })

cli
  .command(
    'session archive [threadId]',
    'Archive a Discord thread without stopping its mapped agent session',
  )
  .option('--session <sessionId>', 'Resolve thread from an agent session ID')
  .action(async (threadIdArg: string | undefined, options: { session?: string }) => {
    try {
      // Agent tool shells hold a per-session token, not database credentials;
      // the running bot does the Discord REST call and streams the same
      // output back.
      const agent = resolveAgentCredentials()
      if (!(agent instanceof Error)) {
        if (threadIdArg && options.session) {
          cliLogger.error('Use either a thread ID or --session, not both')
          process.exit(EXIT_NO_RESTART)
        }
        const exitCode = await runAgentCommand({
          agent,
          request: {
            method: 'POST',
            path: AGENT_SESSION_ARCHIVE_PATH,
            body: sessionArchiveBody({ threadId: threadIdArg, session: options.session }),
          },
        })
        process.exit(exitCode)
      }

      await initDatabase()

      // Resolve threadId from --session or positional arg
      const resolvedThreadId = await (async (): Promise<string> => {
        if (threadIdArg) {
          return threadIdArg
        }
        if (options.session) {
          const id = await getThreadIdBySessionId(options.session)
          if (!id) {
            cliLogger.error(`No Discord thread found for session: ${options.session}`)
            process.exit(EXIT_NO_RESTART)
          }
          return id
        }
        cliLogger.error('Provide a thread ID or --session <sessionId>')
        process.exit(EXIT_NO_RESTART)
      })()
      const { token: botToken } = await resolveBotCredentials()

      const rest = createDiscordRest(botToken)
      const threadData = (await rest.get(Routes.channel(resolvedThreadId))) as {
        id: string
        type: number
        name?: string
        parent_id?: string
      }

      if (!isThreadChannelType(threadData.type)) {
        cliLogger.error(`Channel is not a thread: ${resolvedThreadId}`)
        process.exit(EXIT_NO_RESTART)
      }

      const sessionId = options.session || await getThreadSession(resolvedThreadId)
      let client: AgentBackend | null = null
      if (sessionId && threadData.parent_id) {
        const channelConfig = await getChannelDirectory(threadData.parent_id)
        if (!channelConfig) {
          cliLogger.warn(
            `No channel directory mapping found for parent channel ${threadData.parent_id}`,
          )
        } else {
          const getBackend = await getAgentBackendProvider().initializeForDirectory(
            channelConfig.directory,
          )
          if (getBackend instanceof Error) {
            cliLogger.warn(
              `Could not initialize the agent backend for ${channelConfig.directory}: ${getBackend.message}`,
            )
          } else {
            client = getBackend()
          }
        }
      } else {
        cliLogger.warn(
          `No mapped agent session found for thread ${resolvedThreadId}`,
        )
      }

      await archiveThread({
        rest,
        threadId: resolvedThreadId,
        parentChannelId: threadData.parent_id,
        sessionId,
        client,
      })

      const threadLabel = threadData.name || resolvedThreadId
      note(
        `Archived thread: ${threadLabel}\nThread ID: ${resolvedThreadId}`,
        '✅ Archived',
      )
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session abort <sessionId>',
    'Abort a running session without archiving the thread',
  )
  .action(async (sessionId) => {
    try {
      // Agent tool shells hold a per-session token, not database credentials;
      // the running bot does the abort and the Discord REST call and streams
      // the same output back.
      const agent = resolveAgentCredentials()
      if (!(agent instanceof Error)) {
        const exitCode = await runAgentCommand({
          agent,
          request: {
            method: 'POST',
            path: `${AGENT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}/abort`,
          },
        })
        process.exit(exitCode)
      }

      await initDatabase()

      const { token: botToken } = await resolveBotCredentials()
      const rest = createDiscordRest(botToken)

      // Try to resolve the project directory for the backend abort call
      const directory = await resolveSessionDirectoryFromDatabase({ sessionId })
      if (directory instanceof Error) {
        cliLogger.error(directory.message)
        process.exit(EXIT_NO_RESTART)
      }

      const serverResult = await getAgentBackendProvider().initializeForDirectory(directory)
      if (serverResult instanceof Error) {
        cliLogger.error(`Failed to initialize the agent backend: ${serverResult.message}`)
        process.exit(EXIT_NO_RESTART)
      }

      const client = serverResult()
      // Don't pass directory — the backend resolves sessions by ID,
      // matching archiveThread's pattern.
      // This avoids issues when --cwd was used (session directory != project directory).
      // A rejection was not treated as failure before; only a transport error.
      const abortResult = await client.sessions.abort({ sessionId })
      if (abortResult instanceof Error && !(abortResult instanceof AgentRequestError)) {
        cliLogger.error('Failed to abort session')
        process.exit(EXIT_NO_RESTART)
      }

      // Post a message in the Discord thread so it's clear why the session stopped
      const threadId = await getThreadIdBySessionId(sessionId)
      if (threadId) {
        await rest.post(Routes.channelMessages(threadId), {
          body: { content: 'Session aborted via CLI' },
        }).catch((e) => {
          cliLogger.warn(`Could not post abort message to thread: ${e instanceof Error ? e.message : String(e)}`)
        })
      }

      note(
        `Aborted session: ${sessionId}${threadId ? `\nThread ID: ${threadId}` : ''}`,
        '✅ Aborted',
      )
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session title <title>',
    'Update the agent session title. Discord thread name follows automatically.',
  )
  .option('--session <sessionId>', 'Agent session ID')
  .option('--thread <threadId>', 'Discord thread ID')
  .example("roadie session title 'Fix queue draining' --session ses_xxx")
  .action(async (title, options) => {
    try {
      // Agent tool shells retitle their own session through the running bot;
      // the endpoint takes no session selector.
      const agent = resolveAgentCredentials()
      if (!(agent instanceof Error)) {
        const trimmedTitle = title.trim()
        if (!trimmedTitle) {
          cliLogger.error('Title must not be empty')
          process.exit(EXIT_NO_RESTART)
        }
        if (options.session || options.thread) {
          cliLogger.error('--session and --thread are not available through the running bot; the command retitles the current session')
          process.exit(EXIT_NO_RESTART)
        }
        const exitCode = await runAgentCommand({
          agent,
          request: {
            method: 'POST',
            path: AGENT_SESSION_TITLE_PATH,
            body: sessionTitleBody({ title: trimmedTitle }),
          },
        })
        process.exit(exitCode)
      }

      await initDatabase()

      const trimmedTitle = title.trim()
      if (!trimmedTitle) {
        cliLogger.error('Title must not be empty')
        process.exit(EXIT_NO_RESTART)
      }
      if (options.session && options.thread) {
        cliLogger.error('Use either --session or --thread, not both')
        process.exit(EXIT_NO_RESTART)
      }
      if (!options.session && !options.thread) {
        cliLogger.error('Provide --session <sessionId> or --thread <threadId>')
        process.exit(EXIT_NO_RESTART)
      }

      const sessionId = await (async () => {
        if (options.session) return options.session
        const threadId = options.thread
        if (!threadId) return null
        return getThreadSession(threadId)
      })()
      if (!sessionId) {
        cliLogger.error(
          options.thread
            ? `No agent session found for thread: ${options.thread}`
            : 'Provide --session <sessionId> or --thread <threadId>',
        )
        process.exit(EXIT_NO_RESTART)
      }

      const directory = await resolveSessionDirectoryFromDatabase({
        sessionId,
      })
      if (directory instanceof Error) {
        cliLogger.error(directory.message)
        process.exit(EXIT_NO_RESTART)
      }

      const serverResult = await getAgentBackendProvider().initializeForDirectory(directory)
      if (serverResult instanceof Error) {
        cliLogger.error(`Failed to initialize the agent backend: ${serverResult.message}`)
        process.exit(EXIT_NO_RESTART)
      }

      const setTitle = serverResult().sessions.setTitle
      if (!setTitle) {
        cliLogger.error('The agent backend cannot rename sessions')
        process.exit(EXIT_NO_RESTART)
      }
      const updateResult = await setTitle({
        sessionId,
        title: trimmedTitle,
      })
      if (updateResult instanceof AgentRequestError) {
        cliLogger.error('The agent backend rejected the session title update')
        process.exit(EXIT_NO_RESTART)
      }
      if (updateResult instanceof Error) {
        cliLogger.error(updateResult.message)
        process.exit(EXIT_NO_RESTART)
      }

      note(`Updated session title: ${trimmedTitle}`, 'Title updated')
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session discord-url <sessionId>',
    'Print the Discord thread URL for a session',
  )
  .option('--json', 'Output as JSON')
  .action(async (sessionId, options) => {
    // Agent tool shells hold a per-session token, not database credentials;
    // the running bot resolves the thread and streams the same output back.
    const agent = resolveAgentCredentials()
    if (!(agent instanceof Error)) {
      const exitCode = await runAgentCommand({
        agent,
        request: {
          method: 'GET',
          path: `${AGENT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}/discord-url`,
          query: sessionDiscordUrlQuery(options),
        },
      })
      process.exit(exitCode)
    }

    await initDatabase()
    const threadId = await getThreadIdBySessionId(sessionId)
    if (!threadId) {
      cliLogger.error(`No Discord thread found for session: ${sessionId}`)
      process.exit(EXIT_NO_RESTART)
    }
    const { token: botToken } = await resolveBotCredentials()
    const rest = createDiscordRest(botToken)
    const threadData = (await rest.get(Routes.channel(threadId))) as {
      id: string
      guild_id: string
      name?: string
    }
    const url = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
    if (options.json) {
      console.log(JSON.stringify({
        url,
        threadId: threadData.id,
        guildId: threadData.guild_id,
        sessionId,
        threadName: threadData.name,
      }))
    } else {
      console.log(url)
    }
    process.exit(0)
  })


export default cli
