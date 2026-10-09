// Cross-user `roadie send`.
//
// A host process that cannot open the bot's data directory (another OS user,
// for example a web server) holds a send token (ROADIE_SERVICE_TOKEN[_FILE]).
// Its `roadie send` posts the parsed options to the running bot's local
// endpoint, POST /roadie/send. The bot validates them against an allowlist and
// runs `roadie send` itself, as the bot user, streaming the output back.
//
// The token grants exactly this: sending through the bot. It does not open
// the database, so it cannot read stored credentials. Prompting the agent is
// still powerful (the agent has tools), so share the token deliberately.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getDataDir, readRoadieSecret } from './config.js'

type OptionKind = 'string' | 'boolean' | 'strings'

/**
 * `roadie send` options a remote caller may set, keyed by the parsed option
 * name. Deliberately excluded: --pre-run (a shell command run directly, with no
 * agent involved), --app-id (the bot knows its own), --file (sent as content,
 * see `files`), and the removed --worktree.
 */
export const REMOTE_SEND_OPTIONS: Record<string, { flag: string; kind: OptionKind }> = {
  channel: { flag: '--channel', kind: 'string' },
  project: { flag: '--project', kind: 'string' },
  prompt: { flag: '--prompt', kind: 'string' },
  name: { flag: '--name', kind: 'string' },
  notifyOnly: { flag: '--notify-only', kind: 'boolean' },
  cwd: { flag: '--cwd', kind: 'string' },
  user: { flag: '--user', kind: 'string' },
  agent: { flag: '--agent', kind: 'string' },
  model: { flag: '--model', kind: 'string' },
  permission: { flag: '--permission', kind: 'strings' },
  injectionGuard: { flag: '--injection-guard', kind: 'strings' },
  sendAt: { flag: '--send-at', kind: 'string' },
  allowConcurrency: { flag: '--allow-concurrency', kind: 'boolean' },
  thread: { flag: '--thread', kind: 'string' },
  session: { flag: '--session', kind: 'string' },
  parentSession: { flag: '--parent-session', kind: 'string' },
  wait: { flag: '--wait', kind: 'boolean' },
}

export type RemoteSendFile = { name: string; contentBase64: string }
export type RemoteSendRequest = {
  options: Record<string, unknown>
  files?: RemoteSendFile[]
}

export const REMOTE_SEND_MAX_BODY_BYTES = 40 * 1024 * 1024

export class RemoteSendRequestError extends Error {}

function isString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0')
}

/**
 * Turn a request into `roadie send` arguments. Every value is passed as
 * `--flag=value`, so a value that starts with `-` can never become a flag.
 * Files are written into `fileDir` and passed with --file.
 */
export function buildRemoteSendArgs(request: unknown, fileDir: string): string[] {
  if (!request || typeof request !== 'object') throw new RemoteSendRequestError('Body must be a JSON object')
  const { options, files } = request as RemoteSendRequest
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RemoteSendRequestError('`options` must be an object')
  }
  const args = ['send']
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue
    const spec = REMOTE_SEND_OPTIONS[key]
    if (!spec) throw new RemoteSendRequestError(`Option not allowed over the send endpoint: ${key}`)
    if (spec.kind === 'boolean') {
      if (value !== true) throw new RemoteSendRequestError(`${key} must be a boolean`)
      args.push(spec.flag)
    } else if (spec.kind === 'string') {
      if (!isString(value)) throw new RemoteSendRequestError(`${key} must be a string`)
      args.push(`${spec.flag}=${value}`)
    } else {
      if (!Array.isArray(value) || !value.every(isString)) throw new RemoteSendRequestError(`${key} must be a list of strings`)
      for (const item of value) args.push(`${spec.flag}=${item}`)
    }
  }
  if (files !== undefined) {
    if (!Array.isArray(files)) throw new RemoteSendRequestError('`files` must be a list')
    files.forEach((file, index) => {
      if (!file || !isString(file.name) || typeof file.contentBase64 !== 'string') {
        throw new RemoteSendRequestError('Each file needs a name and contentBase64')
      }
      // Keep the caller's file name for display, never its path.
      const base = path.basename(file.name).replace(/[^\w.\- ]/g, '_') || 'file'
      const target = path.join(fileDir, `${index}-${base}`)
      fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'), { mode: 0o600 })
      args.push(`--file=${target}`)
    })
  }
  return args
}

/** Constant-time check of an `Authorization: Bearer <token>` header against the configured send token. */
export function isAuthorizedSend(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

export function getSendToken(): string | undefined {
  return readRoadieSecret('ROADIE_SERVICE_TOKEN')
}

/** One line of the NDJSON response stream. */
export type RemoteSendEvent =
  | { stream: 'stdout' | 'stderr'; data: string }
  | { keepalive: true }
  | { exit: number }

/** Read a request body, refusing anything past `limit` bytes. */
export async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | Error> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) return new Error(`Body exceeds ${limit} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Relay a run's NDJSON event stream to stdout/stderr, resolving with the
 * remote exit code. Shared by the cross-user send client and the agent
 * endpoint client, which speak the same protocol.
 */
export async function relayRemoteRun(
  body: unknown,
  {
    stdout = process.stdout,
    stderr = process.stderr,
  }: {
    stdout?: NodeJS.WritableStream
    stderr?: NodeJS.WritableStream
  } = {},
): Promise<number> {
  let exitCode = 1
  let buffered = ''
  const decoder = new TextDecoder()
  const handle = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line) as RemoteSendEvent
    if ('exit' in event) exitCode = event.exit
    else if ('stream' in event) (event.stream === 'stdout' ? stdout : stderr).write(event.data)
  }
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true })
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      handle(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
  handle(buffered)
  return exitCode
}

export type RemoteSendRunner = (args: string[], emit: (event: RemoteSendEvent) => void) => Promise<number>

/**
 * Roadie's CLI entry next to this module: dist/cli.js when built, src/cli.ts
 * when running from source.
 */
function roadieCliEntry(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url))
}

/**
 * Node flags for the CLI child. From source the child must load TypeScript,
 * and the parent's own loader is not always in process.execArgv: vitest
 * transforms modules in-process, so a child given only the parent's execArgv
 * cannot resolve src/*.ts and fails before running. Add the tsx loader
 * explicitly whenever the entry is TypeScript and none is present.
 */
export function roadieCliChildExecArgv({
  execArgv,
  entry,
}: {
  execArgv: readonly string[]
  entry: string
}): string[] {
  if (!entry.endsWith('.ts')) return [...execArgv]
  const hasTsLoader = execArgv.some((arg, index) => {
    const value = arg.startsWith('--import=') || arg.startsWith('--loader=') ? arg.split('=')[1] : (
      (arg === '--import' || arg === '--loader') ? execArgv[index + 1] : undefined
    )
    return typeof value === 'string' && value.includes('tsx')
  })
  if (hasTsLoader) return [...execArgv]
  // Resolve tsx from Roadie's own install, not the child's cwd (the bot runs
  // the child from the home directory, where tsx is not installed).
  const tsxLoader = (() => {
    try {
      return createRequire(import.meta.url).resolve('tsx')
    } catch {
      return 'tsx'
    }
  })()
  return [...execArgv, '--import', tsxLoader.startsWith('/') ? pathToFileURL(tsxLoader).href : tsxLoader]
}

/** Runs `roadie send` as a child of the bot process, i.e. as the bot user. */
export const spawnRoadieSend: RemoteSendRunner = (args, emit) => {
  const env = { ...process.env }
  // The child is a local client: it must open the database directly, not
  // send back to this endpoint, and must not act as the bot's wrapper child.
  delete env.ROADIE_SERVICE_TOKEN
  delete env.ROADIE_SERVICE_TOKEN_FILE
  delete env.__ROADIE_CHILD
  // The bot may have its data dir from --data-dir (set in memory, not in the
  // env). Pass it explicitly or the child would open ~/.roadie instead.
  env.ROADIE_DATA_DIR = getDataDir()
  // ROADIE_VITEST makes getDataDir() pick its own temp dir and ignore
  // ROADIE_DATA_DIR. The data dir above is explicit (already isolated when the
  // bot itself runs under tests), so the child must use it.
  delete env.ROADIE_VITEST
  return new Promise((resolve) => {
    const entry = roadieCliEntry()
    const child = spawn(process.execPath, [...roadieCliChildExecArgv({ execArgv: process.execArgv, entry }), entry, ...args], {
      env,
      cwd: os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => emit({ stream: 'stdout', data: chunk.toString('utf8') }))
    child.stderr.on('data', (chunk: Buffer) => emit({ stream: 'stderr', data: chunk.toString('utf8') }))
    child.on('error', (error) => {
      emit({ stream: 'stderr', data: `Failed to start roadie send: ${error.message}\n` })
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

let runner: RemoteSendRunner = spawnRoadieSend

/** Tests swap the runner; returns a function restoring the previous one. */
export function setRemoteSendRunner(next: RemoteSendRunner): () => void {
  const previous = runner
  runner = next
  return () => {
    runner = previous
  }
}

export function getRemoteSendRunner(): RemoteSendRunner {
  return runner
}

// ── Client side ──────────────────────────────────────────────────────

/**
 * Whether this `roadie send` should go through the running bot: it holds a
 * send token but cannot use the bot's database file directly.
 */
export function shouldSendRemotely({ dataDir, token = getSendToken() }: { dataDir: string; token?: string }): boolean {
  if (!token) return false
  try {
    fs.accessSync(path.join(dataDir, 'discord-sessions.db'), fs.constants.R_OK | fs.constants.W_OK)
    return false
  } catch {
    return true
  }
}

/** Options as the caller resolved them, made independent of the caller's cwd. */
export function remoteSendOptions(options: Record<string, unknown>, cwd = process.cwd()): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of Object.keys(REMOTE_SEND_OPTIONS)) {
    if (options[key] !== undefined) picked[key] = options[key]
  }
  for (const key of ['project', 'cwd']) {
    if (typeof picked[key] === 'string') picked[key] = path.resolve(cwd, picked[key] as string)
  }
  // The running application resolves its configured destination. The caller's
  // cwd is never a project/channel selector.
  return picked
}

/**
 * Post a send to the running bot and relay its output. Resolves with the
 * remote exit code. Agent tool shells post to the scoped agent endpoint
 * (`path: AGENT_SEND_PATH`) with their per-session token; cross-user hosts
 * keep the default /roadie/send path.
 */
export async function sendViaRunningBot({
  port,
  token,
  path: endpoint = '/roadie/send',
  options,
  filePaths = [],
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  port: number
  token: string
  path?: string
  options: Record<string, unknown>
  filePaths?: string[]
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
}): Promise<number> {
  const files = filePaths.map((file) => ({
    name: path.basename(file),
    contentBase64: fs.readFileSync(file).toString('base64'),
  }))
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ options, files }),
  }).catch((cause: unknown) => new Error(`Could not reach the running Roadie bot on port ${port}`, { cause }))
  if (response instanceof Error) {
    stderr.write(`${response.message}\n`)
    return 1
  }
  if (!response.ok || !response.body) {
    stderr.write(`Roadie bot rejected the send (${response.status}): ${await response.text()}\n`)
    return 1
  }
  return relayRemoteRun(response.body, { stdout, stderr })
}
