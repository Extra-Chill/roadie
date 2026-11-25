// Pi process hygiene (#477): reading a session's history never starts a Pi
// process, a session search over many sessions leaves none behind, a
// throwaway Pi that never answers is killed after the timeout, and spawning
// past the global cap is refused.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SessionManager, buildSessionContext, parseSessionEntries, type SessionEntry } from '@earendil-works/pi-coding-agent'
import { PiBackendProvider } from './backend.js'
import { toAgentHistory, type PiMessage } from './events.js'
import { PiProcess, PiProcessLimitError, livePiProcessCount, setPiProcessLimit } from './rpc.js'
import { projectPiSessionEntries, readPiSessionMessages } from './session-file.js'
import { collectSessionSearchMatches, parseSessionSearchPattern } from '../../session-search.js'

const fixtures = path.join(import.meta.dirname, 'fixtures')

function workspace(): string {
  return fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pi-hygiene-'))
}

/** A `pi` stand-in: records each start, then never answers anything. */
function silentPi(root: string): { bin: string; starts: string } {
  const bin = path.join(root, 'silent-pi')
  const starts = path.join(root, 'starts.log')
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    `require('fs').appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n')`,
    'process.stdin.resume()',
    'setInterval(() => {}, 1000)',
  ].join('\n'), { mode: 0o755 })
  return { bin, starts }
}

function startedPids(starts: string): number[] {
  if (!fs.existsSync(starts)) return []
  return fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).map(Number)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

/** Copy a fixture session file into a session dir under a fresh id, as Pi names it. */
function installSession({ sessionDir, fixture, id, cwd, text }: { sessionDir: string; fixture?: string; id: string; cwd: string; text?: string }): string {
  const file = path.join(sessionDir, `2026-10-04T19-39-26-670Z_${id}.jsonl`)
  let lines: string[]
  if (fixture) {
    lines = fs.readFileSync(path.join(fixtures, fixture), 'utf8').split('\n').filter((line) => line.trim())
    const header = JSON.parse(lines[0]!) as Record<string, unknown>
    lines[0] = JSON.stringify({ ...header, id, cwd })
  } else {
    lines = [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-04T19:39:26.670Z', cwd }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-04T19:39:27.000Z', message: { role: 'user', content: [{ type: 'text', text: text ?? 'hello' }], timestamp: 1791142767000 } }),
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-04T19:39:28.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `reply to ${text ?? 'hello'}` }], provider: 'p', model: 'm', stopReason: 'stop', timestamp: 1791142768000 } }),
    ]
  }
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

/** What Pi's own `get_messages` returns for a freshly loaded session file. */
function piGetMessages(file: string): PiMessage[] {
  return SessionManager.open(file).buildSessionContext().messages as unknown as PiMessage[]
}

afterEach(() => {
  setPiProcessLimit(undefined)
})

describe('Pi session history without a process', () => {
  test('messages() for a non-running session spawns nothing and matches the RPC path', async () => {
    const fixture = 'pi-session-file.jsonl'
    const root = workspace()
    const { bin, starts } = silentPi(root)
    const sessionDir = path.join(root, 'sessions')
    const id = '01a1086d-a84e-713d-b2db-2f588a962517'
    const file = installSession({ sessionDir, fixture, id, cwd: root })
    const provider = new PiBackendProvider({ bin, sessionDir, idleTimeoutMs: 0, rpcTimeoutMs: 500 })

    const fromFile = await provider.getBackend().sessions.messages({ sessionId: id, directory: root })
    expect(fromFile).not.toBeInstanceOf(Error)
    expect(livePiProcessCount()).toBe(0)
    expect(startedPids(starts)).toEqual([])

    // The RPC path: a running session answering get_messages as Pi would.
    const rpcMessages = piGetMessages(file)
    const internals = provider as unknown as { sessions: Map<string, unknown> }
    internals.sessions.set(id, {
      id,
      directory: root,
      sessionFile: file,
      process: {
        running: true,
        exited: false,
        request: async (command: { type: string }) => (command.type === 'get_messages' ? { messages: rpcMessages } : undefined),
        kill: async () => {},
      },
    })
    const fromRpc = await provider.getBackend().sessions.messages({ sessionId: id, directory: root })
    internals.sessions.delete(id)

    expect(fromFile).toEqual(fromRpc)
    expect(fromFile).toEqual(toAgentHistory({ messages: rpcMessages, sessionId: id }))
    expect((fromFile as unknown[]).length).toBeGreaterThan(0)
    await provider.dispose()
  })

  test('the file projection matches Pi on branches, compaction, custom messages and context edits', () => {
    const at = (n: number) => `2026-10-04T19:40:${String(n).padStart(2, '0')}.000Z`
    const user = (id: string, parentId: string | null, text: string, n: number) => ({ type: 'message', id, parentId, timestamp: at(n), message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1791142800000 + n } })
    const assistant = (id: string, parentId: string, text: string, n: number) => ({ type: 'message', id, parentId, timestamp: at(n), message: { role: 'assistant', content: [{ type: 'text', text }], provider: 'p', model: 'm', stopReason: 'stop', timestamp: 1791142800000 + n } })
    const entries = [
      { type: 'session', version: 3, id: 'tree', timestamp: at(0), cwd: '/project' },
      { type: 'model_change', id: 'm0', parentId: null, timestamp: at(1), provider: 'p', modelId: 'm' },
      user('u1', 'm0', 'first question', 2),
      assistant('a1', 'u1', 'first answer', 3),
      user('u2', 'a1', 'abandoned branch', 4),
      assistant('a2', 'u2', 'abandoned answer', 5),
      { type: 'branch_summary', id: 'b1', parentId: 'a1', timestamp: at(6), fromId: 'a2', summary: 'Tried something else' },
      user('u3', 'b1', 'second question', 7),
      assistant('a3', 'u3', 'second answer', 8),
      { type: 'label', id: 'l1', parentId: 'a3', timestamp: at(9), targetId: 'u3', label: 'checkpoint' },
      { type: 'compaction', id: 'c1', parentId: 'l1', timestamp: at(10), summary: 'Summary of the start', firstKeptEntryId: 'u3', tokensBefore: 1234 },
      { type: 'custom_message', id: 'x1', parentId: 'c1', timestamp: at(11), customType: 'roadie-context', content: [{ type: 'text', text: 'context note' }], display: true },
      { type: 'custom', id: 'x2', parentId: 'x1', timestamp: at(12), customType: 'state', data: { a: 1 } },
      user('u4', 'x2', 'third question', 13),
      assistant('a4', 'u4', 'secret answer', 14),
      { type: 'context_edit', id: 'e1', parentId: 'a4', timestamp: at(15), targetId: 'a4', replacement: { content: 'redacted answer' } },
      { type: 'session_info', id: 's1', parentId: 'e1', timestamp: at(16), name: 'Named' },
    ]
    const content = entries.map((entry) => JSON.stringify(entry)).join('\n')
    const parsed = parseSessionEntries(content).filter((entry) => entry.type !== 'session') as SessionEntry[]
    const expected = buildSessionContext(parsed).messages

    const projected = projectPiSessionEntries(content)
    expect(projected).not.toBeInstanceOf(Error)
    expect(projected).toEqual(expected)
    const texts = (projected as PiMessage[]).map((message) => JSON.stringify(message))
    expect(texts.some((text) => text.includes('abandoned'))).toBe(false)
    expect(texts.some((text) => text.includes('redacted answer'))).toBe(true)
  })

  test('a file it cannot project is refused, so the caller asks Pi instead', () => {
    expect(projectPiSessionEntries(JSON.stringify({ type: 'session', version: 99, id: 'x', cwd: '/' }))).toBeInstanceOf(Error)
    const unknown = [
      { type: 'session', version: 3, id: 'x', timestamp: '2026-10-04T19:40:00.000Z', cwd: '/' },
      { type: 'future_entry', id: 'f1', parentId: null, timestamp: '2026-10-04T19:40:01.000Z' },
    ].map((entry) => JSON.stringify(entry)).join('\n')
    expect(projectPiSessionEntries(unknown)).toBeInstanceOf(Error)
    expect(readPiSessionMessages('/nonexistent/session.jsonl')).toBeInstanceOf(Error)
  })

  test('the fallback for an unreadable file uses a throwaway Pi that is killed', async () => {
    const root = workspace()
    const { bin, starts } = silentPi(root)
    const sessionDir = path.join(root, 'sessions')
    const id = '01a1086d-a84e-713d-b2db-2f588a962599'
    const file = path.join(sessionDir, `2026-10-04T19-39-26-670Z_${id}.jsonl`)
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 99, id, timestamp: '2026-10-04T19:40:00.000Z', cwd: root })}\n`)
    const provider = new PiBackendProvider({ bin, sessionDir, idleTimeoutMs: 0, rpcTimeoutMs: 300 })
    const result = await provider.getBackend().sessions.messages({ sessionId: id, directory: root })
    expect(result).toBeInstanceOf(Error)
    const pids = startedPids(starts)
    expect(pids).toHaveLength(1)
    expect(await waitFor(() => livePiProcessCount() === 0 && !alive(pids[0]!))).toBe(true)
    // No session process was registered for it.
    expect((provider as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
    await provider.dispose()
  })
})

describe('session search over many Pi sessions', () => {
  test('does not grow the running-process count', async () => {
    const root = workspace()
    const { bin, starts } = silentPi(root)
    const sessionDir = path.join(root, 'sessions')
    const count = 40
    const sessions = Array.from({ length: count }, (_, i) => {
      const id = `0000${String(i).padStart(4, '0')}-a84e-713d-b2db-2f588a962517`
      installSession({ sessionDir, id, cwd: root, text: i % 7 === 0 ? `needle ${i}` : `hay ${i}` })
      return { id, title: `Session ${i}`, directory: root, updated: 1_000 + i }
    })
    const provider = new PiBackendProvider({ bin, sessionDir, idleTimeoutMs: 0, rpcTimeoutMs: 500 })
    let maxLive = 0
    const pattern = parseSessionSearchPattern('needle')
    if (pattern instanceof Error) throw pattern
    const result = await collectSessionSearchMatches({
      sessions,
      searchPattern: pattern,
      sessionToThread: new Map(),
      limit: 100,
      loadMessages: async (session) => {
        const messages = await provider.getBackend().sessions.messages({ sessionId: session.id, directory: session.directory })
        maxLive = Math.max(maxLive, livePiProcessCount())
        if (messages instanceof Error) throw messages
        return messages
      },
    })
    expect(result.scannedSessions).toBe(count)
    expect(result.matches.length).toBe(Math.ceil(count / 7))
    expect(maxLive).toBe(0)
    expect(livePiProcessCount()).toBe(0)
    expect(startedPids(starts)).toEqual([])
    await provider.dispose()
  })
})

describe('throwaway Pi processes', () => {
  test('a request that never gets an answer times out', async () => {
    const root = workspace()
    const { bin } = silentPi(root)
    const child = PiProcess.spawn({ bin, args: [], cwd: root })
    if (child instanceof Error) throw child
    try {
      const started = Date.now()
      const result = await child.request({ type: 'get_state' }, { timeoutMs: 200 })
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('did not answer get_state')
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      await child.kill({ graceMs: 500 })
    }
    expect(livePiProcessCount()).toBe(0)
  })

  test('a commands() probe that never responds is killed after the timeout', async () => {
    const root = workspace()
    const { bin, starts } = silentPi(root)
    const provider = new PiBackendProvider({ bin, sessionDir: path.join(root, 'sessions'), idleTimeoutMs: 0, rpcTimeoutMs: 300 })
    const result = await provider.getBackend().catalog.commands!({ directory: root })
    expect(result).toBeInstanceOf(Error)
    const pids = startedPids(starts)
    expect(pids).toHaveLength(1)
    expect(await waitFor(() => livePiProcessCount() === 0 && !alive(pids[0]!))).toBe(true)
    await provider.dispose()
  })

  test('a providers() probe that never responds is killed after the timeout', async () => {
    const root = workspace()
    const { bin, starts } = silentPi(root)
    const provider = new PiBackendProvider({ bin, sessionDir: path.join(root, 'sessions'), idleTimeoutMs: 0, rpcTimeoutMs: 300 })
    const result = await provider.getBackend().catalog.providers({})
    expect(result).toBeInstanceOf(Error)
    const pids = startedPids(starts)
    expect(pids).toHaveLength(1)
    expect(await waitFor(() => livePiProcessCount() === 0 && !alive(pids[0]!))).toBe(true)
    await provider.dispose()
  })
})

describe('global Pi process cap', () => {
  test('spawning past the cap returns an error and starts nothing', async () => {
    const root = workspace()
    const { bin, starts } = silentPi(root)
    setPiProcessLimit(2)
    const first = PiProcess.spawn({ bin, args: [], cwd: root })
    const second = PiProcess.spawn({ bin, args: [], cwd: root })
    try {
      expect(first).toBeInstanceOf(PiProcess)
      expect(second).toBeInstanceOf(PiProcess)
      expect(livePiProcessCount()).toBe(2)
      const third = PiProcess.spawn({ bin, args: [], cwd: root })
      expect(third).toBeInstanceOf(PiProcessLimitError)
      expect((third as Error).message).toContain('limit 2')
      expect(livePiProcessCount()).toBe(2)

      // Backend spawn sites surface the refusal instead of starting a process.
      const provider = new PiBackendProvider({ bin, sessionDir: path.join(root, 'sessions'), idleTimeoutMs: 0, rpcTimeoutMs: 300 })
      expect(await provider.getBackend().catalog.commands!({ directory: root })).toBeInstanceOf(Error)
      expect(await provider.getBackend().sessions.create({ directory: root })).toBeInstanceOf(Error)
      expect(livePiProcessCount()).toBe(2)
      await provider.dispose()
    } finally {
      if (first instanceof PiProcess) await first.kill({ graceMs: 500 })
      if (second instanceof PiProcess) await second.kill({ graceMs: 500 })
    }
    expect(livePiProcessCount()).toBe(0)
    // Room again once they exited.
    const again = PiProcess.spawn({ bin, args: [], cwd: root })
    expect(again).toBeInstanceOf(PiProcess)
    if (again instanceof PiProcess) await again.kill({ graceMs: 500 })
    expect(livePiProcessCount()).toBe(0)
    // The refused spawns never ran the binary.
    expect(startedPids(starts).length).toBeLessThanOrEqual(3)
  })
})
