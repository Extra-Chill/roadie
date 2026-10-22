// `roadie credentials rotation set --hidden / --shown` end to end (#343):
// the real CLI against a real pool store, checking that the flag sets,
// preserves (neither flag passed, like --description) and clears the hidden
// record, and that `credentials list` marks hidden rotations. Routing is
// untouched: the rotation file keeps its entries the whole time.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execAsync } from '../exec-async.js'

const cliRoot = path.resolve(import.meta.dirname, '..', '..')
const cliEntry = path.join(cliRoot, 'src', 'cli.ts')
const tsxBinary = path.join(cliRoot, 'node_modules', '.bin', 'tsx')

let dataDir: string

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'rotation-hidden-cli-'))
})

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function childEnv(): NodeJS.ProcessEnv {
  // ROADIE_VITEST must go: getDataDir() ignores ROADIE_DATA_DIR under it, so
  // the child would write to a throwaway dir instead of the one we read back.
  // tsx also creates its IPC pipe under TMPDIR; the checkouts here can sit
  // inside deeply nested paths that overflow the unix socket path limit.
  const env: NodeJS.ProcessEnv = { ...process.env, ROADIE_DATA_DIR: dataDir, ROADIE_POOL_URL: '', TMPDIR: '/tmp' }
  delete env.ROADIE_VITEST
  // Logs reach stderr so assertions see the CLI's own messages.
  env.ROADIE_TEST_LOGS = '1'
  return env
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      { command: tsxBinary, args: [cliEntry, ...args] },
      { env: childEnv(), cwd: cliRoot, timeout: 30_000 },
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

function rotationFile(): Record<string, { entries: string[]; description?: string; hidden?: boolean }> {
  return JSON.parse(
    fs.readFileSync(path.join(dataDir, 'credentials', 'shared', 'rotation.json'), 'utf8'),
  ) as Record<string, { entries: string[]; description?: string; hidden?: boolean }>
}

describe('credentials rotation set --hidden / --shown', () => {
  test('sets, preserves and clears the hidden flag; list marks hidden rotations', async () => {
    // --hidden stores the flag next to the entries.
    const hide = await runCli(['credentials', 'rotation', 'set', 'cook-heavy', 'openai/gpt-6.1-sol', 'anthropic/claude-opus-5-5', '--description', 'Hard coding tasks', '--hidden'])
    expect(hide.code, hide.stderr).toBe(0)
    expect(rotationFile()['cook-heavy']).toEqual({
      entries: ['openai/gpt-6.1-sol', 'anthropic/claude-opus-5-5'],
      description: 'Hard coding tasks',
      hidden: true,
    })

    // `credentials list` marks it.
    const listed = await runCli(['credentials', 'list'])
    expect(listed.code, listed.stderr).toBe(0)
    expect(listed.stderr).toContain('cook-heavy: openai/gpt-6.1-sol anthropic/claude-opus-5-5 — Hard coding tasks (hidden)')

    // Neither flag preserves the current value, matching --description.
    const preserve = await runCli(['credentials', 'rotation', 'set', 'cook-heavy', 'openai/gpt-6.1-sol'])
    expect(preserve.code, preserve.stderr).toBe(0)
    expect(rotationFile()['cook-heavy']).toMatchObject({ entries: ['openai/gpt-6.1-sol'], hidden: true, description: 'Hard coding tasks' })

    // --shown clears the flag.
    const show = await runCli(['credentials', 'rotation', 'set', 'cook-heavy', 'openai/gpt-6.1-sol', '--shown'])
    expect(show.code, show.stderr).toBe(0)
    expect(rotationFile()['cook-heavy']).toEqual({ entries: ['openai/gpt-6.1-sol'], description: 'Hard coding tasks' })

    const relisted = await runCli(['credentials', 'list'])
    expect(relisted.stderr).toContain('cook-heavy: openai/gpt-6.1-sol — Hard coding tasks')
    expect(relisted.stderr).not.toContain('(hidden)')

    // --hidden and --shown together are refused.
    const both = await runCli(['credentials', 'rotation', 'set', 'cook-heavy', 'openai/gpt-6.1-sol', '--hidden', '--shown'])
    expect(both.code).not.toBe(0)
    expect(both.stderr).toContain('--hidden')
  }, 120_000)
})
