// Regression tests for Windows OpenCode command resolution and spawn args.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  ensureRoadieCommandShim,
  getIncompatibleOpencodeVersionError,
  getSpawnCommandAndArgs,
  INCOMPATIBLE_OPENCODE_MAJOR_VERSION,
  isIncompatibleOpencodeMajor,
  parseOpencodeVersion,
  sanitizeShimExecArgv,
  selectResolvedCommand,
  splitCommandLookupOutput,
} from './opencode-command.js'
import { OpencodeIncompatibleVersionError } from './errors.js'

describe('parseOpencodeVersion', () => {
  test('extracts major.minor.patch from opencode --version output', () => {
    expect(parseOpencodeVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      raw: '1.2.3',
    })
    expect(parseOpencodeVersion('opencode 2.0.0\n')).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      raw: '2.0.0',
    })
    expect(parseOpencodeVersion('v2.1.0-beta.1')).toEqual({
      major: 2,
      minor: 1,
      patch: 0,
      raw: '2.1.0',
    })
  })

  test('returns null when output has no three-part version', () => {
    expect(parseOpencodeVersion('')).toBeNull()
    expect(parseOpencodeVersion('opencode')).toBeNull()
    expect(parseOpencodeVersion('2.0')).toBeNull()
  })
})

describe('isIncompatibleOpencodeMajor', () => {
  test('rejects the incompatible major and allows every other major', () => {
    expect(INCOMPATIBLE_OPENCODE_MAJOR_VERSION).toBe(2)
    expect(isIncompatibleOpencodeMajor({ major: 2 })).toBe(true)
    expect(isIncompatibleOpencodeMajor({ major: 1 })).toBe(false)
    expect(isIncompatibleOpencodeMajor({ major: 0 })).toBe(false)
    expect(isIncompatibleOpencodeMajor({ major: 3 })).toBe(false)
  })
})

describe('getIncompatibleOpencodeVersionError', () => {
  test('returns a tagged error for OpenCode 2.x', () => {
    const error = getIncompatibleOpencodeVersionError('2.0.0')
    expect(error).toBeInstanceOf(OpencodeIncompatibleVersionError)
    expect(error?.message).toMatchInlineSnapshot(
      `"Roadie is not compatible with OpenCode version 2.0.0. Install an OpenCode 1.x release."`,
    )
  })

  test('allows 1.x and unparseable output', () => {
    expect(getIncompatibleOpencodeVersionError('1.4.0')).toBeNull()
    expect(getIncompatibleOpencodeVersionError('opencode')).toBeNull()
  })
})

describe('splitCommandLookupOutput', () => {
  test('splits windows command lookup output into trimmed lines', () => {
    expect(
      splitCommandLookupOutput(
        'C:\\Program Files\\nodejs\\opencode\r\nC:\\Program Files\\nodejs\\opencode.cmd\r\n',
      ),
    ).toEqual([
      'C:\\Program Files\\nodejs\\opencode',
      'C:\\Program Files\\nodejs\\opencode.cmd',
    ])
  })
})

describe('selectResolvedCommand', () => {
  test('prefers npm cmd shims on windows', () => {
    expect(
      selectResolvedCommand({
        output: 'C:\\Program Files\\nodejs\\opencode\r\nC:\\Program Files\\nodejs\\opencode.cmd\r\n',
        isWindows: true,
      }),
    ).toBe('C:\\Program Files\\nodejs\\opencode.cmd')
  })

  test('keeps first result on non-windows platforms', () => {
    expect(
      selectResolvedCommand({
        output: '/usr/local/bin/opencode\n/opt/homebrew/bin/opencode\n',
        isWindows: false,
      }),
    ).toBe('/usr/local/bin/opencode')
  })
})

describe('buildOpencodeServeArgs', () => {
  test('always passes --hostname so opencode.json cannot bind 0.0.0.0', async () => {
    const { buildOpencodeServeArgs } = await import('./opencode.js')
    expect(buildOpencodeServeArgs({ port: 4096, logLevel: 'WARN' })).toEqual([
      'serve',
      '--port',
      '4096',
      '--hostname',
      '127.0.0.1',
      '--print-logs',
      '--log-level',
      'WARN',
    ])
  })

  test('passes --hostname when set', async () => {
    const { buildOpencodeServeArgs } = await import('./opencode.js')
    expect(
      buildOpencodeServeArgs({ port: 4096, hostname: '0.0.0.0', logLevel: 'WARN' }),
    ).toEqual([
      'serve',
      '--port',
      '4096',
      '--hostname',
      '0.0.0.0',
      '--print-logs',
      '--log-level',
      'WARN',
    ])
  })
})

describe('OpenCode server log level', () => {
  test('defaults to INFO so cancelled runs keep their cause', async () => {
    const { buildOpencodeServeArgs, getOpencodeLogLevel } = await import('./opencode.js')
    expect(getOpencodeLogLevel({})).toBe('INFO')
    expect(buildOpencodeServeArgs({ port: 4096, logLevel: getOpencodeLogLevel({}) }).slice(-2)).toEqual([
      '--log-level',
      'INFO',
    ])
  })

  test('ROADIE_OPENCODE_LOG_LEVEL overrides it; unknown values fall back to INFO', async () => {
    const { getOpencodeLogLevel } = await import('./opencode.js')
    expect(getOpencodeLogLevel({ ROADIE_OPENCODE_LOG_LEVEL: 'warn' })).toBe('WARN')
    expect(getOpencodeLogLevel({ ROADIE_OPENCODE_LOG_LEVEL: 'debug' })).toBe('DEBUG')
    expect(getOpencodeLogLevel({ ROADIE_OPENCODE_LOG_LEVEL: 'loud' })).toBe('INFO')
  })

  test('only structured INFO and DEBUG lines are kept out of roadie.log', async () => {
    const { isVerboseOpencodeLogLine } = await import('./opencode.js')
    expect(isVerboseOpencodeLogLine('timestamp=2026-10-04T19:45:37.700Z level=INFO run=ab message=cancel session.id=ses_1')).toBe(true)
    expect(isVerboseOpencodeLogLine('timestamp=2026-10-04T19:45:37.700Z level=DEBUG run=ab message=x')).toBe(true)
    expect(isVerboseOpencodeLogLine('timestamp=2026-10-04T19:45:37.700Z level=WARN run=ab message=x')).toBe(false)
    expect(isVerboseOpencodeLogLine('timestamp=2026-10-04T19:45:37.700Z level=ERROR run=ab message=process error=Aborted')).toBe(false)
    expect(isVerboseOpencodeLogLine('[dm-agent-sync] refreshed Data Machine memory in 1171ms')).toBe(false)
  })
})

describe('published runtime artifacts', () => {
  test('lists @subrouter/opencode as a runtime dependency', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@subrouter/opencode']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('resolveSubrouterPluginSpec', () => {
  test('uses npm package identity in production for OpenCode deduplication', async () => {
    const { resolveSubrouterPluginSpec } = await import('./opencode.js')
    const require = createRequire(import.meta.url)
    const packageJsonPath = require.resolve('@subrouter/opencode/package.json')
    const version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
    expect(resolveSubrouterPluginSpec({ isDev: false })).toBe(
      `@subrouter/opencode@${version}`,
    )
  })

  test('loads the installed package directly in development', async () => {
    const { resolveSubrouterPluginSpec } = await import('./opencode.js')
    expect(resolveSubrouterPluginSpec({ isDev: true })).toMatch(
      /^file:.*\/@subrouter\/opencode\/dist\/index\.js$/,
    )
  })
})

describe('buildServerPluginList', () => {
  test('loads subrouter by default and omits it when disabled', async () => {
    const { buildServerPluginList } = await import('./opencode.js')
    const enabled = buildServerPluginList({ isDev: false, subrouterEnabled: true })
    const disabled = buildServerPluginList({ isDev: false, subrouterEnabled: false })
    expect(enabled).toHaveLength(2)
    expect(enabled[1]).toMatch(/^@subrouter\/opencode@\d+\.\d+\.\d+$/)
    expect(disabled).toHaveLength(1)
    expect(disabled[0]).toMatch(/roadie-opencode-plugin\.js$/)
  })
})

describe('publicOpencodeBindRequiresPassword', () => {
  test('allows loopback without a password', async () => {
    const { publicOpencodeBindRequiresPassword } = await import('./opencode.js')
    expect(publicOpencodeBindRequiresPassword({ hostname: null })).toBe(false)
    expect(publicOpencodeBindRequiresPassword({ hostname: '127.0.0.1' })).toBe(
      false,
    )
    expect(publicOpencodeBindRequiresPassword({ hostname: 'localhost' })).toBe(
      false,
    )
  })

  test('requires a password for 0.0.0.0', async () => {
    const { publicOpencodeBindRequiresPassword } = await import('./opencode.js')
    expect(publicOpencodeBindRequiresPassword({ hostname: '0.0.0.0' })).toBe(
      true,
    )
  })
})

describe('getSpawnCommandAndArgs', () => {
  test('wraps windows cmd shims through cmd.exe without double-quoting by node', () => {
    expect(
      getSpawnCommandAndArgs({
        resolvedCommand: 'C:\\Program Files\\nodejs\\opencode.cmd',
        baseArgs: ['serve', '--port', '4096'],
        platform: 'win32',
      }),
    ).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Program Files\\nodejs\\opencode.cmd"', 'serve', '--port', '4096'],
      windowsVerbatimArguments: true,
    })
  })

  test('leaves direct executables unchanged on windows', () => {
    expect(
      getSpawnCommandAndArgs({
        resolvedCommand: 'C:\\tools\\opencode.exe',
        baseArgs: ['serve', '--port', '4096'],
        platform: 'win32',
      }),
    ).toEqual({
      command: 'C:\\tools\\opencode.exe',
      args: ['serve', '--port', '4096'],
    })
  })
})

describe('sanitizeShimExecArgv', () => {
  test('strips --env-file=value single-arg form', () => {
    expect(
      sanitizeShimExecArgv([
        '--require',
        '/abs/tsx/preflight.cjs',
        '--env-file=.env',
        '--import',
        'file:///abs/tsx/loader.mjs',
      ]),
    ).toEqual([
      '--require',
      '/abs/tsx/preflight.cjs',
      '--import',
      'file:///abs/tsx/loader.mjs',
    ])
  })

  test('strips --env-file value two-arg form and its value', () => {
    expect(
      sanitizeShimExecArgv(['--env-file', '.env', '--require', '/abs/preflight.cjs']),
    ).toEqual(['--require', '/abs/preflight.cjs'])
  })

  test('strips --env-file-if-exists in both forms', () => {
    expect(
      sanitizeShimExecArgv([
        '--env-file-if-exists=.env',
        '--env-file-if-exists',
        '/abs/.env',
        '--enable-source-maps',
      ]),
    ).toEqual(['--enable-source-maps'])
  })

  test('leaves unrelated flags untouched', () => {
    expect(
      sanitizeShimExecArgv(['--enable-source-maps', '--max-old-space-size=4096']),
    ).toEqual(['--enable-source-maps', '--max-old-space-size=4096'])
  })
})

describe('ensureRoadieCommandShim', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-shim-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('generated posix shim does not contain a relative --env-file flag', () => {
    const result = ensureRoadieCommandShim({
      dataDir: tempDir,
      execPath: '/usr/bin/node',
      execArgv: [
        '--require',
        '/abs/tsx/preflight.cjs',
        '--env-file=.env',
        '--import',
        'file:///abs/tsx/loader.mjs',
      ],
      entryScript: '/abs/cli/src/cli',
      platform: 'linux',
    })
    expect(result).not.toBeInstanceOf(Error)
    const shimContent = fs.readFileSync(path.join(tempDir, 'bin', 'roadie'), 'utf8')
    expect(shimContent).not.toContain('--env-file')
    expect(shimContent).toContain('/abs/tsx/preflight.cjs')
    expect(shimContent).toContain('/abs/cli/src/cli')
  })
})
