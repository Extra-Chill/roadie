// The Pi backend driving real `pi --mode rpc` processes against a scripted
// model server. Skipped when no `pi` binary is available (set ROADIE_PI_BIN).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { AgentEvent } from '../events.js'
import { PiBackendProvider } from './backend.js'
import { fakeModelsJson, startFakeModelServer } from './fake-model-server.js'

function findPi(): string | undefined {
  const candidates = [process.env['ROADIE_PI_BIN'], 'pi'].filter(Boolean) as string[]
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' })
      return bin
    } catch {}
  }
  return undefined
}

const bin = findPi()

describe.skipIf(!bin)('Pi backend over real pi processes', () => {
  let server: Awaited<ReturnType<typeof startFakeModelServer>>
  let root: string
  let project: string
  let provider: PiBackendProvider
  const events: AgentEvent[] = []
  const controller = new AbortController()

  const makeProvider = () => new PiBackendProvider({
    bin: bin!,
    sessionDir: path.join(root, 'sessions'),
    model: 'fake/fake-1',
    env: { PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1' },
  })

  async function listen(target: PiBackendProvider) {
    const stream = await target.subscribeEvents({ signal: controller.signal })
    void (async () => {
      for await (const item of stream) events.push(...item.events)
    })()
  }

  async function until<T>(find: () => T | undefined, ms = 30_000): Promise<T> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const found = find()
      if (found !== undefined) return found
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('timed out')
  }

  const idleCount = (sessionId: string) => events.filter((e) => e.type === 'idle' && e.sessionId === sessionId).length

  beforeAll(async () => {
    server = await startFakeModelServer()
    root = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'roadie-pi-'))
    project = path.join(root, 'project')
    fs.mkdirSync(project)
    fs.mkdirSync(path.join(root, 'agent'))
    fs.writeFileSync(path.join(root, 'agent', 'models.json'), fakeModelsJson(server.baseUrl))
    provider = makeProvider()
    await listen(provider)
  })

  afterAll(async () => {
    controller.abort()
    provider?.dispose()
    await server?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  let sessionId = ''

  test('create, prompt, stream a reply, go idle', async () => {
    const session = await provider.getBackend().sessions.create({ directory: project, title: 'pi e2e' })
    if (session instanceof Error) throw session
    sessionId = session.id
    expect(session.directory).toBe(project)
    const result = await provider.getBackend().sessions.prompt({ sessionId, directory: project, parts: [{ kind: 'text', text: 'say hi' }], system: 'ROADIE_SYSTEM_MARKER' })
    expect(result).toBeUndefined()
    await until(() => (idleCount(sessionId) >= 1 ? true : undefined))
    const text = events.find((e) => e.type === 'part' && e.part.kind === 'text' && e.part.endedAt && e.part.messageId.startsWith('pi-assistant'))
    expect(text?.type === 'part' && text.part.kind === 'text' && text.part.text).toBe('hello from the fake model')
    const done = events.find((e) => e.type === 'message' && e.message.role === 'assistant' && e.message.completedAt)
    expect(done?.type === 'message' && done.message.finish).toBe('stop')
  })

  test('a tool call asks Roadie; an allow rule lets it run', async () => {
    const before = idleCount(sessionId)
    await provider.getBackend().sessions.prompt({ sessionId, directory: project, parts: [{ kind: 'text', text: 'RUN_TOOL echo allowed-output' }] })
    await until(() => (idleCount(sessionId) > before ? true : undefined))
    const tool = events.findLast((e) => e.type === 'part' && e.part.kind === 'tool')
    expect(tool?.type === 'part' && tool.part.kind === 'tool' && tool.part.status).toBe('completed')
    expect(tool?.type === 'part' && tool.part.kind === 'tool' && tool.part.output).toContain('allowed-output')
  })

  test('an ask rule surfaces permission.asked and waits for the reply', async () => {
    await provider.getBackend().sessions.setPermissions({ sessionId, permission: [{ permission: 'bash', pattern: '*', action: 'ask' }] })
    const before = idleCount(sessionId)
    await provider.getBackend().sessions.prompt({ sessionId, directory: project, parts: [{ kind: 'text', text: 'RUN_TOOL echo after-approval' }] })
    const asked = await until(() => events.find((e) => e.type === 'permission.asked' && e.request.patterns.includes('echo after-approval')))
    if (asked.type !== 'permission.asked') throw new Error('unreachable')
    expect(asked.request.permission).toBe('bash')
    expect(idleCount(sessionId)).toBe(before)
    expect(await provider.getBackend().sessions.replyPermission({ requestId: asked.request.id, directory: project, reply: 'once' })).toBeUndefined()
    await until(() => (idleCount(sessionId) > before ? true : undefined))
    const tool = events.findLast((e) => e.type === 'part' && e.part.kind === 'tool')
    expect(tool?.type === 'part' && tool.part.kind === 'tool' && tool.part.output).toContain('after-approval')
  })

  test('a rejected permission blocks the tool', async () => {
    const before = idleCount(sessionId)
    await provider.getBackend().sessions.prompt({ sessionId, directory: project, parts: [{ kind: 'text', text: 'RUN_TOOL echo never-runs' }] })
    const asked = await until(() => events.find((e) => e.type === 'permission.asked' && e.request.patterns.includes('echo never-runs')))
    if (asked.type !== 'permission.asked') throw new Error('unreachable')
    await provider.getBackend().sessions.replyPermission({ requestId: asked.request.id, directory: project, reply: 'reject' })
    await until(() => (idleCount(sessionId) > before ? true : undefined))
    const tool = events.findLast((e) => e.type === 'part' && e.part.kind === 'tool')
    expect(tool?.type === 'part' && tool.part.kind === 'tool' && tool.part.status).toBe('error')
  })

  test('history matches what streamed, and the system prompt reached the model only through the extension', async () => {
    const history = await provider.getBackend().sessions.messages({ sessionId, directory: project })
    if (history instanceof Error) throw history
    expect(history.filter((h) => h.message.role === 'user')).toHaveLength(4)
    const streamedIds = new Set(events.flatMap((e) => (e.type === 'message' ? [e.message.id] : [])))
    for (const entry of history) expect(streamedIds.has(entry.message.id)).toBe(true)
    const userTexts = history.flatMap((h) => h.parts.flatMap((p) => (p.kind === 'text' && h.message.role === 'user' ? [p.text] : [])))
    expect(userTexts.join('\n')).not.toContain('ROADIE_SYSTEM_MARKER')
    const first = JSON.parse(server.bodies[0]!) as { messages: Array<{ role: string; content: unknown }> }
    const system = first.messages.find((m) => m.role === 'system')
    expect(JSON.stringify(system?.content)).toContain('ROADIE_SYSTEM_MARKER')
  })

  test('after a restart, a new provider finds the session on disk and resumes it', async () => {
    provider.dispose()
    provider = makeProvider()
    await listen(provider)
    expect(provider.owns(sessionId)).toBe(true)
    const listed = await provider.getBackend().sessions.list({ directory: project })
    expect(listed instanceof Error ? [] : listed.map((s) => s.id)).toContain(sessionId)
    const history = await provider.getBackend().sessions.messages({ sessionId, directory: project })
    expect(history instanceof Error ? 0 : history.length).toBeGreaterThan(4)
    const before = idleCount(sessionId)
    await provider.getBackend().sessions.prompt({ sessionId, directory: project, parts: [{ kind: 'text', text: 'again' }] })
    await until(() => (idleCount(sessionId) > before ? true : undefined))
  })

  test('an idle session process stops and resumes on the next prompt; an unprompted one stays', async () => {
    const quick = new PiBackendProvider({ ...makeProvider().options, idleTimeoutMs: 300 })
    await listen(quick)
    const running = (id: string) => (quick as unknown as { sessions: Map<string, unknown> }).sessions.has(id)
    const empty = await quick.getBackend().sessions.create({ directory: project })
    const session = await quick.getBackend().sessions.create({ directory: project })
    if (session instanceof Error || empty instanceof Error) throw session
    const first = idleCount(session.id)
    await quick.getBackend().sessions.prompt({ sessionId: session.id, directory: project, parts: [{ kind: 'text', text: 'hello' }] })
    await until(() => (idleCount(session.id) > first ? true : undefined))
    await until(() => (running(session.id) ? undefined : true), 5_000)
    expect(running(empty.id)).toBe(true)
    const before = idleCount(session.id)
    expect(await quick.getBackend().sessions.prompt({ sessionId: session.id, directory: project, parts: [{ kind: 'text', text: 'wake up' }] })).toBeUndefined()
    await until(() => (idleCount(session.id) > before ? true : undefined))
    quick.dispose()
  }, 30_000)

  test('the catalog lists Pi models; fork copies a whole session', async () => {
    const catalog = await provider.getBackend().catalog.providers({})
    if (catalog instanceof Error) throw catalog
    expect(catalog.providers.find((p) => p.id === 'fake')?.models['fake-1']?.contextLimit).toBe(100000)
    const forked = await provider.getBackend().sessions.fork({ sessionId, directory: project })
    if (forked instanceof Error) throw forked
    expect(forked.id).not.toBe(sessionId)
    const history = await provider.getBackend().sessions.messages({ sessionId: forked.id, directory: project })
    expect(history instanceof Error ? 0 : history.length).toBeGreaterThan(4)
  })
})
