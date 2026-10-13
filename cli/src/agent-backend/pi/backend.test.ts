// The Pi backend's --isolate-shells contract, the persisted session state
// (titles, permission rules), the model catalog TTL, and honest MCP status:
// unit-level, no pi binary or root needed.

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

describe('Pi session state survives a restart', () => {
  const sessionId = 'abcd1234-5678-90ab-cdef-1234567890ab'

  function seedSessionFile(sessionDir: string): string {
    const file = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`)
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: sessionId, cwd: sessionDir, timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
    return file
  }

  test('a title set while the session is offline is listed by a fresh provider', async () => {
    const sessionDir = tempDir('pi-persist-')
    seedSessionFile(sessionDir)
    const first = new PiBackendProvider({ bin: 'pi', sessionDir })
    const setTitle = first.getBackend().sessions.setTitle
    if (!setTitle) throw new Error('setTitle missing')
    await setTitle({ sessionId, title: 'Persisted title' })
    expect(
      JSON.parse(fs.readFileSync(path.join(sessionDir, `roadie-${sessionId}.json`), 'utf8')),
    ).toEqual({ title: 'Persisted title' })
    first.dispose()

    // A restart: fresh provider, empty in-memory state, same session dir.
    const second = new PiBackendProvider({ bin: 'pi', sessionDir })
    const got = await second.getBackend().sessions.get({ sessionId })
    expect(got && !(got instanceof Error) ? got.title : undefined).toBe('Persisted title')
    const listed = await second.getBackend().sessions.list({ directory: sessionDir })
    if (listed instanceof Error) throw listed
    expect(listed.find((session) => session.id === sessionId)?.title).toBe('Persisted title')
    second.dispose()
  })

  test('permission rules persist and still decide tool calls after a restart', async () => {
    const sessionDir = tempDir('pi-persist-')
    seedSessionFile(sessionDir)
    const first = new PiBackendProvider({ bin: 'pi', sessionDir })
    await first.getBackend().sessions.setPermissions({ sessionId, permission: [{ permission: 'bash', pattern: '*', action: 'allow' }] })
    first.dispose()

    const second = new PiBackendProvider({ bin: 'pi', sessionDir })
    // A running session with no in-memory rules: the decision must come from
    // the persisted state beside its session file.
    const sent: unknown[] = []
    const session = {
      id: sessionId,
      directory: sessionDir,
      process: { sent, exited: false, send: (record: unknown) => sent.push(record), request: async () => undefined, kill: () => {} },
    }
    ;(second as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, session)
    const onUiRequest = (second as unknown as { onUiRequest(s: unknown, r: unknown): void }).onUiRequest.bind(second)
    onUiRequest(session, {
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'confirm',
      title: 'roadie:permission',
      message: JSON.stringify({ tool: 'bash', callId: 'c1', input: { command: 'git status' }, cwd: sessionDir }),
    })
    expect(sent).toEqual([{ type: 'extension_ui_response', id: 'ui-1', confirmed: true }])
    second.dispose()
  })

  test('delete removes the persisted state with the session file', async () => {
    const sessionDir = tempDir('pi-persist-')
    seedSessionFile(sessionDir)
    const provider = new PiBackendProvider({ bin: 'pi', sessionDir })
    const setTitle = provider.getBackend().sessions.setTitle
    if (!setTitle) throw new Error('setTitle missing')
    await setTitle({ sessionId, title: 'Doomed' })
    await provider.getBackend().sessions.delete({ sessionId, directory: sessionDir })
    expect(fs.existsSync(path.join(sessionDir, `roadie-${sessionId}.json`))).toBe(false)
    const got = await provider.getBackend().sessions.get({ sessionId })
    expect(got).toBeUndefined()
    provider.dispose()
  })
})

describe('Pi model catalog TTL', () => {
  /** A stand-in `pi --mode rpc` binary that answers every command and counts its spawns. */
  function fakeRpcBin(root: string): string {
    const bin = path.join(root, 'fake-pi-rpc.cjs')
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.env['PI_FAKE_SPAWN_COUNTER']) fs.appendFileSync(process.env['PI_FAKE_SPAWN_COUNTER'], '1\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const data = message.type === 'get_available_models'
      ? { models: [{ id: 'fake-1', name: 'Fake 1', provider: 'fake', reasoning: true }] }
      : {}
    process.stdout.write(JSON.stringify({ id: message.id, type: 'response', command: String(message.type), success: true, data }) + '\\n')
  }
})
`, { mode: 0o755 })
    return bin
  }

  function spawnCount(counter: string): number {
    return fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length
  }

  function providerWithTtl(root: string, counter: string, catalogTtlMs?: number): PiBackendProvider {
    return new PiBackendProvider({
      bin: fakeRpcBin(root),
      sessionDir: path.join(root, 'sessions'),
      ...(catalogTtlMs !== undefined && { catalogTtlMs }),
      env: { PI_FAKE_SPAWN_COUNTER: counter },
    })
  }

  test('the catalog is probed once and reused within the TTL', async () => {
    const root = tempDir('pi-catalog-')
    const counter = path.join(root, 'spawns')
    const provider = providerWithTtl(root, counter)
    const first = await provider.getBackend().catalog.providers({})
    expect(first instanceof Error).toBe(false)
    const second = await provider.getBackend().catalog.providers({})
    expect(second).toEqual(first)
    expect(spawnCount(counter)).toBe(1)
    provider.dispose()
  })

  test('a TTL of 0 re-probes on every call', async () => {
    const root = tempDir('pi-catalog-')
    const counter = path.join(root, 'spawns')
    const provider = providerWithTtl(root, counter, 0)
    await provider.getBackend().catalog.providers({})
    await provider.getBackend().catalog.providers({})
    expect(spawnCount(counter)).toBe(2)
    provider.dispose()
  })

  test('an expired TTL re-probes', async () => {
    const root = tempDir('pi-catalog-')
    const counter = path.join(root, 'spawns')
    const provider = providerWithTtl(root, counter, 25)
    await provider.getBackend().catalog.providers({})
    await new Promise((resolve) => setTimeout(resolve, 80))
    await provider.getBackend().catalog.providers({})
    expect(spawnCount(counter)).toBe(2)
    provider.dispose()
  })
})

describe('Pi MCP status honesty', () => {
  test('an enabled server reports unknown; a disabled one reports disabled', async () => {
    const root = tempDir('pi-mcp-status-')
    const provider = new PiBackendProvider({ bin: 'pi', sessionDir: path.join(root, 'sessions') })
    const mcp = provider.getBackend().mcp
    if (!mcp) throw new Error('mcp missing')
    await mcp.addRemote({ directory: root, name: 'remote-1', url: 'https://example.test/mcp', headers: {} })
    const enabled = await mcp.status({ directory: root })
    if (enabled instanceof Error) throw enabled
    // Pi exposes no MCP connection state to Roadie: enabled must not claim connected.
    expect(enabled['remote-1']).toEqual({ status: 'unknown' })
    await mcp.disconnect({ directory: root, name: 'remote-1' })
    const disabled = await mcp.status({ directory: root })
    if (disabled instanceof Error) throw disabled
    expect(disabled['remote-1']).toEqual({ status: 'disabled' })
    provider.dispose()
  })
})
