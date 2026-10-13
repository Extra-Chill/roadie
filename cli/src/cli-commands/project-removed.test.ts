// `roadie project add` (alias add-project) and `roadie project create` were
// removed: the channels config (--channels-config / ROADIE_CHANNELS_CONFIG)
// is the only source of channel-to-directory bindings. The commands stay
// registered only so they can fail with a pointer to the config instead of an
// unknown-command error.
import { describe, expect, test, vi } from 'vitest'

const loggedErrors: unknown[][] = []

vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>()
  return {
    ...actual,
    createLogger: (prefix: string) => {
      const real = actual.createLogger(prefix)
      return {
        ...real,
        error: (...args: unknown[]) => {
          loggedErrors.push(args)
        },
      }
    },
  }
})

const projectCommands = (await import('./project.js')).default

/**
 * Parse and run one command with process.exit stubbed to record instead of
 * terminate: the removed-command actions log their error and exit as their
 * last statement, so the stubbed run observes both.
 */
async function runProjectCommand(argv: string[]): Promise<Array<number | string | undefined>> {
  const exitCalls: Array<number | string | undefined> = []
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code)
    return undefined as never
  }) as never)
  try {
    await projectCommands.parse(argv)
  } finally {
    exitSpy.mockRestore()
  }
  return exitCalls
}

function lastErrorMessage(): string {
  const last = loggedErrors.at(-1)
  return last?.map((arg) => String(arg)).join(' ') ?? ''
}

describe('removed project creation commands', () => {
  test('project add errors and points at the channels config', async () => {
    expect(await runProjectCommand(['node', 'roadie', 'project', 'add', '/repos/site'])).toEqual([
      64,
    ])
    expect(lastErrorMessage()).toContain('roadie project add')
    expect(lastErrorMessage()).toContain('--channels-config')
    expect(lastErrorMessage()).toContain('ROADIE_CHANNELS_CONFIG')
  })

  test('the add-project alias errors the same way', async () => {
    expect(await runProjectCommand(['node', 'roadie', 'add-project', '/repos/site'])).toEqual([64])
    expect(lastErrorMessage()).toContain('--channels-config')
    expect(lastErrorMessage()).toContain('ROADIE_CHANNELS_CONFIG')
  })

  test('project create errors and points at the channels config', async () => {
    expect(
      await runProjectCommand([
        'node',
        'roadie',
        'project',
        'create',
        'my-app',
        '--projects-dir',
        '/srv/projects',
      ]),
    ).toEqual([64])
    expect(lastErrorMessage()).toContain('roadie project create')
    expect(lastErrorMessage()).toContain('--channels-config')
    expect(lastErrorMessage()).toContain('ROADIE_CHANNELS_CONFIG')
  })
})
