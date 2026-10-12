// OpenCode SDK imports stay behind the agent backend seam (#51, #163).
//
// Everything outside `agent-backend/` talks to the backend through Roadie's own
// types. The allowlist below is the complete inventory of files that still
// import `@opencode-ai/*`, each with the reason. It is what a second backend
// (Pi) has to replace or leave behind. Keep it exact: a new import fails, and
// so does an entry whose file no longer imports the SDK.

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const ALLOWED: Record<string, string> = {
  // Run inside the OpenCode process as OpenCode plugins.
  'bash-tool-schema-plugin.ts': 'OpenCode plugin',
  'cache-drift-plugin.ts': 'OpenCode plugin',
  'context-awareness-plugin.ts': 'OpenCode plugin',
  'credential-pools-plugin.ts': 'OpenCode plugin',
  'file-edit-log.ts': 'OpenCode plugin (file edit log writer)',
  'image-optimizer-plugin.ts': 'OpenCode plugin',
  'ipc-tools-plugin.ts': 'OpenCode plugin',
  'task-id-plugin.ts': 'OpenCode plugin',
  'title-request-plugin.ts': 'OpenCode plugin',
  'plugin-opencode-client.ts': 'SDK client used by the OpenCode plugins',

  // OpenCode server lifecycle and its native formats.
  'opencode.ts': 'starts and manages the OpenCode server',
  'hooks.ts': 'opencode_server_config filter carries the OpenCode server config',
  'session-handler/opencode-session-event-log.ts': 'writes the raw OpenCode event log',
  'session-handler/persisted-events.ts': 'translates legacy rows that stored raw OpenCode events',
  'cli-commands/session.ts': 'exports persisted events in the OpenCode event log format',
  'queue-advanced-e2e-setup.ts': 'e2e harness drives the OpenCode server directly',

  // Not on the seam yet.
  'discord-command-registration.ts': 'project slash commands come from OpenCode command.list',
  'commands/restart-opencode-server.ts': 'project slash commands come from OpenCode command.list',
}

const SRC = import.meta.dirname
const IMPORT = /from\s+['"]@opencode-ai\/|import\(\s*['"]@opencode-ai\//

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'agent-backend' && dir === SRC ? [] : sourceFiles(full)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [path.relative(SRC, full).split(path.sep).join('/')]
  })
}

const importers = sourceFiles(SRC).filter((file) => IMPORT.test(fs.readFileSync(path.join(SRC, file), 'utf8')))

test('no file outside agent-backend/ imports the OpenCode SDK unless allowlisted', () => {
  expect(importers.filter((file) => !(file in ALLOWED))).toEqual([])
})

test('every allowlisted file still imports the OpenCode SDK', () => {
  expect(Object.keys(ALLOWED).filter((file) => !importers.includes(file))).toEqual([])
})
