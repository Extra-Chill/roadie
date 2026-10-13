// CLI subcommands must resolve the same agent backend provider the bot does.
// Only the bot command used to call resolveAgentBackendProvider(), so
// `roadie session ...` (and the agent-remote child, which execs cli.ts with a
// subcommand) kept the module-default OpenCode-only provider and could not see
// Pi sessions or plugin-provided backends. The shared bootstrap in
// cli-runner.ts, registered once as a goke middleware in cli.ts, closes that.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { execAsync } from '../exec-async.js'
import { resolveSubcommandAgentBackendProvider } from '../cli-runner.js'
import {
  clearResolvedDefaultProvider,
  getAgentBackendProvider,
  resolveAgentBackendProvider,
  setAgentBackendProvider,
} from '../agent-backend/registry.js'
import { addFilter, removeFilter } from '../hooks.js'
import type { AgentBackendProvider } from '../agent-backend/types.js'

const cliRoot = path.resolve(import.meta.dirname, '../..')
const cliEntry = path.join(cliRoot, 'src', 'cli.ts')
const tsxBinary = path.join(cliRoot, 'node_modules', '.bin', 'tsx')

const realArgv = [...process.argv]
const savedEnv: Array<[string, string | undefined]> = []
let restore: (() => void) | undefined

const PI_SESSION_ID = '3f9d6c2e8a4b4c1d9e2f5a6b7c8d9e0f'

function withEnv(name: string, value: string | undefined): void {
  savedEnv.push([name, process.env[name]])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** A `pi` stand-in whose --version satisfies the registry's 1.x check. */
function writePiVersionShim(dir: string): string {
  const shim = path.join(dir, 'fake-pi')
  fs.writeFileSync(shim, '#!/bin/sh\necho "1.2.3"\n', { mode: 0o755 })
  return shim
}

/** A Pi session file on disk makes the provider own the session id. */
function writePiSessionFile(sessionDir: string, sessionId: string): void {
  const header = {
    type: 'session',
    id: sessionId,
    cwd: '/tmp/pi-project',
    timestamp: '2026-01-01T00:00:00.000Z',
    title: 'Pi session',
  }
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, `project_${sessionId}.jsonl`), `${JSON.stringify(header)}\n`)}

function keepProvider(): void {
  const before = getAgentBackendProvider()
  restore = () => setAgentBackendProvider(before)()
}

afterEach(() => {
  restore?.()
  restore = undefined
  for (const [name, value] of savedEnv.reverse()) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.length = 0
  process.argv = realArgv
})

describe('subcommand agent backend bootstrap', () => {
  test('the default bot command invocation does not resolve (the bot action does it itself)', async () => {
    withEnv('ROADIE_PI_CHANNELS', undefined)
    withEnv('ROADIE_PLUGINS', undefined)
    const before = getAgentBackendProvider()
    process.argv = ['node', 'roadie', '--data-dir', '/tmp/roadie-somewhere']
    await resolveSubcommandAgentBackendProvider()
    // Identity, not just id: a skip must not re-resolve the provider.
    expect(getAgentBackendProvider()).toBe(before)
  })

  test('a subcommand resolves the same provider as the bot, and a Pi-owned session id routes to Pi', async () => {
    keepProvider()
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'subcommand-backend-'))
    // The legacy per-channel opt-in: ROADIE_BACKEND=opencode keeps ROADIE_PI_CHANNELS working.
    withEnv('ROADIE_BACKEND', 'opencode')
    withEnv('ROADIE_PI_CHANNELS', 'ch-pi')
    withEnv('ROADIE_PI_BIN', writePiVersionShim(tmp))
    withEnv('ROADIE_PI_SESSION_DIR', path.join(tmp, 'pi-sessions'))
    withEnv('ROADIE_PLUGINS', undefined)
    writePiSessionFile(path.join(tmp, 'pi-sessions'), PI_SESSION_ID)

    process.argv = ['node', 'roadie', 'session', 'list']
    await resolveSubcommandAgentBackendProvider()

    // The bot resolves to the same provider family: `opencode+pi`.
    expect(getAgentBackendProvider().id).toBe('opencode+pi')
    expect(resolveAgentBackendProvider().id).toBe('opencode+pi')

    // No OpenCode server is running here, so the routed backend composes Pi
    // over a null fallback: only a provider that knows the Pi channels can
    // serve this session id.
    const backend = getAgentBackendProvider().getBackend('/tmp/pi-project')
    expect(backend).not.toBeNull()
    const session = await backend!.sessions.get({ sessionId: PI_SESSION_ID })
    if (session instanceof Error || !session) throw new Error(`Pi did not serve ${PI_SESSION_ID}: ${session}`)
    expect(session.id).toBe(PI_SESSION_ID)
  })

  test('a plugin-provided backend reaches the subcommand through the agent_backend filter', async () => {
    keepProvider()
    withEnv('ROADIE_BACKEND', 'opencode')
    withEnv('ROADIE_PI_CHANNELS', undefined)
    withEnv('ROADIE_PLUGINS', undefined)
    // Whatever the registry default currently is (the Pi resolution above is
    // cached per process), the filter must be applied on top of it.
    const defaultId = resolveAgentBackendProvider().id
    const filter = (provider: AgentBackendProvider): AgentBackendProvider => ({
      ...provider,
      id: `${provider.id}+plugin`,
    })
    addFilter('agent_backend', filter)

    try {
      process.argv = ['node', 'roadie', 'session', 'read', 'ses_x']
      await resolveSubcommandAgentBackendProvider()
      expect(getAgentBackendProvider().id).toBe(`${defaultId}+plugin`)
    } finally {
      removeFilter('agent_backend', filter)
    }
  })

  test('a missing pi binary does not fail a subcommand that may never reach an agent', async () => {
    keepProvider()
    withEnv('ROADIE_PLUGINS', undefined)
    withEnv('ROADIE_PI_CHANNELS', undefined)
    withEnv('ROADIE_BACKEND', undefined)
    withEnv('ROADIE_PI_BIN', '/nonexistent/pi')
    clearResolvedDefaultProvider()
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    try {
      process.argv = ['node', 'roadie', 'task', 'list']
      await expect(resolveSubcommandAgentBackendProvider()).resolves.toBeUndefined()
    } finally {
      exit.mockRestore()
      clearResolvedDefaultProvider()
    }
  })

  test('a broken ROADIE_PLUGINS entry fails the subcommand instead of silently dropping the backend', async () => {
    keepProvider()
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'subcommand-broken-plugin-'))
    fs.writeFileSync(path.join(tmp, 'broken-plugin.mjs'), 'throw new Error("boom")\n')
    withEnv('ROADIE_PLUGINS', path.join(tmp, 'broken-plugin.mjs'))
    withEnv('ROADIE_PI_CHANNELS', undefined)

    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    try {
      process.argv = ['node', 'roadie', 'session', 'list']
      await expect(resolveSubcommandAgentBackendProvider()).rejects.toThrow('process.exit(64)')
    } finally {
      exit.mockRestore()
    }
  })

  test('the real CLI entry resolves the provider for a subcommand before its action runs', async () => {
    const tmp = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'subcommand-wiring-'))
    const marker = path.join(tmp, 'marker.log')
    // The filter body runs while resolveAgentBackendProvider() applies the
    // agent_backend chain: a marker line proves the subcommand process resolved
    // the provider through the plugin filter, exactly like the bot does.
    const plugin = path.join(tmp, 'marker-plugin.mjs')
    fs.writeFileSync(plugin, [
      "import fs from 'node:fs'",
      'export function register(roadie) {',
      "  roadie.addFilter('agent_backend', (provider) => {",
      "    fs.appendFileSync(process.env.MARKER_FILE, `${provider.id}\\n`)",
      '    return provider',
      '  })',
      '}',
      '',
    ].join('\n'))

    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.ROADIE_OPENCODE_PROCESS
    delete env.AGENT_TOKEN
    env.ROADIE_PLUGINS = plugin
    // The legacy OpenCode default, so the marker is deterministic without a pi shim.
    env.ROADIE_BACKEND = 'opencode'
    env.ROADIE_PI_CHANNELS = ''
    env.MARKER_FILE = marker
    env.ROADIE_TEST_LOGS = '1'
    env.TMPDIR = '/tmp'

    // The subcommand itself has no bot token and exits early; the bootstrap
    // has already run by then.
    await execAsync(
      { command: tsxBinary, args: [cliEntry, 'session', 'abort', 'ses_missing'] },
      { env, cwd: cliRoot, timeout: 60_000 },
    ).catch(() => undefined)

    expect(fs.readFileSync(marker, 'utf8')).toContain('opencode')
  })
})
