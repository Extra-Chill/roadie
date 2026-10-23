// The native stateless MCP client end to end: a real pi process whose Roadie
// extension registers a person-scoped 2026-07-28 server natively, calls its
// tool, and answers a form elicitation through the backend's replyForm.
// Skipped when no `pi` binary is available (set ROADIE_PI_BIN), like
// backend.e2e.test.ts.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { AgentEvent } from '../events.js'
import { PiBackendProvider } from './backend.js'
import { fakeModelsJson, startFakeModelServer } from './fake-model-server.js'
import { FORM_STATE, startFakeNativeMcpServer } from './fake-native-mcp-server.js'
import { PERSON_MCP_TOOL_GLOB, personMcpScope, personMcpServerName } from '../../person-mcp.js'
import { findPi } from './find-pi.js'

const bin = findPi()

describe.skipIf(!bin)('native 2026-07-28 MCP over real pi processes', () => {
  let server: Awaited<ReturnType<typeof startFakeModelServer>>
  let root: string
  let project: string
  const events: AgentEvent[] = []
  const providers: PiBackendProvider[] = []
  const controller = new AbortController()

  /** A provider wired to the fake model; its events join the shared log. */
  async function makeProvider({ formTimeoutMs }: { formTimeoutMs?: number } = {}) {
    const provider = new PiBackendProvider({
      bin: bin!,
      sessionDir: path.join(root, 'sessions'),
      model: 'fake/fake-1',
      formTimeoutMs,
      env: { PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1' },
    })
    providers.push(provider)
    const stream = await provider.subscribeEvents({ signal: controller.signal })
    void (async () => {
      for await (const item of stream) events.push(...item.events)
    })()
    return provider
  }

  /** Register a person-scoped remote on the provider and create a session whose rules allow only that person's scope. */
  async function makeSessionWithFormServer(provider: PiBackendProvider, name: string, url: string, personKey = 'wp:1') {
    const backend = provider.getBackend()
    const added = await backend.mcp?.addRemote({ directory: project, name, url, headers: { Authorization: 'Bearer secret-token' }, owner: personKey })
    expect(added).not.toBeInstanceOf(Error)
    // Last match wins: person MCP is denied by default, the asking person's
    // scope is allowed — the form flow must work under exactly this pair.
    const session = await backend.sessions.create({ directory: project, title: 'native mcp', permission: [
      { permission: PERSON_MCP_TOOL_GLOB, pattern: '*', action: 'deny' },
      { permission: `${personMcpScope(personKey)}_*`, pattern: '*', action: 'allow' },
    ] })
    expect(session).not.toBeInstanceOf(Error)
    return session
  }

  async function until<T>(find: () => T | undefined, ms = 60_000): Promise<T> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const found = find()
      if (found !== undefined) return found
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('timed out')
  }

  const idleCount = (sessionId: string) => events.filter((e) => e.type === 'idle' && e.sessionId === sessionId).length

  /** Prompt, wait for the run to finish, and return the native tool's output. */
  async function runToolAndGetOutput(backend: ReturnType<PiBackendProvider['getBackend']>, sessionId: string, directory: string, toolName: string, argsJson: string): Promise<string> {
    const before = idleCount(sessionId)
    await backend.sessions.prompt({ sessionId, directory, parts: [{ kind: 'text', text: `CALL_TOOL ${toolName} ${argsJson}` }] })
    await until(() => (idleCount(sessionId) > before ? true : undefined))
    const part = events.find((e) => e.type === 'part' && e.part.kind === 'tool' && e.part.tool === toolName && e.part.sessionId === sessionId && e.part.endedAt)
    // A failed call carries its explanation in `error` instead of `output`.
    const output = part?.type === 'part' && part.part.kind === 'tool' ? (part.part.output ?? part.part.error ?? '') : ''
    expect(output).not.toBe('')
    return output
  }

  beforeAll(async () => {
    server = await startFakeModelServer()
    root = fs.realpathSync(fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'roadie-pi-native-mcp-')))
    project = path.join(root, 'project')
    fs.mkdirSync(project)
    fs.mkdirSync(path.join(root, 'agent'))
    fs.writeFileSync(path.join(root, 'agent', 'models.json'), fakeModelsJson(server.baseUrl))
  })

  afterAll(async () => {
    controller.abort()
    for (const provider of providers) provider.dispose()
    await server?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('a form is asked, refused for another person, accepted by its person, and continued with the envelope', async () => {
    const mcp = await startFakeNativeMcpServer()
    try {
      const provider = await makeProvider({ formTimeoutMs: 60_000 })
      const backend = provider.getBackend()
      const personKey = 'wp:1'
      const serverName = personMcpServerName({ personKey, name: 'fakeproof' })
      const toolName = `mcp__${serverName}__approve_buy`
      const session = await makeSessionWithFormServer(provider, serverName, mcp.baseUrl, personKey)
      if (session instanceof Error) throw session
      const before = idleCount(session.id)
      void backend.sessions.prompt({ sessionId: session.id, directory: project, parts: [{ kind: 'text', text: `CALL_TOOL ${toolName} {"plan":"pro"}` }] })

      const form = await until(() => {
        const found = events.find((e) => e.type === 'form.asked' && e.request.sessionId === session.id)
        return found?.type === 'form.asked' ? found.request : undefined
      })
      // The server's message verbatim, with the server and tool it came from.
      expect(form.message).toBe('Approve buying the pro plan?')
      expect(form.server).toBe(serverName)
      expect(form.tool).toBe('approve_buy')
      expect((form.schema as { properties?: Record<string, unknown> }).properties?.confirm).toBeTruthy()

      // Consent integrity: another person (or nobody) cannot answer, and the
      // form survives the refusal for its person.
      const wrongPerson = await backend.sessions.replyForm?.({ requestId: form.id, directory: project, action: 'accept', content: { confirm: true }, personKey: 'wp:2' })
      expect(wrongPerson).toBeInstanceOf(Error)
      const nobody = await backend.sessions.replyForm?.({ requestId: form.id, directory: project, action: 'decline' })
      expect(nobody).toBeInstanceOf(Error)
      const declinedAsOwner = await backend.sessions.replyForm?.({ requestId: form.id, directory: project, action: 'accept', content: { confirm: true }, personKey })
      expect(declinedAsOwner).toBeUndefined()

      await until(() => (idleCount(session.id) > before ? true : undefined))
      const output = await (async () => {
        const part = events.find((e) => e.type === 'part' && e.part.kind === 'tool' && e.part.tool === toolName && e.part.sessionId === session.id && e.part.endedAt)
        return part?.type === 'part' && part.part.kind === 'tool' ? part.part.output : ''
      })()
      expect(output).toContain('bought pro')
      // The decision came through the form flow, not permission prompts.
      expect(events.some((e) => e.type === 'permission.asked' && e.request.sessionId === session.id)).toBe(false)

      // The 2026-07-28 envelope: meta on every request, headers for audit.
      const discover = mcp.log.find((r) => r.method === 'server/discover')
      expect(discover).toBeDefined()
      expect(discover!.headers['mcp-protocol-version']).toBe('2026-07-28')
      expect(discover!.headers['mcp-method']).toBe('server/discover')
      expect(discover!.headers['authorization']).toBe('Bearer secret-token')
      expect(discover!.params._meta).toMatchObject({
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
        'io.modelcontextprotocol/clientInfo': { name: 'roadie', version: expect.any(String) },
      })
      const calls = mcp.log.filter((r) => r.method === 'tools/call')
      expect(calls).toHaveLength(2)
      expect(calls[0]!.headers['mcp-name']).toBe('approve_buy')
      expect(calls[0]!.headers['mcp-method']).toBe('tools/call')
      expect(calls[0]!.params.arguments).toEqual({ plan: 'pro' })
      expect(calls[0]!.params._meta).toMatchObject({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28' })
      expect(calls[1]!.params.inputResponses).toEqual({ cfg: { action: 'accept', content: { confirm: true } } })
      expect(calls[1]!.params.requestState).toBe(FORM_STATE)
    } finally {
      await mcp.close()
    }
  }, 120_000)

  test('a decline reaches the server and the tool result reports it', async () => {
    const mcp = await startFakeNativeMcpServer()
    try {
      const provider = await makeProvider({ formTimeoutMs: 60_000 })
      const backend = provider.getBackend()
      const personKey = 'wp:decline'
      const serverName = personMcpServerName({ personKey, name: 'fakeproof' })
      const toolName = `mcp__${serverName}__approve_buy`
      const session = await makeSessionWithFormServer(provider, serverName, mcp.baseUrl, personKey)
      if (session instanceof Error) throw session
      const answered = runToolAndGetOutput(backend, session.id, project, toolName, '{"plan":"basic"}')
      const form = await until(() => {
        const found = events.find((e) => e.type === 'form.asked' && e.request.sessionId === session.id)
        return found?.type === 'form.asked' ? found.request : undefined
      })
      await backend.sessions.replyForm?.({ requestId: form.id, directory: project, action: 'decline', personKey })
      const output = await answered
      expect(output).toContain('declined')
      expect(mcp.log.filter((r) => r.method === 'tools/call')[1]!.params.inputResponses).toEqual({ cfg: { action: 'decline' } })
    } finally {
      await mcp.close()
    }
  }, 120_000)

  test('a form timeout answers cancel with no person and the tool result says nobody answered', async () => {
    const mcp = await startFakeNativeMcpServer()
    try {
      const provider = await makeProvider({ formTimeoutMs: 1_500 })
      const backend = provider.getBackend()
      const personKey = 'wp:timeout'
      const serverName = personMcpServerName({ personKey, name: 'fakeproof' })
      const toolName = `mcp__${serverName}__approve_buy`
      const session = await makeSessionWithFormServer(provider, serverName, mcp.baseUrl, personKey)
      if (session instanceof Error) throw session
      const output = await runToolAndGetOutput(backend, session.id, project, toolName, '{"plan":"pro"}')
      expect(output).toContain('cancelled')
      expect(output).toContain('no answer')
      const continuation = mcp.log.filter((r) => r.method === 'tools/call')[1]
      expect(continuation!.params.inputResponses).toEqual({ cfg: { action: 'cancel' } })
      expect(continuation!.params.requestState).toBe(FORM_STATE)
    } finally {
      await mcp.close()
    }
  }, 120_000)

  test('an unrenderable form is cancelled without asking anyone', async () => {
    const mcp = await startFakeNativeMcpServer()
    try {
      const provider = await makeProvider({ formTimeoutMs: 60_000 })
      const backend = provider.getBackend()
      const personKey = 'wp:impossible'
      const serverName = personMcpServerName({ personKey, name: 'fakeproof' })
      const toolName = `mcp__${serverName}__impossible_form`
      const session = await makeSessionWithFormServer(provider, serverName, mcp.baseUrl, personKey)
      if (session instanceof Error) throw session
      const output = await runToolAndGetOutput(backend, session.id, project, toolName, '{}')
      // No dialog was surfaced; the server was told cancel.
      expect(events.some((e) => e.type === 'form.asked' && e.request.sessionId === session.id)).toBe(false)
      expect(output).toContain('form was cancel')
      expect(output).toContain('cancelled because')
      expect(mcp.log.filter((r) => r.method === 'tools/call')[1]!.params.inputResponses).toEqual({ cfg: { action: 'cancel' } })
    } finally {
      await mcp.close()
    }
  }, 120_000)

  test('a person server without the revision keeps the built-in client (no native form)', async () => {
    // A closed port: discover fails, so the extension must not register
    // native tools and the form flow never starts.
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as { port: number }
    blocker.close()
    const deadUrl = `http://127.0.0.1:${port}`
    const provider = await makeProvider({ formTimeoutMs: 60_000 })
    const backend = provider.getBackend()
    const personKey = 'wp:builtin'
    const serverName = personMcpServerName({ personKey, name: 'stale' })
    const toolName = `mcp__${serverName}__approve_buy`
    const session = await makeSessionWithFormServer(provider, serverName, deadUrl, personKey)
    if (session instanceof Error) throw session
    const output = await runToolAndGetOutput(backend, session.id, project, toolName, '{"plan":"pro"}')
    expect(events.some((e) => e.type === 'form.asked' && e.request.sessionId === session.id)).toBe(false)
    // The built-in client cannot reach the tool either: the call errors instead of running.
    expect(output.toLowerCase()).toMatch(/error|failed|not found|unknown/)
  }, 120_000)
})
