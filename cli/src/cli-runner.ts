// Runtime startup and shared helpers for the Roadie goke CLI.
// Keeps cli.ts focused on command composition while preserving the bot onboarding flow.
import {
  intro,
  outro,
  text,
  password,
  note,
  cancel,
  isCancel,
  confirm,
  log,
  multiselect,
  select,
  spinner,
} from '@clack/prompts'
import {
  deduplicateByKey,
  generateBotInstallUrl,
  abbreviatePath,
} from './utils.js'
import {
  getChannelsWithDescriptions,
  createDiscordClient,
  initDatabase,
  getChannelDirectory,
  startDiscordBot,
  registerBotLifecycleHandlers,
  initializeOpencodeForDirectory,
  assertCompatibleOpencodeVersion,
  createProjectChannels,
  createDefaultRoadieChannel,
  type ChannelWithTags,
} from './discord-bot.js'
import {
  getBotTokenWithMode,
  ensureServiceAuthToken,
  setBotToken,
  setChannelDirectory,
  findChannelsByDirectory,
  getDb,
} from './database.js'
import * as orm from 'drizzle-orm'
import * as dbSchema from './schema.js'
import { selectResolvedCommand } from './opencode-command.js'
import {
  Events,
  ChannelType,
  type Guild,
  type REST,
  Routes,
  AttachmentBuilder,
} from 'discord.js'
import { discordApiUrl, getDiscordRestApiUrl } from './discord-urls.js'
import { extractBtwQueueSuffix } from './btw-prefix-detection.js'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'
import {
  uploadFilesToDiscord,
  stripMentions,
  isThreadChannelType,
} from './discord-utils.js'
import { setDataDir, getDataDir } from './config.js'
import { execAsync } from './worktrees.js'
import { backgroundUpgradeKimaki } from './upgrade.js'
import { sendWelcomeMessage } from './onboarding-welcome.js'
import { startHranaServer } from './hrana-server.js'
import { startIpcPolling, stopIpcPolling } from './ipc-polling.js'
import { type ParsedSendAt } from './task-schedule.js'
import { store } from './store.js'
import { registerCommands, SKIP_USER_COMMANDS } from './discord-command-registration.js'

export const cliLogger = createLogger(LogPrefix.CLI)



export type OpenUrlCommand = {
  command: string
  args: string[]
}

export function getOpenUrlCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): OpenUrlCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] }
  }
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  }
  return { command: 'xdg-open', args: [url] }
}

function openUrlInDefaultBrowser(url: string): void {
  const { command, args } = getOpenUrlCommand(url)
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', (error) => {
    cliLogger.warn(
      'Failed to open install URL:',
      error instanceof Error ? error.message : String(error),
    )
  })
  child.unref()
}

// Strip bracketed paste escape sequences from terminal input.
// iTerm2 and other terminals wrap pasted content with \x1b[200~ and \x1b[201~
// which can cause validation to fail on macOS. See: https://github.com/remorses/kimaki/issues/18
export function stripBracketedPaste(value: string | undefined): string {
  if (!value) {
    return ''
  }
  return value
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .trim()
}


// Derive the Discord Application ID from a bot token.
// Discord bot tokens have the format: base64(userId).timestamp.hmac
// The first segment is the bot's user ID (= Application ID) base64-encoded.
// Tokens in "client_id:secret" form (Kimaki's removed gateway mode) are not
// bot tokens and return undefined.
export function appIdFromToken(token: string): string | undefined {
  if (token.includes(':')) {
    return undefined
  }
  const segment = token.split('.')[0]
  if (!segment) {
    return undefined
  }
  try {
    const decoded = Buffer.from(segment, 'base64').toString('utf8')
    if (/^\d{17,20}$/.test(decoded)) {
      return decoded
    }
    return undefined
  } catch {
    return undefined
  }
}

// Resolve bot token and app ID from env var or database.
// Used by CLI subcommands (send, project add) that need credentials
// but don't run the interactive wizard.
//
// Priority: ROADIE_BOT_TOKEN env var takes precedence over saved DB
// credentials. This lets CI and cross-instance commands override the
// local bot identity.
export async function resolveBotCredentials({ appIdOverride }: { appIdOverride?: string } = {}): Promise<{
  token: string
  appId: string | undefined
}> {
  const envToken = process.env.ROADIE_BOT_TOKEN
  if (envToken) {
    const appId = appIdOverride || appIdFromToken(envToken)
    return { token: envToken, appId }
  }

  // Fall back to saved credentials in the database
  const botRow = await getBotTokenWithMode().catch((e) => {
    cliLogger.error('Database error:', e instanceof Error ? e.message : String(e))
    return null
  })
  if (botRow) {
    return { token: botRow.token, appId: appIdOverride || botRow.appId }
  }

  cliLogger.error('No bot token found. Set ROADIE_BOT_TOKEN env var or run `roadie` first to set up.')
  process.exit(EXIT_NO_RESTART)
}

export { isThreadChannelType }

/** Wrap long lines so prompt.md is readable in Discord's attachment preview. */
function wrapPromptAttachmentText(prompt: string): string {
  return prompt
    .split('\n')
    .flatMap((line) => {
      if (line.length <= 120) {
        return [line]
      }
      const wrapped: string[] = []
      let remaining = line
      const maxCol = 120
      // Only soft-break at a space if it's reasonably close to maxCol,
      // otherwise hard-break to avoid tiny fragments from early spaces
      const minSoftBreak = 90
      while (remaining.length > maxCol) {
        const lastSpace = remaining.lastIndexOf(' ', maxCol)
        const useSoftBreak = lastSpace >= minSoftBreak
        const breakAt = useSoftBreak ? lastSpace : maxCol
        wrapped.push(remaining.slice(0, breakAt))
        // Only consume the separator space on soft breaks
        remaining = useSoftBreak
          ? remaining.slice(breakAt + 1)
          : remaining.slice(breakAt)
      }
      if (remaining.length > 0) {
        wrapped.push(remaining)
      }
      return wrapped
    })
    .join('\n')
}

/**
 * Visible message content + prompt.md text for prompts over Discord's limit.
 * The bot reads queue/btw suffixes only from message content, so the suffix
 * moves from the file to the visible message and the send still queues or forks.
 */
export function buildLongPromptMessage(prompt: string): {
  content: string
  fileText: string
} {
  const { prompt: fileText, forceQueue, forceBtw } = extractBtwQueueSuffix(prompt)
  const preview = fileText.slice(0, 100).replace(/\n/g, ' ')
  const summary = `Prompt attached as file (${fileText.length} chars)\n\n> ${preview}…`
  const suffix = [forceBtw && 'btw', forceQueue && 'queue'].filter(Boolean).join(' ')
  return { content: suffix ? `${summary}\n\n${suffix}` : summary, fileText }
}

function promptAttachmentBlob(text: string) {
  return new Blob([new Uint8Array(Buffer.from(text, 'utf8'))], {
    type: 'text/markdown',
  })
}

export async function sendDiscordMessageWithOptionalAttachment({
  channelId,
  prompt,
  botToken,
  embeds,
  rest,
  splitInsteadOfAttach,
  files,
}: {
  channelId: string
  prompt: string
  botToken: string
  embeds?: Array<{ color: number; footer: { text: string } }>
  /** Only `post` is used (short prompt / split paths). Accept a narrow shape so tests need no cast. */
  rest: Pick<REST, 'post'>
  /** When true, long messages are split into multiple Discord messages instead of
   *  being attached as a file. Useful for notify-only messages where the content
   *  should be directly visible in the channel. */
  splitInsteadOfAttach?: boolean
  /** Local file paths to attach to the message (images, text files, etc.). */
  files?: string[]
}): Promise<{ id: string }> {
  const discordMaxLength = 2000

  // When files are provided, always use multipart FormData upload
  if (files?.length) {
    const { DISCORD_DEFAULT_MAX_FILE_SIZE } = await import('./discord-utils.js')
    const { default: mime } = await import('mime')

    for (const file of files) {
      const stat = fs.statSync(file)
      if (stat.size > DISCORD_DEFAULT_MAX_FILE_SIZE) {
        const fileMB = (stat.size / 1024 / 1024).toFixed(1)
        const limitMB = (DISCORD_DEFAULT_MAX_FILE_SIZE / 1024 / 1024).toFixed(0)
        throw new Error(
          `File "${path.basename(file)}" is ${fileMB} MB, which exceeds Discord's ${limitMB} MB upload limit`,
        )
      }
    }

    // When prompt exceeds Discord's limit, attach it as prompt.md alongside
    // user files so nothing is silently lost. Build prompt.md from memory so
    // parallel roadie send processes never share or unlink a temp path.
    const longPrompt = prompt.length > discordMaxLength
      ? buildLongPromptMessage(prompt)
      : undefined
    const content = longPrompt ? longPrompt.content : prompt

    const allFiles: Array<{ data: Uint8Array; filename: string; mimeType: string }> =
      files.map((file) => ({
        data: new Uint8Array(fs.readFileSync(file)),
        filename: path.basename(file),
        mimeType: mime.getType(file) || 'application/octet-stream',
      }))

    if (longPrompt) {
      allFiles.push({
        data: new Uint8Array(Buffer.from(longPrompt.fileText, 'utf8')),
        filename: 'prompt.md',
        mimeType: 'text/markdown',
      })
    }

    const attachments = allFiles.map((f, index) => ({
      id: index,
      filename: f.filename,
    }))

    const formData = new FormData()
    formData.append(
      'payload_json',
      JSON.stringify({
        content,
        attachments,
        embeds,
        allowed_mentions: { parse: store.getState().allowedMentions },
      }),
    )

    for (const [index, f] of allFiles.entries()) {
      formData.append(
        `files[${index}]`,
        new Blob([f.data], { type: f.mimeType }),
        f.filename,
      )
    }

    const response = await fetch(
      discordApiUrl(`/channels/${channelId}/messages`),
      {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}` },
        body: formData,
      },
    )
    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Discord API error: ${response.status} - ${error}`)
    }
    return (await response.json()) as { id: string }
  }

  if (prompt.length <= discordMaxLength) {
    return (await rest.post(Routes.channelMessages(channelId), {
      body: {
        content: prompt,
        embeds,
        allowed_mentions: { parse: store.getState().allowedMentions },
      },
    })) as { id: string }
  }

  if (splitInsteadOfAttach) {
    const { splitMarkdownForDiscord } = await import('./discord-utils.js')
    const chunks = splitMarkdownForDiscord({
      content: prompt,
      maxLength: discordMaxLength,
    })
    let firstMessage: { id: string } | undefined
    for (let chunk of chunks) {
      if (!chunk?.trim()) continue
      // Safety net: hard-truncate if splitting still produced an oversized chunk
      if (chunk.length > discordMaxLength) {
        chunk = chunk.slice(0, discordMaxLength - 4) + '...'
      }
      const message = (await rest.post(Routes.channelMessages(channelId), {
        body: {
          content: chunk,
          // Only attach embeds to the first message
          ...(firstMessage ? {} : { embeds }),
          allowed_mentions: { parse: store.getState().allowedMentions },
        },
      })) as { id: string }
      if (!firstMessage) firstMessage = message
    }
    return firstMessage!
  }

  const longPrompt = buildLongPromptMessage(prompt)
  // In-memory Blob only — no temp file. Parallel send must never share a path.
  const formData = new FormData()
  formData.append(
    'payload_json',
    JSON.stringify({
      content: longPrompt.content,
      attachments: [{ id: 0, filename: 'prompt.md' }],
      embeds,
      allowed_mentions: { parse: store.getState().allowedMentions },
    }),
  )
  formData.append(
    'files[0]',
    promptAttachmentBlob(wrapPromptAttachmentText(longPrompt.fileText)),
    'prompt.md',
  )

  const starterMessageResponse = await fetch(
    discordApiUrl(`/channels/${channelId}/messages`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
      },
      body: formData,
    },
  )

  if (!starterMessageResponse.ok) {
    const error = await starterMessageResponse.text()
    throw new Error(
      `Discord API error: ${starterMessageResponse.status} - ${error}`,
    )
  }

  return (await starterMessageResponse.json()) as { id: string }
}

export function formatRelativeTime(target: Date): string {
  const diffMs = target.getTime() - Date.now()
  if (diffMs <= 0) {
    return 'due now'
  }

  const totalSeconds = Math.floor(diffMs / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

export function formatTaskScheduleLine(schedule: ParsedSendAt): string {
  if (schedule.scheduleKind === 'at') {
    return `one-time at ${schedule.runAt.toISOString()}`
  }
  return `cron "${schedule.cronExpr}" (${schedule.timezone}) next ${schedule.nextRunAt.toISOString()}`
}

export const EXIT_NO_RESTART = 64
// Temporary failure (sysexits EX_TEMPFAIL). Wrapper retries forever with
// backoff and does not count this toward the crash-loop detector. Used when
// Discord login fails because the network is down.
export const EXIT_TEMPFAIL = 75

export type GuildMemberSearchResult = {
  user: { id: string; username: string; global_name?: string }
  nick?: string
}

export type DiscordUserTarget = {
  id: string
  username?: string
}

export function isGuildMemberSearchResult(value: object | null): value is GuildMemberSearchResult {
  if (!value) {
    return false
  }
  const user = Reflect.get(value, 'user')
  return (
    typeof user === 'object' &&
    user !== null &&
    typeof Reflect.get(user, 'id') === 'string' &&
    typeof Reflect.get(user, 'username') === 'string'
  )
}

export function getDiscordUserIdFromUserOption(user: string): string | null {
  const trimmed = user.trim()
  const mentionMatch = trimmed.match(/^<@!?(\d{15,25})>$/)
  if (mentionMatch?.[1]) {
    return mentionMatch[1]
  }
  if (/^\d{15,25}$/.test(trimmed)) {
    return trimmed
  }
  return null
}

function readErrorField(error: object | null, key: string): unknown {
  if (!error) {
    return undefined
  }

  const directValue = Reflect.get(error, key)
  if (directValue !== undefined) {
    return directValue
  }

  const rawError = Reflect.get(error, 'rawError')
  if (typeof rawError === 'object' && rawError !== null) {
    const rawValue = Reflect.get(rawError, key)
    if (rawValue !== undefined) {
      return rawValue
    }
  }

  const cause = Reflect.get(error, 'cause')
  if (typeof cause === 'object' && cause !== null) {
    return readErrorField(cause, key)
  }

  return undefined
}

/** Transient network errors that may resolve on retry (DNS down, gateway unreachable, TLS blips). */
const TRANSIENT_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // TLS/cert errors can be transient (intermediate CA blip, MITM proxy, cert rotation).
  // Without these, Discord login failure exits EXIT_NO_RESTART and the bin wrapper
  // never restarts — the bot dies permanently on "unable to verify the first certificate".
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  // undici fetch/WebSocket connect failures when the network is down.
  // Without these, Discord login exits EXIT_NO_RESTART and the wrapper never
  // comes back after a connect timeout to discord-gateway.kimaki.dev.
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

const TRANSIENT_ERROR_NAMES = new Set([
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'SocketError',
])

const TRANSIENT_ERROR_MESSAGE_PATTERNS = [
  /unable to verify the first certificate/i,
  /certificate has expired/i,
  /self[- ]signed certificate/i,
  /unable to get local issuer certificate/i,
  /connect timeout error/i,
  /headers timeout error/i,
  /body timeout error/i,
]

export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true
  if (TRANSIENT_ERROR_NAMES.has(error.name)) return true
  // Fallback when code is stripped by wrappers (discord.js sometimes rethrows by message only).
  if (
    TRANSIENT_ERROR_MESSAGE_PATTERNS.some((pattern) =>
      pattern.test(error.message),
    )
  ) {
    return true
  }
  // discord.js wraps errors in cause chains
  if (error.cause instanceof Error) return isTransientNetworkError(error.cause)
  return false
}

export function isDiscordMemberLookupUnavailable(error: Error): boolean {
  const status = readErrorField(error, 'status')
  if (status === 403) {
    return true
  }

  const code = readErrorField(error, 'code')
  if (code === 50001 || code === 50013) {
    return true
  }

  const message = String(readErrorField(error, 'message') || '').toLowerCase()
  return (
    (message.includes('missing access') ||
      message.includes('missing permissions') ||
      message.includes('intent')) &&
    message.includes('member')
  )
}

export function formatMemberLookupUnavailableMessage(): string {
  return [
    'Discord member search is unavailable for this bot.',
    'Most Roadie features still work. Searching names with `--user` needs Server Members Intent.',
    'Use a Discord user ID or raw mention with the same `--user` flag instead:',
    `  roadie send --channel <channelId> --prompt '...' --user 535922349652836367`,
    `  roadie send --channel <channelId> --prompt '...' --user '<@535922349652836367>'`,
  ].join('\n')
}

export async function resolveDiscordUserOption({
  user,
  guildId,
  rest,
}: {
  user: string | undefined
  guildId: string
  rest: REST
}): Promise<Error | DiscordUserTarget | undefined> {
  if (!user) {
    return undefined
  }

  const directUserId = getDiscordUserIdFromUserOption(user)
  if (directUserId) {
    cliLogger.log(`Using Discord user ID: ${directUserId}`)
    return { id: directUserId }
  }

  cliLogger.log(`Searching for user "${user}" in guild...`)
  const searchResult = await rest
    .get(Routes.guildMembersSearch(guildId), {
      query: new URLSearchParams({ query: user, limit: '10' }),
    })
    .catch((error) => new Error('Discord member search failed', { cause: error }))

  if (searchResult instanceof Error) {
    if (isDiscordMemberLookupUnavailable(searchResult)) {
      return new Error(formatMemberLookupUnavailableMessage())
    }
    return searchResult
  }

  const searchResults = Array.isArray(searchResult)
    ? searchResult.filter(isGuildMemberSearchResult)
    : []
  const exactMatch = searchResults.find((member) => {
    const displayName = member.nick || member.user.global_name || member.user.username
    return (
      displayName.toLowerCase() === user.toLowerCase() ||
      member.user.username.toLowerCase() === user.toLowerCase()
    )
  })
  const member = exactMatch || searchResults[0]
  if (!member) {
    return new Error(`User "${user}" not found in guild`)
  }

  const username = member.nick || member.user.global_name || member.user.username
  cliLogger.log(`Found user: ${username} (${member.user.id})`)
  return { id: member.user.id, username }
}

export function canUseInteractivePrompts(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function exitNonInteractiveSetup(): never {
  cliLogger.error(
    'Setup requires an interactive terminal (TTY) for prompts. Run `roadie` in an interactive shell to complete setup.',
  )
  process.exit(EXIT_NO_RESTART)
}

// All structured events emitted on stdout in non-TTY mode (cloud sandboxes, CI).
// Consumers parse these with the eventsource-parser npm package.
export type ProgrammaticEvent =
	| { type: 'install_url'; url: string }
	| { type: 'authorized'; guild_id: string }
	| { type: 'ready'; app_id: string; guild_ids: string[] }
	| { type: 'error'; message: string; install_url?: string }

// Emit a structured JSON line on stdout for non-TTY consumers (cloud sandboxes, CI).
// Each line is a self-contained JSON object with a "type" field for easy parsing.
// Lines are prefixed with "data: " and terminated with "\n\n" (SSE format) so consumers
// can use the eventsource-parser npm package to robustly extract JSON events from noisy
// process output (other log lines, warnings, etc. are ignored by the parser).
export function emitJsonEvent(event: ProgrammaticEvent): void {
	process.stdout.write(`data: ${JSON.stringify(event)}\n\n`)
}

export async function printDiscordInstallUrlAndExit() {
  await initDatabase()

  const existingBot = await getBotTokenWithMode()

  if (!existingBot) {
    cliLogger.error('No bot configured yet. Run `roadie` first to set up.')
    process.exit(EXIT_NO_RESTART)
  }

  cliLogger.log(generateBotInstallUrl({ clientId: existingBot.appId }))

  process.exit(0)
}

// Detect if a CLI tool is installed, prompt to install if missing.
// Uses official install scripts with platform-specific commands for Unix vs Windows.
// Sets process.env[envPathKey] to the found binary path for the current session.
// After install, re-checks PATH first, then falls back to common install locations.
export async function ensureCommandAvailable({
  name,
  envPathKey,
  installUnix,
  installWindows,
  possiblePathsUnix,
  possiblePathsWindows,
}: {
  name: string
  envPathKey: string
  installUnix: string
  installWindows: string
  possiblePathsUnix: string[]
  possiblePathsWindows: string[]
}): Promise<void> {
  if (process.env[envPathKey]) {
    return
  }

  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where' : 'which'
  const isInstalled = await execAsync(`${whichCmd} ${name}`, {
    env: process.env,
  }).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )

  if (isInstalled) {
    return
  }

  note(`${name} is required but not found in your PATH.`, `${name} Not Found`)

  // In non-TTY (cloud sandbox, CI), auto-install without prompting.
  // In interactive mode, ask the user first.
  if (canUseInteractivePrompts()) {
    const shouldInstall = await confirm({
      message: `Would you like to install ${name} right now?`,
    })
    if (isCancel(shouldInstall) || !shouldInstall) {
      cancel(`${name} is required to run this bot`)
      process.exit(EXIT_NO_RESTART)
    }
  } else {
    cliLogger.log(`Auto-installing ${name} (non-interactive mode)...`)
  }

  cliLogger.log(`Installing ${name}...`)

  try {
    // Use explicit shell invocation to avoid Node shell-mode quirks on Windows.
    // PowerShell needs -NoProfile and -ExecutionPolicy Bypass for install scripts.
    // Unix uses login shell (-l) so install scripts can update PATH in shell config.
    const cmd = isWindows ? 'powershell.exe' : '/bin/bash'
    const args = isWindows
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', installWindows]
      : ['-lc', installUnix]
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'inherit', env: process.env })
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`${name} install exited with code ${code}`))
        }
      })
      child.on('error', reject)
    })
    cliLogger.log(`${name} installed successfully!`)
  } catch (error) {
    cliLogger.log(`Failed to install ${name}`)
    cliLogger.error(
      'Installation error:',
      error instanceof Error ? error.stack : String(error),
    )
    process.exit(EXIT_NO_RESTART)
  }

  // After install, re-check PATH first (install script may have added it)
  const foundInPath = await execAsync(`${whichCmd} ${name}`, {
    env: process.env,
  }).then(
    (result) => {
      const resolved = selectResolvedCommand({
        output: result.stdout,
        isWindows,
      })
      return resolved || ''
    },
    () => {
      return ''
    },
  )
  if (foundInPath) {
    process.env[envPathKey] = foundInPath
    return
  }

  // Fall back to probing common install locations
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const accessFlag = isWindows ? fs.constants.F_OK : fs.constants.X_OK
  const possiblePaths = (isWindows ? possiblePathsWindows : possiblePathsUnix)
    .filter((p) => {
      return !p.startsWith('~') || home
    })
    .map((p) => {
      return p.replace('~', home)
    })

  const installedPath = possiblePaths.find((p) => {
    try {
      fs.accessSync(p, accessFlag)
      return true
    } catch {
      return false
    }
  })

  if (!installedPath) {
    note(
      `${name} was installed but may not be available in this session.\n` +
        'Please restart your terminal and run this command again.',
      'Restart Required',
    )
    process.exit(EXIT_NO_RESTART)
  }

  process.env[envPathKey] = installedPath
}

// Run opencode upgrade in the background so the user always has the latest version.

// Spawn caffeinate on macOS to prevent system sleep while bot is running.
// Uses -s to also prevent sleep on lid close (AC power only, not battery).
// Uses -w to watch the parent PID so caffeinate self-terminates if roadie
// exits for any reason (SIGTERM, crash, process.exit, supervisor stop).
export function startCaffeinate() {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    const proc = spawn('caffeinate', ['-s', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: false,
    })
    proc.unref()
    proc.on('error', (err) => {
      cliLogger.warn('Failed to start caffeinate:', err.message)
    })
    cliLogger.log('Started caffeinate to prevent system sleep')
  } catch (err) {
    cliLogger.warn(
      'Failed to spawn caffeinate:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// Result of credential resolution. `credentialSource` indicates how the
// credentials were obtained so downstream code can decide whether to show
// channel setup prompts (wizard) or skip them (env/saved/headless).
type CredentialResult = {
  appId: string
  token: string
  credentialSource: 'env' | 'saved' | 'wizard'
}

type CliOptions = {
  restartOnboarding?: boolean
  addChannels?: boolean
  dataDir?: string
  useWorktrees?: boolean
}


export async function collectRoadieChannels({
  guilds,
}: {
  guilds: Guild[]
}): Promise<{ guild: Guild; channels: ChannelWithTags[] }[]> {
  const guildResults = await Promise.all(
    guilds.map(async (guild) => {
      const channels = await getChannelsWithDescriptions(guild)
      const roadieChans = channels.filter((ch) => ch.roadieDirectory)

      return { guild, channels: roadieChans }
    }),
  )

  return guildResults.filter((result) => {
    return result.channels.length > 0
  })
}

/**
 * Store channel-directory mappings in the database.
 * Called after Discord login to persist channel configurations.
 */
export async function storeChannelDirectories({
  roadieChannels,
}: {
  roadieChannels: { guild: Guild; channels: ChannelWithTags[] }[]
}): Promise<void> {
  for (const { guild, channels } of roadieChannels) {
    for (const channel of channels) {
      if (channel.roadieDirectory) {
        await setChannelDirectory({
          channelId: channel.id,
          directory: channel.roadieDirectory,
          channelType: 'text',
          skipIfExists: true,
        })
      }
    }
  }
}

/**
 * Show the ready message with channel links.
 * Called at the end of startup to display available channels.
 */
export function showReadyMessage({
  roadieChannels,
  createdChannels,
}: {
  roadieChannels: { guild: Guild; channels: ChannelWithTags[] }[]
  createdChannels: { name: string; id: string; guildId: string }[]
}): void {
  const allChannels: {
    name: string
    id: string
    guildId: string
    directory?: string
  }[] = []

  allChannels.push(...createdChannels)

  roadieChannels.forEach(({ guild, channels }) => {
    channels.forEach((ch) => {
      allChannels.push({
        name: ch.name,
        id: ch.id,
        guildId: guild.id,
        directory: ch.roadieDirectory,
      })
    })
  })

  if (allChannels.length > 0) {
    const channelLinks = allChannels
      .map(
        (ch) =>
          `• #${ch.name}: https://discord.com/channels/${ch.guildId}/${ch.id}`,
      )
      .join('\n')

    note(
      `Your roadie channels are ready! Click any link below to open in Discord:\n\n${channelLinks}\n\nSend a message in any channel to start using OpenCode!`,
      '🚀 Ready to Use',
    )
  }

  note(
    'Leave this process running to keep the bot active.\n\nIf you close this process or restart your machine, run `npx roadie` again to start the bot.',
    '⚠️  Keep Running',
  )
}

/**
 * Create default channels in locally configured guilds.
 * Idempotent: skips guilds that already have the channel.
 * Extracted so both the interactive and headless startup paths share the same logic.
 */
export async function ensureDefaultChannelsWithWelcome({
  guilds,
  discordClient,
  appId,
}: {
  guilds: Guild[]
  discordClient: import('discord.js').Client
  appId: string
}): Promise<{ name: string; id: string; guildId: string }[]> {
  if (process.env['ROADIE_NO_DEFAULT_CHANNEL'] === '1') return []

  const localMappings = await findChannelsByDirectory({})
  const created: { name: string; id: string; guildId: string }[] = []
  for (const guild of guilds) {
    try {
      // Match live channel IDs: older local mappings have no guild_id.
      const channels = await guild.channels.fetch()
      if (!localMappings.some((row) => channels.has(row.channel_id))) continue
      const result = await createDefaultRoadieChannel({
        guild,
        botName: discordClient.user?.username,
        appId,
      })
      if (result) {
        created.push({
          name: result.channelName,
          id: result.textChannelId,
          guildId: guild.id,
        })

        // Send welcome message to the newly created default channel.
        // Mention the server owner so they get a notification.
        const mentionUserId = guild.ownerId
        await sendWelcomeMessage({
          channel: result.textChannel,
          mentionUserId,
        })
      }
    } catch (error) {
      cliLogger.warn(
        `Failed to create default roadie channel in ${guild.name}: ${error instanceof Error ? error.stack : String(error)}`,
      )
    }
  }
  return created
}

/**
 * Background initialization for quick start mode.
 * Starts OpenCode server and registers slash commands without blocking bot startup.
 */
export async function backgroundInit({
  currentDir,
  token,
  appId,
  guildIds,
}: {
  currentDir: string
  token: string
  appId: string
  guildIds: string[]
}): Promise<void> {
  try {
    const opencodeResult = await initializeOpencodeForDirectory(currentDir)
    if (opencodeResult instanceof Error) {
      cliLogger.warn('Background OpenCode init failed:', opencodeResult.message)
      // Still try to register basic commands without user commands/agents
      await registerCommands({
        token,
        appId,
        guildIds,
        userCommands: [],
        agents: [],
      })
      return
    }

    const getClient = opencodeResult

    const [userCommands, agents] = await Promise.all([
      getClient()
        .command.list({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load user commands during background init:',
            error instanceof Error ? error.stack : String(error),
          )
          return []
        }),
      getClient()
        .app.agents({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load agents during background init:',
            error instanceof Error ? error.stack : String(error),
          )
          return []
        }),
    ])

    await registerCommands({ token, appId, guildIds, userCommands, agents })
    cliLogger.log('Slash commands registered!')
  } catch (error) {
    cliLogger.error(
      'Background init failed:',
      error instanceof Error ? error.stack : String(error),
    )
    void notifyError(error, 'Background init failed')
  }
}

// Resolve bot credentials from (in priority order):
// 1. ROADIE_BOT_TOKEN env var (headless/CI deployments)
// 2. Saved credentials in the database
// 3. Interactive wizard (bot token entry)
//
// credentialSource tells the caller how creds were obtained:
//   'env'    — ROADIE_BOT_TOKEN env var
//   'saved'  — reused from database
//   'wizard' — user just completed onboarding
export async function resolveCredentials({
  forceRestartOnboarding,
}: {
  forceRestartOnboarding: boolean
}): Promise<CredentialResult> {
  const envToken = process.env.ROADIE_BOT_TOKEN
  const existingBot = await getBotTokenWithMode()

  // 1. Env var takes precedence (headless deployments)
  if (envToken && !forceRestartOnboarding) {
    const derivedAppId = appIdFromToken(envToken)
    if (!derivedAppId) {
      cliLogger.error(
        'Could not derive Application ID from ROADIE_BOT_TOKEN. The token appears malformed.',
      )
      process.exit(EXIT_NO_RESTART)
    }
    await setBotToken(derivedAppId, envToken)
    cliLogger.log(`Using ROADIE_BOT_TOKEN env var (App ID: ${derivedAppId})`)
    return { appId: derivedAppId, token: envToken, credentialSource: 'env' }
  }

  // 2. Saved credentials in the database
  // Reuse saved creds unless --restart-onboarding forces re-setup.
  // Rows saved by Kimaki's removed gateway mode hold shared hosted-bot
  // credentials that no longer work here, so they are never reused.
  if (existingBot && existingBot.mode === 'gateway' && !forceRestartOnboarding) {
    cliLogger.error(
      'Saved credentials use the hosted gateway bot, which Roadie does not support. Run with --restart-onboarding to set up your own Discord bot, or set ROADIE_BOT_TOKEN.',
    )
    process.exit(EXIT_NO_RESTART)
  }
  if (existingBot && !forceRestartOnboarding) {
    note(
      `Using saved bot credentials:\nApp ID: ${existingBot.appId}\n\nTo use different credentials, run with --restart-onboarding`,
      'Existing Bot Found',
    )
    note(
      `Bot install URL (in case you need to add it to another server):\n${generateBotInstallUrl({ clientId: existingBot.appId })}`,
      'Install URL',
    )
    return { appId: existingBot.appId, token: existingBot.token, credentialSource: 'saved' }
  }

  // 3. Interactive setup wizard (first-time users, --restart-onboarding).
  if (!canUseInteractivePrompts()) {
    exitNonInteractiveSetup()
  }

  if (forceRestartOnboarding && existingBot) {
    note('Ignoring saved credentials due to --restart-onboarding flag', 'Restart Onboarding')
  }

  // ── Self-hosted mode flow (existing wizard) ──
  note(
    '1. Go to https://discord.com/developers/applications\n' +
      '2. Click "New Application"\n' +
      '3. Give your application a name',
    'Step 1: Create Discord Application',
  )

  note(
    '1. Go to the "Bot" section in the left sidebar\n' +
      '2. Scroll down to "Privileged Gateway Intents"\n' +
      '3. Enable MESSAGE CONTENT INTENT by toggling it ON\n' +
      '4. Optional: enable SERVER MEMBERS INTENT only if you want name lookup in `roadie user list` and `roadie send --user Tommy`\n' +
      '5. Click "Save Changes" at the bottom',
    'Step 2: Enable Message Content Intent',
  )

  const intentsConfirmed = await text({
    message: 'Press Enter after enabling Message Content Intent:',
    placeholder: 'Enter',
  })
  if (isCancel(intentsConfirmed)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  note(
    '1. Still in the "Bot" section\n' +
      '2. Click "Reset Token" to generate a new bot token (in case of errors try again)\n' +
      "3. Copy the token (you won't be able to see it again!)",
    'Step 3: Get Bot Token',
  )
  const tokenInput = await password({
    message:
      'Enter your Discord Bot Token (from "Bot" section - click "Reset Token" if needed):',
    validate(value) {
      const cleaned = stripBracketedPaste(value)
      if (!cleaned) {
        return 'Bot token is required'
      }
      if (cleaned.length < 50) {
        return 'Invalid token format (too short)'
      }
    },
  })
  if (isCancel(tokenInput)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  const wizardToken = stripBracketedPaste(tokenInput)
  const derivedAppId = appIdFromToken(wizardToken)
  if (!derivedAppId) {
    cliLogger.error(
      'Could not derive Application ID from the bot token. The token appears malformed.',
    )
    process.exit(EXIT_NO_RESTART)
  }

  await setBotToken(derivedAppId, wizardToken)

  note(
    `Bot install URL:\n${generateBotInstallUrl({ clientId: derivedAppId })}\n\nYou MUST install the bot in your Discord server before continuing.`,
    'Step 4: Install Bot to Server',
  )
  const installed = await text({
    message: 'Press Enter AFTER you have installed the bot in your server:',
    placeholder: 'Enter',
  })
  if (isCancel(installed)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  return { appId: derivedAppId, token: wizardToken, credentialSource: 'wizard' }
}

export async function run({
  restartOnboarding,
  addChannels,
  useWorktrees,
}: CliOptions) {
  startCaffeinate()

  const forceRestartOnboarding = Boolean(restartOnboarding)

  // Step 0: Ensure opencode and bun are installed
  await Promise.all([
    ensureCommandAvailable({
      name: 'opencode',
      envPathKey: 'OPENCODE_PATH',
      installUnix: 'curl -fsSL https://opencode.ai/install | bash',
      installWindows: 'irm https://opencode.ai/install.ps1 | iex',
      possiblePathsUnix: [
        '~/.local/bin/opencode',
        '~/.opencode/bin/opencode',
        '/usr/local/bin/opencode',
        '/opt/opencode/bin/opencode',
      ],
      possiblePathsWindows: [
        '~\\.local\\bin\\opencode.exe',
        '~\\AppData\\Local\\opencode\\opencode.exe',
        '~\\.opencode\\bin\\opencode.exe',
      ],
    }),
    ensureCommandAvailable({
      name: 'bun',
      envPathKey: 'BUN_PATH',
      installUnix: 'curl -fsSL https://bun.sh/install | bash',
      installWindows: 'irm bun.sh/install.ps1 | iex',
      possiblePathsUnix: ['~/.bun/bin/bun', '/usr/local/bin/bun'],
      possiblePathsWindows: ['~\\.bun\\bin\\bun.exe'],
    }),
  ])

  const opencodeVersionCheck = await assertCompatibleOpencodeVersion()
  if (opencodeVersionCheck instanceof Error) {
    cliLogger.error(opencodeVersionCheck.message)
    process.exit(EXIT_NO_RESTART)
  }


  if (store.getState().autoUpgradeEnabled) {
    void backgroundUpgradeKimaki()
  }

  // Start in-process Hrana server before database init. Required for the bot
  // process because it serves as both the DB server and the single-instance
  // lock (binds the fixed lock port). Without it, IPC and lock enforcement
  // don't work. CLI subcommands skip the server and use file: directly.
  const hranaResult = await startHranaServer({
    dbPath: path.join(getDataDir(), 'discord-sessions.db'),
  })
  if (hranaResult instanceof Error) {
    cliLogger.error('Failed to start hrana server:', hranaResult.message)
    process.exit(EXIT_NO_RESTART)
  }
  // We own the lock port from here on. Stop signals must release it in every
  // startup phase (Discord login, channel reconcile), not only after ready.
  registerBotLifecycleHandlers()

  // Initialize database (connects to hrana server via HTTP)
  await initDatabase()

  const { appId, token, credentialSource } = await resolveCredentials({
    forceRestartOnboarding,
  })


  const gatewayToken = await ensureServiceAuthToken({
    appId,
  })
  // Always set service auth token so local and internet control-plane paths
  // share one auth model (Hrana and future service endpoints).
  store.setState({ gatewayToken })

  // Start OpenCode server as early as possible — non-blocking.
  // All dependencies are met (dataDir, lockPort, gatewayToken, hranaUrl set).
  // Runs in parallel with last_used_at update, skipChannelSetup check, and
  // Discord Gateway login so cold start is not blocked by OpenCode spawn.
  const currentDir = process.cwd()
  cliLogger.log('Starting OpenCode server...')
  const opencodePromise = initializeOpencodeForDirectory(currentDir).then(
    (result) => {
      if (result instanceof Error) {
        throw new Error(result.message)
      }
      cliLogger.log('OpenCode server ready!')
      return result
    },
  )
  // Prevent unhandled rejection if OpenCode fails before backgroundInit
  // or the channel setup path awaits it. Errors are handled by the
  // respective consumers (backgroundInit catches, channel setup re-throws).
  opencodePromise.catch(() => {})

  // Mark this bot as the most recently used so subcommands in separate
  // processes (send, upload-to-discord, project list) pick the correct bot.
  // getBotTokenWithMode() orders by last_used_at DESC as cross-process
  // source of truth.
  await (await getDb()).update(dbSchema.bot_tokens)
    .set({ last_used_at: new Date() })
    .where(orm.eq(dbSchema.bot_tokens.app_id, appId))

  // skipChannelSetup: when true, skip interactive project/channel selection
  // and go straight to bot startup. Channel sync happens in the background.
  //
  // Skip when: creds came from env/saved (not first-time wizard), OR
  // user didn't pass --add-channels/--restart-onboarding.
  // Force channel setup when: first-time quick-start with no channels configured
  // and TTY is available, or user explicitly passed --add-channels.
  const hasConfiguredTextChannels = Boolean(
    await (await getDb()).query.channel_directories.findFirst({
      where: { channel_type: 'text' },
      columns: { channel_id: true },
    }),
  )
  const skipChannelSetup = (() => {
    // Wizard source always shows channel setup (user just completed onboarding)
    if (credentialSource === 'wizard') {
      return false
    }
    // Env/saved source: skip unless user explicitly asked for channels
    if (forceRestartOnboarding || Boolean(addChannels)) {
      return false
    }
    // First-time quick start with no channels: force setup if TTY is available
    if (!hasConfiguredTextChannels && canUseInteractivePrompts()) {
      return false
    }
    return true
  })()

  cliLogger.log(`Connecting to ${getDiscordRestApiUrl()}...`)
  const discordClient = await createDiscordClient()

  const guilds: Guild[] = []
  const roadieChannels: { guild: Guild; channels: ChannelWithTags[] }[] = []
  const createdChannels: { name: string; id: string; guildId: string }[] = []

  try {
    await new Promise((resolve, reject) => {
      discordClient.once(Events.ClientReady, async (c) => {
        // Guild discovery comes from the Gateway WebSocket READY payload, not
        // from a separate REST fetch. discord.js consumes READY and hydrates
        // client.guilds.cache from d.guilds.
        // Example payload fragment received over WS:
        // {
        //   "op": 0,
        //   "t": "READY",
        //   "d": {
        //     "guilds": [
        //       { "id": "123456789012345678", "unavailable": false }
        //     ]
        //   }
        // }
        guilds.push(...Array.from(c.guilds.cache.values()))

        if (skipChannelSetup) {
          resolve(null)
          return
        }

        // Process guild metadata when setup flow needs channel prompts.
        const guildResults = await collectRoadieChannels({ guilds })

        // Collect results
        for (const result of guildResults) {
          roadieChannels.push(result)
        }

        resolve(null)
      })

      discordClient.once(Events.Error, reject)

      discordClient.login(token).catch(reject)
    })

    cliLogger.log('Connected to Discord!')
    // Start IPC polling now that Discord client is ready.
    // Register cleanup on process exit since the shutdown handler lives in discord-bot.ts.
    await startIpcPolling({ discordClient })
    process.on('exit', stopIpcPolling)
  } catch (error) {
    cliLogger.log('Failed to connect to Discord', discordClient.ws.gateway)
    cliLogger.error(
      'Error: ' + (error instanceof Error ? error.stack : String(error)),
    )
    // Transient network errors (DNS down, gateway unreachable, connect
    // timeout) should allow the bin.ts wrapper to restart us after a delay.
    // EXIT_TEMPFAIL skips the crash-loop detector so a long outage cannot
    // permanently stop the bot. Only truly fatal errors (bad token, invalid
    // intent, etc.) should use EXIT_NO_RESTART.
    if (isTransientNetworkError(error)) {
      cliLogger.error('Transient network error, exiting for wrapper restart...')
      process.exit(EXIT_TEMPFAIL)
    }
    process.exit(EXIT_NO_RESTART)
  }
  // Stop signal during Discord login: shutdown owns the process now.
  if (global.shuttingDown) {
    return
  }
  await setBotToken(appId, token)

  if (skipChannelSetup) {
    // Start bot immediately — channel sync happens in the background.
    cliLogger.log('Starting Discord bot...')
    await startDiscordBot({ token, appId, discordClient, useWorktrees })
    if (global.shuttingDown) {
      return
    }
    cliLogger.log('Discord bot is running!')

    // Background channel sync + role reconciliation + default channel creation.
    // Never blocks ready state.
    void (async () => {
      try {
        const backgroundChannels = await collectRoadieChannels({ guilds })
        await storeChannelDirectories({ roadieChannels: backgroundChannels })
        cliLogger.log(
          `Background channel sync completed for ${backgroundChannels.length} guild(s)`,
        )
      } catch (error) {
        cliLogger.warn(
          'Background channel sync failed:',
          error instanceof Error ? error.stack : String(error),
        )
      }

      // Create default channels only in locally configured guilds.
      // Runs after channel sync so existing channels are detected correctly.
      try {
        await ensureDefaultChannelsWithWelcome({
          guilds,
          discordClient,
          appId,
        })
      } catch (error) {
        cliLogger.warn(
          'Background default channel creation failed:',
          error instanceof Error ? error.stack : String(error),
        )
      }
    })()

    // Background: OpenCode init + slash command registration (non-blocking)
    void backgroundInit({
      currentDir,
      token,
      appId,
      guildIds: guilds.map((guild) => {
        return guild.id
      }),
    })
  } else {
    // ── Channel setup flow ──
    // Store channel-directory mappings discovered during Discord login.
    await storeChannelDirectories({ roadieChannels })

    if (!hasConfiguredTextChannels) {
      note(
        'No Roadie project channels are configured yet. Opening project/channel setup.',
        'Channel Setup',
      )
    }

    if (roadieChannels.length > 0) {
      const channelList = roadieChannels
        .flatMap(({ guild, channels }) =>
          channels.map((ch) => {
            return `#${ch.name} in ${guild.name}: ${ch.roadieDirectory}`
          }),
        )
        .join('\n')

      note(channelList, 'Existing Roadie Channels')
    }

    // Wait for OpenCode, fetch projects, show prompts, create channels if needed
    cliLogger.log('Waiting for OpenCode server...')
    const getClient = await opencodePromise

    cliLogger.log('Fetching OpenCode data...')

    // Fetch projects, commands, and agents in parallel
    const [projects, allUserCommands, allAgents] = await Promise.all([
      getClient()
        .project.list()
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.log('Failed to fetch projects')
          cliLogger.error(
            'Error:',
            error instanceof Error ? error.stack : String(error),
          )
          void discordClient.destroy()
          process.exit(EXIT_NO_RESTART)
        }),
      getClient()
        .command.list({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load user commands during setup:',
            error instanceof Error ? error.stack : String(error),
          )
          return []
        }),
      getClient()
        .app.agents({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load agents during setup:',
            error instanceof Error ? error.stack : String(error),
          )
          return []
        }),
    ])

    cliLogger.log(`Found ${projects.length} OpenCode project(s)`)

    const existingDirs = roadieChannels.flatMap(({ channels }) =>
      channels
        .filter((ch) => ch.roadieDirectory)
        .map((ch) => ch.roadieDirectory)
        .filter(Boolean),
    )

    const availableProjects = deduplicateByKey(
      projects.filter((project) => {
        if (existingDirs.includes(project.worktree)) {
          return false
        }
        if (path.basename(project.worktree).startsWith('opencode-test-')) {
          return false
        }
        return true
      }),
      (x) => x.worktree,
    )

    if (availableProjects.length === 0) {
      note(
        'All OpenCode projects already have Discord channels',
        'No New Projects',
      )
    }

    if (availableProjects.length > 0) {
      if (!canUseInteractivePrompts()) {
        exitNonInteractiveSetup()
      }

      const selectedProjects = await multiselect({
        message: 'Select projects to create Discord channels for:',
        options: availableProjects.map((project) => ({
          value: project.id,
          label: `${path.basename(project.worktree)} (${abbreviatePath(project.worktree)})`,
        })),
        required: false,
      })

      if (!isCancel(selectedProjects) && selectedProjects.length > 0) {
        let targetGuild: Guild
        if (guilds.length === 0) {
          cliLogger.error(
            'No Discord servers found! The bot must be installed in at least one server.',
          )
          process.exit(EXIT_NO_RESTART)
        }

        if (guilds.length === 1) {
          targetGuild = guilds[0]!
          note(`Using server: ${targetGuild.name}`, 'Server Selected')
        } else {
          const guildSelection = await multiselect({
            message: 'Select a Discord server to create channels in:',
            options: guilds.map((guild) => ({
              value: guild.id,
              label: `${guild.name} (${guild.memberCount} members)`,
            })),
            required: true,
            maxItems: 1,
          })

          if (isCancel(guildSelection)) {
            cancel('Setup cancelled')
            process.exit(0)
          }

          targetGuild = guilds.find((g) => g.id === guildSelection[0])!
        }

        cliLogger.log('Creating Discord channels...')

        for (const projectId of selectedProjects) {
          const project = projects.find((p) => p.id === projectId)
          if (!project) continue

          try {
            const { textChannelId, channelName } = await createProjectChannels({
              guild: targetGuild,
              projectDirectory: project.worktree,
              botName: discordClient.user?.username,
            })

            createdChannels.push({
              name: channelName,
              id: textChannelId,
              guildId: targetGuild.id,
            })
          } catch (error) {
            cliLogger.error(
              `Failed to create channels for ${path.basename(project.worktree)}:`,
              error,
            )
          }
        }

        cliLogger.log(`Created ${createdChannels.length} channel(s)`)

        if (createdChannels.length > 0) {
          note(
            createdChannels.map((ch) => `#${ch.name}`).join('\n'),
            'Created Channels',
          )
        }
      }
    }

    // Create default roadie channel for general-purpose tasks.
    // Only locally configured guilds are eligible.
    const defaultChannelResults = await ensureDefaultChannelsWithWelcome({
      guilds,
      discordClient,
      appId,
    })
    createdChannels.push(...defaultChannelResults)

    // Log available user commands
    const registrableCommands = allUserCommands.filter(
      (cmd) => !SKIP_USER_COMMANDS.includes(cmd.name),
    )

    if (registrableCommands.length > 0) {
      note(
        `Found ${registrableCommands.length} user-defined command(s)`,
        'OpenCode Commands/Skills',
      )
    }

    cliLogger.log('Registering slash commands asynchronously...')
    void registerCommands({
      token,
      appId,
      guildIds: guilds.map((guild) => {
        return guild.id
      }),
      userCommands: allUserCommands,
      agents: allAgents,
    })
      .then(() => {
        cliLogger.log('Slash commands registered!')
      })
      .catch((error) => {
        cliLogger.error(
          'Failed to register slash commands:',
          error instanceof Error ? error.stack : String(error),
        )
      })

    // Start bot after channel setup is complete so it doesn't handle
    // messages/interactions while the user is still going through prompts.
    cliLogger.log('Starting Discord bot...')
    await startDiscordBot({ token, appId, discordClient, useWorktrees })
    cliLogger.log('Discord bot is running!')
  }

  // ── Ready ──
  if (!canUseInteractivePrompts()) {
    emitJsonEvent({
      type: 'ready',
      app_id: appId,
      guild_ids: guilds.map((g) => { return g.id }),
    })
  } else {
    showReadyMessage({ roadieChannels, createdChannels })
    outro('✨ Bot ready! Listening for messages...')
  }
}
