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
import { loadFileEditEvents } from '../../file-edit-log.js'

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
    // Roadie owns the prompt: its base replaces Pi's default.
    expect(JSON.stringify(system?.content)).toContain('You are a coding agent working in the user')
    expect(JSON.stringify(system?.content)).not.toContain('pi, a coding agent harness')
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

  test('project MCP servers reach Pi; calls go through Roadie permissions', async () => {
    const mcpProject = path.join(root, 'mcp-project')
    fs.mkdirSync(mcpProject, { recursive: true })
    fs.writeFileSync(path.join(mcpProject, 'opencode.json'), JSON.stringify({
      mcp: { echo: { type: 'local', command: [process.execPath, path.join(import.meta.dirname, 'fake-mcp-server.mjs')] } },
    }))
    const status = await provider.getBackend().mcp!.status({ directory: mcpProject })
    expect(status).toEqual({ echo: { status: 'connected' } })
    const session = await provider.getBackend().sessions.create({ directory: mcpProject })
    if (session instanceof Error) throw session
    const run = async (text: string) => {
      const before = idleCount(session.id)
      await provider.getBackend().sessions.prompt({ sessionId: session.id, directory: mcpProject, parts: [{ kind: 'text', text }] })
      await until(() => (idleCount(session.id) > before ? true : undefined))
      return events.findLast((e) => e.type === 'part' && e.part.kind === 'tool' && e.part.sessionId === session.id)
    }
    const allowed = await run('CALL_TOOL mcp__echo__say {"text":"from pi"}')
    expect(allowed?.type === 'part' && allowed.part.kind === 'tool' && allowed.part.output).toContain('mcp says: from pi')
    await provider.getBackend().sessions.setPermissions({ sessionId: session.id, permission: [{ permission: 'echo_*', pattern: '*', action: 'deny' }] })
    const denied = await run('CALL_TOOL mcp__echo__say {"text":"blocked"}')
    expect(denied?.type === 'part' && denied.part.kind === 'tool' && denied.part.status).toBe('error')
  }, 40_000)

  test('added and disabled MCP servers show in status', async () => {
    const dir = path.join(root, 'mcp-added')
    fs.mkdirSync(dir, { recursive: true })
    await provider.getBackend().mcp!.addRemote({ directory: dir, name: 'roadie_pm_x_docs', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer t' } })
    expect(await provider.getBackend().mcp!.status({ directory: dir })).toEqual({ roadie_pm_x_docs: { status: 'connected' } })
    await provider.getBackend().mcp!.disconnect({ directory: dir, name: 'roadie_pm_x_docs' })
    expect(await provider.getBackend().mcp!.status({ directory: dir })).toEqual({ roadie_pm_x_docs: { status: 'disabled' } })
  })

  test('OpenCode-format commands and skills, plus opencode.json commands, list and run in Pi', async () => {
    const dir = path.join(root, 'cmd-project')
    fs.mkdirSync(path.join(dir, '.opencode', 'command'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'deploy-notes'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.opencode', 'command', 'shout.md'), '---\ndescription: Shout it\n---\nRUN_TOOL echo SHOUT-$ARGUMENTS\n')
    fs.writeFileSync(path.join(dir, '.claude', 'skills', 'deploy-notes', 'SKILL.md'), '---\nname: deploy-notes\ndescription: How we deploy\n---\nRUN_TOOL echo skill-loaded\n')
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ command: { whisper: { description: 'Whisper it', template: 'RUN_TOOL echo whisper-$ARGUMENTS' } } }))
    const listed = await provider.getBackend().catalog.commands!({ directory: dir })
    if (listed instanceof Error) throw listed
    expect(listed).toEqual(expect.arrayContaining([
      { name: 'shout', description: 'Shout it', source: 'command' },
      { name: 'whisper', description: 'Whisper it', source: 'command' },
      expect.objectContaining({ name: 'deploy-notes', source: 'skill' }),
    ]))
    const session = await provider.getBackend().sessions.create({ directory: dir })
    if (session instanceof Error) throw session
    const runCommand = async (command: string, args: string) => {
      const before = idleCount(session.id)
      expect(await provider.getBackend().sessions.command({ sessionId: session.id, directory: dir, command, arguments: args })).toBeUndefined()
      await until(() => (idleCount(session.id) > before ? true : undefined))
      const tool = events.findLast((e) => e.type === 'part' && e.part.kind === 'tool' && e.part.sessionId === session.id)
      return tool?.type === 'part' && tool.part.kind === 'tool' ? tool.part.output : undefined
    }
    expect(await runCommand('shout', 'hey')).toContain('SHOUT-hey')
    expect(await runCommand('whisper', 'psst')).toContain('whisper-psst')
    expect(await runCommand('deploy-notes', '')).toContain('skill-loaded')
    expect(await provider.getBackend().sessions.command({ sessionId: session.id, directory: dir, command: 'nope', arguments: '' })).toBeInstanceOf(Error)
  }, 60_000)

  test('fork at a user message keeps only the history before it; a workspace fork runs in the worktree', async () => {
    const dir = path.join(root, 'fork-src')
    const worktree = path.join(root, 'fork-wt')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(worktree, { recursive: true })
    const session = await provider.getBackend().sessions.create({ directory: dir })
    if (session instanceof Error) throw session
    for (const text of ['one', 'two', 'three']) {
      const before = idleCount(session.id)
      await provider.getBackend().sessions.prompt({ sessionId: session.id, directory: dir, parts: [{ kind: 'text', text }] })
      await until(() => (idleCount(session.id) > before ? true : undefined))
    }
    const history = await provider.getBackend().sessions.messages({ sessionId: session.id, directory: dir })
    if (history instanceof Error) throw history
    const userText = (h: typeof history) => h.flatMap((m) => (m.message.role === 'user' ? m.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])) : []))
    const second = history.find((m) => m.message.role === 'user' && userText([m])[0] === 'two')!.message.id

    const atMessage = await provider.getBackend().sessions.fork({ sessionId: session.id, directory: dir, messageId: second })
    if (atMessage instanceof Error) throw atMessage
    const forkedHistory = await provider.getBackend().sessions.messages({ sessionId: atMessage.id, directory: dir })
    if (forkedHistory instanceof Error) throw forkedHistory
    expect(userText(forkedHistory)).toEqual(['one'])
    expect(userText((await provider.getBackend().sessions.messages({ sessionId: session.id, directory: dir })) as typeof history)).toEqual(['one', 'two', 'three'])

    const bound = await provider.getBackend().sessions.fork({ sessionId: session.id, directory: dir, targetDirectory: worktree, targetProjectDirectory: dir })
    if (bound instanceof Error) throw bound
    expect(bound.directory).toBe(worktree)
    const before = idleCount(bound.id)
    await provider.getBackend().sessions.prompt({ sessionId: bound.id, directory: worktree, parts: [{ kind: 'text', text: 'RUN_TOOL pwd' }] })
    await until(() => (idleCount(bound.id) > before ? true : undefined))
    const tool = events.findLast((e) => e.type === 'part' && e.part.kind === 'tool' && e.part.sessionId === bound.id)
    expect(tool?.type === 'part' && tool.part.kind === 'tool' && tool.part.output?.trim()).toBe(worktree)
    expect(await provider.getBackend().sessions.fork({ sessionId: session.id, directory: dir, messageId: 'pi-user-1' })).toBeInstanceOf(Error)
  }, 60_000)

  test('tool shells get the scoped agent token and session id, never the bot database credentials', async () => {
    const saved = { url: process.env['ROADIE_DB_URL'], secret: process.env['ROADIE_AGENT_TOKEN_SECRET'] }
    process.env['ROADIE_DB_URL'] = 'libsql://secret-db'
    process.env['ROADIE_AGENT_TOKEN_SECRET'] = 'tok-secret'
    try {
      const shellProvider = new PiBackendProvider({ ...makeProvider().options })
      await listen(shellProvider)
      const dir = path.join(root, 'env-project')
      fs.mkdirSync(dir, { recursive: true })
      const session = await shellProvider.getBackend().sessions.create({ directory: dir })
      if (session instanceof Error) throw session
      const before = idleCount(session.id)
      await shellProvider.getBackend().sessions.prompt({
        sessionId: session.id,
        directory: dir,
        parts: [{ kind: 'text', text: 'RUN_TOOL echo "db=[$ROADIE_DB_URL] secret=[$ROADIE_AGENT_TOKEN_SECRET] sid=[$ROADIE_SESSION_ID] tok=[${ROADIE_AGENT_TOKEN%%.*}]"' }],
      })
      await until(() => (idleCount(session.id) > before ? true : undefined))
      const tool = events.findLast((e) => e.type === 'part' && e.part.kind === 'tool' && e.part.sessionId === session.id)
      const output = tool?.type === 'part' && tool.part.kind === 'tool' ? tool.part.output : ''
      expect(output).toContain('db=[] secret=[]')
      expect(output).toContain(`sid=[${session.id}]`)
      expect(output).toContain(`tok=[${session.id}]`)
      shellProvider.dispose()
    } finally {
      if (saved.url === undefined) delete process.env['ROADIE_DB_URL']
      else process.env['ROADIE_DB_URL'] = saved.url
      if (saved.secret === undefined) delete process.env['ROADIE_AGENT_TOKEN_SECRET']
      else process.env['ROADIE_AGENT_TOKEN_SECRET'] = saved.secret
    }
  }, 30_000)

  test('edits land in the file-edit log; Pi shrinks oversized images itself (images.autoResize, no Roadie plugin)', async () => {
    const logDir = path.join(root, 'edit-log')
    const editProvider = new PiBackendProvider({ ...makeProvider().options, fileEditLogDir: logDir })
    await listen(editProvider)
    const dir = path.join(root, 'edit-project')
    fs.mkdirSync(dir, { recursive: true })
    const sharp = (await import('sharp')).default
    await sharp({ create: { width: 3200, height: 2400, channels: 3, background: '#336699' } }).png().toFile(path.join(dir, 'big.png'))
    const session = await editProvider.getBackend().sessions.create({ directory: dir })
    if (session instanceof Error) throw session
    const run = async (text: string) => {
      const before = idleCount(session.id)
      await editProvider.getBackend().sessions.prompt({ sessionId: session.id, directory: dir, parts: [{ kind: 'text', text }] })
      await until(() => (idleCount(session.id) > before ? true : undefined))
    }
    await run('CALL_TOOL write {"path":"notes.txt","content":"hi"}')
    expect(loadFileEditEvents({ dataDir: logDir })).toEqual([expect.objectContaining({ sessionId: session.id, file: path.join(dir, 'notes.txt'), tool: 'write' })])
    const bodiesBefore = server.bodies.length
    await run('CALL_TOOL read {"path":"big.png"}')
    const sent = server.bodies.slice(bodiesBefore).join('\n')
    const image = /data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/.exec(sent)?.[1] ?? /"(iVBOR[A-Za-z0-9+/=]{100,}|\/9j\/[A-Za-z0-9+/=]{100,})"/.exec(sent)?.[1]
    expect(image).toBeTruthy()
    const meta = await sharp(Buffer.from(image!, 'base64')).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2000)
    editProvider.dispose()
  }, 40_000)

  test('the model hears the git branch once, and again when it changes; titles come from an isolated request', async () => {
    const dir = path.join(root, 'git-project')
    fs.mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
    const session = await provider.getBackend().sessions.create({ directory: dir })
    if (session instanceof Error) throw session
    const userTexts = async (text: string) => {
      const before = idleCount(session.id)
      const bodies = server.bodies.length
      await provider.getBackend().sessions.prompt({ sessionId: session.id, directory: dir, parts: [{ kind: 'text', text }] })
      await until(() => (idleCount(session.id) > before ? true : undefined))
      const body = JSON.parse(server.bodies[bodies]!) as { messages: Array<{ role: string; content: unknown }> }
      return JSON.stringify(body.messages.findLast((m) => m.role === 'user')?.content)
    }
    expect(await userTexts('first')).toContain('[current git branch is main]')
    expect(await userTexts('second')).not.toContain('current git branch')
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir })
    expect(await userTexts('third')).toContain('[current git branch is feature]')

    const bodies = server.bodies.length
    const title = await provider.getBackend().sessions.generateTitle!({ directory: dir, prompt: 'Fix the login flow' })
    expect(title).toBe('hello from the fake model')
    const request = JSON.parse(server.bodies[bodies]!) as { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }
    expect(JSON.stringify(request.messages[0]?.content)).toContain('Generate a concise descriptive chat title')
    expect(request.tools ?? []).toEqual([])
  }, 40_000)

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
