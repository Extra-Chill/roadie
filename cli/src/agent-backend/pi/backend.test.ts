// The Pi backend's --isolate-shells contract: the wrapper reaches Pi through
// `shellPath` in a Roadie-owned agent dir, and sessions are refused when it
// cannot. Unit-level: the spawn gate runs without a pi binary or root.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { AgentRequestError } from '../types.js'
import { PiBackendProvider, writePiShellPath } from './backend.js'
import type { IsolatedShellAccount } from '../../isolated-shell.js'

const account: IsolatedShellAccount = {
  username: 'roadie-agent',
  uid: 1001,
  gid: 1001,
  home: `/home/roadie-agent`,
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), prefix))
}

describe('writePiShellPath', () => {
  test('merges shellPath into settings.json, keeping other keys, idempotently', () => {
    const agentDir = tempDir('pi-shell-path-')
    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ transport: 'sse', other: 1 }),
    )
    expect(writePiShellPath({ agentDir, shellPath: '/data/bin/isolated-shell/bash' })).toBe(
      path.join(agentDir, 'settings.json'),
    )
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({
      transport: 'sse',
      other: 1,
      shellPath: '/data/bin/isolated-shell/bash',
    })
    // A second write with the same shellPath changes nothing.
    const before = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')
    expect(writePiShellPath({ agentDir, shellPath: '/data/bin/isolated-shell/bash' })).toBe(
      path.join(agentDir, 'settings.json'),
    )
    expect(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).toBe(before)
  })

  test('creates a missing agent dir and starts from empty settings', () => {
    const agentDir = path.join(tempDir('pi-shell-path-'), 'agent')
    expect(writePiShellPath({ agentDir, shellPath: '/w/bash' })).toBe(
      path.join(agentDir, 'settings.json'),
    )
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({
      shellPath: '/w/bash',
    })
  })
})

describe('Pi sessions under --isolate-shells', () => {
  test('refused with a clear error when no Roadie-owned agent dir can carry shellPath', async () => {
    const provider = new PiBackendProvider({
      bin: 'pi',
      sessionDir: tempDir('pi-isolation-'),
      isolateShells: {
        username: account.username,
        dataDir: tempDir('pi-isolation-'),
        agentDir: null,
      },
    })
    const result = await provider
      .getBackend()
      .sessions.create({ directory: tempDir('pi-isolation-') })
    expect(result).toBeInstanceOf(AgentRequestError)
    if (!(result instanceof AgentRequestError)) throw new Error('unreachable')
    expect(result.detail).toContain('--isolate-shells')
    expect(result.detail).toContain('refused')
    provider.dispose()
  })

  test('fail-closed: a failed wrapper setup refuses the session and writes no shellPath', async () => {
    const sessionDir = tempDir('pi-isolation-')
    const agentDir = tempDir('pi-isolation-')
    const provider = new PiBackendProvider({
      bin: 'pi',
      sessionDir,
      isolateShells: { username: account.username, dataDir: sessionDir, agentDir },
      ensureIsolatedShell: () => Promise.resolve(new Error('test: wrapper setup failed')),
    })
    const result = await provider.getBackend().sessions.create({ directory: sessionDir })
    expect(result).toBeInstanceOf(AgentRequestError)
    if (!(result instanceof AgentRequestError)) throw new Error('unreachable')
    expect(result.detail).toContain('test: wrapper setup failed')
    expect(fs.existsSync(path.join(agentDir, 'settings.json'))).toBe(false)
    provider.dispose()
  })

  test('the ensured wrapper is written into the agent dir before the first spawn', async () => {
    const root = tempDir('pi-isolation-')
    const sessionDir = path.join(root, 'sessions')
    const agentDir = path.join(root, 'agent')
    const wrapperPath = path.join(root, 'bin', 'isolated-shell', 'bash')
    let ensureCalls = 0
    const provider = new PiBackendProvider({
      // A fake pi that exits immediately: the isolation gate must run (and
      // write shellPath) before the spawn, whose failure is expected here.
      bin: (() => {
        const bin = path.join(root, 'fake-pi')
        fs.writeFileSync(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
        return bin
      })(),
      sessionDir,
      isolateShells: { username: account.username, dataDir: root, agentDir },
      ensureIsolatedShell: () => {
        ensureCalls++
        return Promise.resolve({ shellPath: wrapperPath, account })
      },
    })
    const result = await provider.getBackend().sessions.create({ directory: root })
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({
      shellPath: wrapperPath,
    })
    // The gate passed, so the failure is the (expected) pi spawn, not isolation.
    expect(result).toBeInstanceOf(Error)
    if (result instanceof AgentRequestError) expect(result.detail).not.toContain('--isolate-shells')
    // The gate is resolved once per provider, not per session.
    await provider.getBackend().sessions.create({ directory: root })
    expect(ensureCalls).toBe(1)
    provider.dispose()
  })
})
