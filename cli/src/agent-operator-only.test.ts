// Agent shells route allowlisted commands through operator approval; other
// operator-only commands still refuse. Exercised through the real CLI with an
// agent-mode environment — the same env the shell.env hook produces — and
// once without it, proving operator mode is unchanged.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execAsync } from './exec-async.js'
import { setDataDir } from './config.js'
import { mintAgentToken, AGENT_TOKEN_ENV, AGENT_TOKEN_SECRET_ENV } from './agent-token.js'
import { AGENT_OPERATOR_ONLY_MESSAGE } from './agent-remote.js'
import { chooseLockPort } from './test-utils.js'

const cliRoot = path.resolve(import.meta.dirname, '..')
const cliEntry = path.join(cliRoot, 'src', 'cli.ts')
const tsxBinary = path.join(cliRoot, 'node_modules', '.bin', 'tsx')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-agent-operator-only-'))
const secret = 'operator-only-test-secret'
const token = mintAgentToken({ secret, sessionId: 'ses_operator_only' })

const SCRUBBED_ENV_NAMES = [
  'ROADIE_DB_URL',
  'ROADIE_DB_AUTH_TOKEN',
  'ROADIE_DB_AUTH_TOKEN_FILE',
  'ROADIE_SERVICE_TOKEN',
  'ROADIE_SERVICE_TOKEN_FILE',
] as const

function childEnv(mode: 'agent' | 'operator'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of SCRUBBED_ENV_NAMES) delete env[name]
  env.ROADIE_DATA_DIR = dataDir
  // Logs reach stderr so assertions see the CLI's own messages.
  env.ROADIE_TEST_LOGS = '1'
  // tsx creates its IPC pipe under TMPDIR; the checkouts here can sit inside
  // deeply nested paths that overflow the unix socket path limit.
  env.TMPDIR = '/tmp'
  if (mode === 'agent') {
    env[AGENT_TOKEN_ENV] = token
    env[AGENT_TOKEN_SECRET_ENV] = ''
    env.ROADIE_OPENCODE_PROCESS = '1'
    env.ROADIE_LOCK_PORT = String(chooseLockPort({ key: 'agent-operator-only-test' }))
  } else {
    delete env[AGENT_TOKEN_ENV]
    delete env.ROADIE_OPENCODE_PROCESS
  }
  return env
}

async function runCli(
  args: string[],
  mode: 'agent' | 'operator',
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      { command: tsxBinary, args: [cliEntry, ...args] },
      { env: childEnv(mode), cwd: cliRoot, timeout: 30_000 },
    )
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error)) throw error
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
    }
  }
}

beforeAll(() => {
  // Keep the secret file lookup inside the temp data dir so the agent-mode
  // detection sees no database credential, exactly like an isolated shell.
  setDataDir(dataDir)
})

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('operator-only commands refuse in agent mode', () => {
  const agentOnlyCommands: string[][] = [
    ['credentials', 'client', 'add', 'example'],
    ['bot', 'token'],
    ['bot', 'status', 'set', 'hello'],
    ['bot', 'status', 'clear'],
    ['discord-install-url'],
    ['session', 'export-events-jsonl', '--session', 'ses_x', '--out', './tmp/ses_x.jsonl'],
  ]

  test('each operator-only command exits non-zero with the refusal message', async () => {
    const results = await Promise.all(
      agentOnlyCommands.map((args) => runCli(args, 'agent')),
    )
    for (const [index, args] of agentOnlyCommands.entries()) {
      const result = results[index]
      if (!result) throw new Error(`no result for ${args.join(' ')}`)
      expect(`${args.join(' ')}: exit ${result.code}`).toBe(`${args.join(' ')}: exit 64`)
      expect(result.stderr).toContain(AGENT_OPERATOR_ONLY_MESSAGE)
    }
  }, 60_000)

  test('credentials list still works the same for the operator', async () => {
    const { code, stderr } = await runCli(['credentials', 'list'], 'operator')
    expect(code).toBe(0)
    expect(stderr).toContain('Pool shared has no accounts')
  }, 30_000)

  test('credentials list sends exact argv and relays streamed output and exit code', async () => {
    const received: unknown[] = []
    const server = http.createServer(async (req, res) => {
      expect(req.url).toBe('/roadie/agent/operator-requests')
      expect(req.method).toBe('POST')
      expect(req.headers.authorization).toBe(`Bearer ${token}`)
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      received.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ stream: 'stdout', data: 'operator output\n' })}\n`)
      res.write(`${JSON.stringify({ stream: 'stderr', data: 'operator warning\n' })}\n`)
      res.end(`${JSON.stringify({ exit: 7 })}\n`)
    })
    const port = chooseLockPort({ key: 'agent-operator-only-test' })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    try {
      const result = await runCli(['credentials', 'list'], 'agent')
      expect(received).toEqual([{ argv: ['credentials', 'list'] }])
      expect(result.code).toBe(7)
      expect(result.stdout).toContain('operator output\n')
      expect(result.stderr).toContain('operator warning\n')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }, 30_000)
})
