// The Pi backend over a stubbed rpc process: noReply appends, agent
// definitions reach the turn (system prompt, model, permission rules),
// variants drive the thinking level, summarize honours its model, abort
// dismisses a session's open prompts even when the process is gone, prompts
// always ask Pi to queue, and busy lasts until agent_settled.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { AgentRequestError } from '../types.js'
import type { AgentEvent } from '../events.js'
import { PiBackendProvider } from './backend.js'
import { PiEventTranslator } from './events.js'

type Recorded = Record<string, unknown>

function workspace(): string {
  return fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pi-backend-'))
}

type ProviderInternals = {
  sessions: Map<string, unknown>
  pendingPermissions: Map<string, { uiId: string; sessionId: string; permission: string; patterns: string[]; session: unknown }>
  pendingQuestions: Map<string, { sessionId: string; session: unknown }>
  subscribers: Set<(event: { events: AgentEvent[] }) => void>
  onUiRequest(s: unknown, r: unknown): void
  onRecord(s: unknown, r: unknown): void
}

function internalsOf(provider: PiBackendProvider): ProviderInternals {
  return provider as unknown as ProviderInternals
}

function collectEvents(provider: PiBackendProvider): AgentEvent[] {
  const events: AgentEvent[] = []
  internalsOf(provider).subscribers.add((event) => events.push(...event.events))
  return events
}

describe('PiBackend sessions.prompt over a stubbed rpc process', () => {
  const root = workspace()
  const provider = new PiBackendProvider({ bin: 'pi', sessionDir: path.join(root, 'sessions'), idleTimeoutMs: 0 })

  function stubProcess({ disposition = 'handled', exited = false, fail = [] }: { disposition?: string; exited?: boolean; fail?: string[] } = {}) {
    const requests: Recorded[] = []
    const sent: Recorded[] = []
    return {
      requests,
      sent,
      exited,
      request: async (command: Recorded) => {
        requests.push(command)
        if (fail.includes(String(command.type))) return new Error(`stub failure: ${String(command.type)}`)
        if (command.type === 'prompt') return { disposition }
        if (command.type === 'set_model') return { provider: command.provider, id: command.modelId }
        if (command.type === 'set_thinking_level') return {}
        if (command.type === 'get_commands') return { commands: [{ name: 'shout', source: 'prompt', description: 'Shout' }] }
        return undefined
      },
      send: (record: Recorded) => {
        sent.push(record)
      },
      kill: () => {},
    }
  }

  function stubSession({ disposition, model, directory, thinking, exited, fail }: { disposition?: string; model?: { provider: string; id: string }; directory?: string; thinking?: string; exited?: boolean; fail?: string[] } = {}) {
    const dir = directory ?? path.join(root, 'plain')
    fs.mkdirSync(dir, { recursive: true })
    const process = stubProcess({ disposition, exited, fail })
    const session = {
      id: 'ses-pi',
      directory: dir,
      sessionFile: path.join(root, 'ses-pi.jsonl'),
      systemFile: path.join(root, 'system.md'),
      mcpFile: path.join(root, 'mcp.json'),
      shellEnvFile: path.join(root, 'shell-env.json'),
      process,
      translator: new PiEventTranslator('ses-pi'),
      title: '',
      createdAt: 1,
      updatedAt: 1,
      busy: false,
      idleWaiters: [] as Array<() => void>,
      ...(model && { model }),
      ...(thinking && { thinking, defaultThinking: thinking }),
    }
    ;(provider as unknown as { sessions: Map<string, unknown> }).sessions.set(session.id, session)
    return { session, process, directory: dir }
  }

  function writeAgent(directory: string, name: string, frontmatter: string[], body: string[]) {
    fs.mkdirSync(path.join(directory, '.opencode', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(directory, '.opencode', 'agents', `${name}.md`), [`---`, ...frontmatter, `---`, ...body, ''].join('\n'))
  }

  test('noReply records the message through the append command instead of a prompt', async () => {
    const { process } = stubSession()
    const result = await provider.getBackend().sessions.prompt({
      sessionId: 'ses-pi', directory: path.join(root, 'plain'), noReply: true,
      parts: [{ kind: 'text', text: 'The user prefers concise answers.' }],
    })
    expect(result).toBeUndefined()
    expect(process.requests.map((request) => request.type)).toEqual(['prompt'])
    const command = String(process.requests[0]!.message)
    expect(command.startsWith('/roadie:append ')).toBe(true)
    expect(JSON.parse(command.slice('/roadie:append '.length))).toEqual({ text: 'The user prefers concise answers.', images: [] })
  })

  test('an empty noReply (an agent switch) records nothing', async () => {
    const { process } = stubSession()
    await provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory: path.join(root, 'plain'), noReply: true, parts: [] })
    expect(process.requests).toEqual([])
  })

  test('when the append command is missing, the accidental turn is aborted and the request errors', async () => {
    const { process } = stubSession({ disposition: 'started' })
    const result = await provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory: path.join(root, 'plain'), noReply: true, parts: [{ kind: 'text', text: 'context' }] })
    expect(result).toBeInstanceOf(AgentRequestError)
    expect(process.requests.map((request) => request.type)).toEqual(['prompt', 'abort'])
  })

  test('an unknown agent is a clear error, not a silent default', async () => {
    const { process } = stubSession()
    const result = await provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory: path.join(root, 'plain'), parts: [{ kind: 'text', text: 'hi' }], agent: 'nope' })
    expect(result).toBeInstanceOf(AgentRequestError)
    if (!(result instanceof AgentRequestError)) throw new Error('unreachable')
    expect(result.message).toContain('nope')
    expect(process.requests).toEqual([])
  })

  test('a selected agent contributes its system prompt and permission rules to the turn', async () => {
    const directory = path.join(root, 'agent-system')
    writeAgent(directory, 'reviewer', ['description: Reviews only', 'mode: primary', 'model: fake/fake-1', 'permission:', '  edit: deny'], ['REVIEWER_SYSTEM_MARKER'])
    const { session, process } = stubSession({ directory, model: { provider: 'fake', id: 'fake-1' } })
    const result = await provider.getBackend().sessions.prompt({
      sessionId: 'ses-pi', directory, parts: [{ kind: 'text', text: 'hi' }], system: 'ROADIE_TURN_SYSTEM', agent: 'reviewer',
    })
    expect(result).toBeUndefined()
    expect(fs.readFileSync(session.systemFile, 'utf8')).toBe('ROADIE_TURN_SYSTEM\n\nREVIEWER_SYSTEM_MARKER')
    expect(process.requests.map((request) => request.type)).toEqual(['prompt'])
    expect((provider as unknown as { turnAgentRules: Map<string, Array<{ permission: string; action: string }>> }).turnAgentRules.get('ses-pi'))
      .toEqual([{ permission: 'edit', pattern: '*', action: 'deny' }])
  })

  test('the agent model applies when the turn names none; an explicit model wins', async () => {
    const directory = path.join(root, 'agent-model')
    writeAgent(directory, 'fast', ['mode: primary', 'model: fake/fake-fast'], ['Be quick.'])
    const first = stubSession({ directory, model: { provider: 'fake', id: 'fake-1' } })
    await provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory, parts: [{ kind: 'text', text: 'hi' }], agent: 'fast' })
    expect(first.process.requests).toEqual([
      { type: 'set_model', provider: 'fake', modelId: 'fake-fast' },
      { type: 'prompt', message: 'hi', streamingBehavior: 'steer' },
    ])
    const second = stubSession({ directory, model: { provider: 'fake', id: 'fake-1' } })
    await provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory, parts: [{ kind: 'text', text: 'hi' }], agent: 'fast', model: { providerId: 'fake', modelId: 'fake-2' } })
    expect(second.process.requests.filter((request) => request.type === 'set_model')).toEqual([
      { type: 'set_model', provider: 'fake', modelId: 'fake-2' },
    ])
  })

  test('agent rules guard tool calls, and the session rules still win over them', async () => {
    const { session } = stubSession()
    ;(provider as unknown as { turnAgentRules: Map<string, Array<{ permission: string; pattern: string; action: string }>> }).turnAgentRules.set('ses-pi', [
      { permission: 'bash', pattern: '*', action: 'ask' },
    ])
    const call = JSON.stringify({ tool: 'bash', callId: 'call-1', input: { command: 'git push' }, cwd: path.join(root, 'plain') })
    const onUiRequest = (provider as unknown as { onUiRequest(s: unknown, r: unknown): void }).onUiRequest.bind(provider)
    onUiRequest(session, { type: 'extension_ui_request', id: 'ui-agent-ask', method: 'confirm', title: 'roadie:permission', message: call })
    expect([...(provider as unknown as { pendingPermissions: Map<string, { permission: string }> }).pendingPermissions.values()].map((pending) => pending.permission)).toEqual(['bash'])

    ;(provider as unknown as { permissionRules: Map<string, Array<{ permission: string; pattern: string; action: string }>> }).permissionRules.set('ses-pi', [
      { permission: 'bash', pattern: '*', action: 'allow' },
    ])
    onUiRequest(session, { type: 'extension_ui_request', id: 'ui-session-allow', method: 'confirm', title: 'roadie:permission', message: call })
    expect(session.process.sent).toEqual([{ type: 'extension_ui_response', id: 'ui-session-allow', confirmed: true }])
  })

  test('command passes the agent through to the same turn handling', async () => {
    const directory = path.join(root, 'agent-command')
    stubSession({ directory })
    const result = await provider.getBackend().sessions.command({ sessionId: 'ses-pi', directory, command: 'shout', arguments: 'hey', agent: 'plan' })
    expect(result).toBeUndefined()
    expect((provider as unknown as { turnAgentRules: Map<string, unknown> }).turnAgentRules.get('ses-pi')).toEqual([
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: '*', action: 'ask' },
    ])
  })

  test('catalog.agents lists the built-ins plus the project agents', async () => {
    const directory = path.join(root, 'agent-catalog')
    writeAgent(directory, 'reviewer', ['description: Reviews only', 'mode: primary'], ['Marker.'])
    const agents = await provider.getBackend().catalog.agents({ directory })
    if (agents instanceof Error) throw agents
    expect(agents.map((agent) => agent.name)).toEqual(['build', 'plan', 'general', 'explore', 'scout', 'reviewer'])
    expect(agents.find((agent) => agent.name === 'reviewer')).toEqual({ name: 'reviewer', description: 'Reviews only', mode: 'primary' })
  })
})

describe('PiBackend thinking variants over a stubbed rpc process', () => {
  const root = workspace()
  const provider = new PiBackendProvider({ bin: 'pi', sessionDir: path.join(root, 'sessions'), idleTimeoutMs: 0 })

  test('a variant sets the level; clearing it returns to the level Pi started with', async () => {
    const { session, process } = stubSession2({ thinking: 'medium' })
    const prompt = (variant?: string) => provider.getBackend().sessions.prompt({
      sessionId: 'ses-pi', directory: path.join(root, 'plain'),
      parts: [{ kind: 'text', text: 'hi' }], ...(variant !== undefined && { variant }),
    })
    await prompt('high')
    expect(process.requests.filter((request) => request.type === 'set_thinking_level')).toEqual([
      { type: 'set_thinking_level', level: 'high' },
    ])
    expect(session.thinking).toBe('high')
    await prompt()
    expect(process.requests.filter((request) => request.type === 'set_thinking_level')).toEqual([
      { type: 'set_thinking_level', level: 'high' },
      { type: 'set_thinking_level', level: 'medium' },
    ])
    expect(session.thinking).toBe('medium')
    // Already at Pi's default: clearing again changes nothing.
    await prompt()
    expect(process.requests.filter((request) => request.type === 'set_thinking_level')).toHaveLength(2)
  })

  test('the same variant twice sends one set, and an unknown variant is ignored', async () => {
    const { session, process } = stubSession2({ thinking: 'low' })
    await provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory: path.join(root, 'plain'), parts: [{ kind: 'text', text: 'hi' }], variant: 'high' })
    await provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory: path.join(root, 'plain'), parts: [{ kind: 'text', text: 'hi' }], variant: 'high' })
    expect(process.requests.filter((request) => request.type === 'set_thinking_level')).toEqual([
      { type: 'set_thinking_level', level: 'high' },
    ])
    await provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory: path.join(root, 'plain'), parts: [{ kind: 'text', text: 'hi' }], variant: 'bogus' })
    expect(process.requests.filter((request) => request.type === 'set_thinking_level')).toHaveLength(1)
    expect(session.thinking).toBe('high')
  })

  function stubSession2(options: { thinking?: string }) {
    const process = {
      requests: [] as Recorded[],
      exited: false,
      request: async (command: Recorded) => {
        process.requests.push(command)
        if (command.type === 'set_thinking_level' || command.type === 'set_model') return {}
        return undefined
      },
      send: () => {},
      kill: () => {},
    }
    const dir = path.join(root, 'plain')
    fs.mkdirSync(dir, { recursive: true })
    const session = {
      id: 'ses-pi', directory: dir, sessionFile: path.join(root, 'ses-pi.jsonl'),
      systemFile: path.join(root, 'ses-pi.system.md'), mcpFile: path.join(root, 'ses-pi.mcp.json'),
      shellEnvFile: path.join(root, 'ses-pi.shell-env.json'),
      process, translator: new PiEventTranslator('ses-pi'), title: '', createdAt: 1, updatedAt: 1, busy: false,
      idleWaiters: [] as Array<() => void>,
      ...(options.thinking && { thinking: options.thinking, defaultThinking: options.thinking }),
    }
    ;(provider as unknown as { sessions: Map<string, unknown> }).sessions.set(session.id, session)
    return { session, process }
  }
})

describe('PiBackend sessions.summarize over a stubbed rpc process', () => {
  const root = workspace()
  const provider = new PiBackendProvider({ bin: 'pi', sessionDir: path.join(root, 'sessions'), idleTimeoutMs: 0 })

  test('compact runs on the requested model, then the session gets its own model back', async () => {
    const { process } = stubSession({ model: { provider: 'fake', id: 'fake-1' } })
    const result = await provider.getBackend().sessions.summarize!({
      sessionId: 'ses-pi', directory: path.join(root, 'plain'), model: { providerId: 'fake', modelId: 'fake-2' },
    })
    expect(result).toBeUndefined()
    expect(process.requests.map((request) => [request.type, request.provider, request.modelId])).toEqual([
      ['set_model', 'fake', 'fake-2'],
      ['compact', undefined, undefined],
      ['set_model', 'fake', 'fake-1'],
    ])
  })

  test('no model switch when the session already runs the requested model', async () => {
    const { process } = stubSession({ model: { provider: 'fake', id: 'fake-1' } })
    const result = await provider.getBackend().sessions.summarize!({
      sessionId: 'ses-pi', directory: path.join(root, 'plain'), model: { providerId: 'fake', modelId: 'fake-1' },
    })
    expect(result).toBeUndefined()
    expect(process.requests.map((request) => request.type)).toEqual(['compact'])
  })

  test('a failed compaction restores the session model and reports the error', async () => {
    const { process } = stubSession({ model: { provider: 'fake', id: 'fake-1' }, fail: ['compact'] })
    const result = await provider.getBackend().sessions.summarize!({
      sessionId: 'ses-pi', directory: path.join(root, 'plain'), model: { providerId: 'fake', modelId: 'fake-2' },
    })
    expect(result).toBeInstanceOf(AgentRequestError)
    expect(process.requests.map((request) => [request.type, request.modelId])).toEqual([
      ['set_model', 'fake-2'],
      ['compact', undefined],
      ['set_model', 'fake-1'],
    ])
  })

  function stubSession(options: { model?: { provider: string; id: string }; fail?: string[] }) {
    const process = {
      requests: [] as Recorded[],
      exited: false,
      request: async (command: Recorded) => {
        process.requests.push(command)
        if (options.fail?.includes(String(command.type))) return new Error(`stub failure: ${String(command.type)}`)
        if (command.type === 'set_model') return { provider: command.provider, id: command.modelId }
        return undefined
      },
      send: () => {},
      kill: () => {},
    }
    const dir = path.join(root, 'plain')
    fs.mkdirSync(dir, { recursive: true })
    const session = {
      id: 'ses-pi', directory: dir, sessionFile: path.join(root, 'ses-pi.jsonl'),
      systemFile: path.join(root, 'ses-pi.system.md'), mcpFile: path.join(root, 'ses-pi.mcp.json'),
      shellEnvFile: path.join(root, 'ses-pi.shell-env.json'),
      process, translator: new PiEventTranslator('ses-pi'), title: '', createdAt: 1, updatedAt: 1, busy: false,
      idleWaiters: [] as Array<() => void>,
      ...(options.model && { model: options.model }),
    }
    ;(provider as unknown as { sessions: Map<string, unknown> }).sessions.set(session.id, session)
    return { session, process }
  }
})

describe('PiBackend sessions.abort over a stubbed rpc process', () => {
  const root = workspace()
  const provider = new PiBackendProvider({ bin: 'pi', sessionDir: path.join(root, 'sessions'), idleTimeoutMs: 0 })

  function stubSession({ exited = false }: { exited?: boolean } = {}) {
    const process = {
      requests: [] as Recorded[],
      sent: [] as Recorded[],
      exited,
      request: async (command: Recorded) => {
        process.requests.push(command)
        return command.type === 'abort' ? undefined : new Error('stub: unexpected request')
      },
      send: (record: Recorded) => {
        process.sent.push(record)
      },
      kill: () => {},
    }
    const dir = path.join(root, 'plain')
    fs.mkdirSync(dir, { recursive: true })
    const session = {
      id: 'ses-pi', directory: dir, sessionFile: '', systemFile: '', mcpFile: '', shellEnvFile: '',
      process, translator: new PiEventTranslator('ses-pi'), title: '', createdAt: 1, updatedAt: 1, busy: false,
      idleWaiters: [] as Array<() => void>,
    }
    internalsOf(provider).sessions.set(session.id, session)
    return { session, process }
  }

  test('a running session is aborted through its process', async () => {
    const { process } = stubSession()
    const result = await provider.getBackend().sessions.abort({ sessionId: 'ses-pi' })
    expect(result).toBeUndefined()
    expect(process.requests).toEqual([{ type: 'abort' }])
  })

  test('a dead process is not asked to abort, and its open permission ask is rejected', async () => {
    const { session, process } = stubSession({ exited: true })
    const internals = internalsOf(provider)
    internals.pendingPermissions.set('ui-dead', { uiId: 'ui-dead', sessionId: 'ses-pi', permission: 'bash', patterns: ['git push'], session })
    const events = collectEvents(provider)
    const result = await provider.getBackend().sessions.abort({ sessionId: 'ses-pi' })
    expect(result).toBeUndefined()
    expect(process.requests).toEqual([])
    expect(internals.pendingPermissions.size).toBe(0)
    expect(process.sent).toEqual([{ type: 'extension_ui_response', id: 'ui-dead', confirmed: false }])
    expect(events.some((event) => event.type === 'permission.replied' && event.requestId === 'ui-dead' && event.reply === 'reject')).toBe(true)
  })

  test('a live process keeps its pending permission across abort', async () => {
    const { session, process } = stubSession()
    const internals = internalsOf(provider)
    internals.pendingPermissions.set('ui-live', { uiId: 'ui-live', sessionId: 'ses-pi', permission: 'bash', patterns: ['git push'], session })
    await provider.getBackend().sessions.abort({ sessionId: 'ses-pi' })
    expect(process.requests).toEqual([{ type: 'abort' }])
    expect(internals.pendingPermissions.has('ui-live')).toBe(true)
  })

  test('a session that is gone still dismisses the questions it left pending', async () => {
    const { session, process } = stubSession()
    const internals = internalsOf(provider)
    internals.sessions.delete('ses-pi')
    internals.pendingQuestions.set('ui-question', { sessionId: 'ses-pi', session })
    const events = collectEvents(provider)
    const result = await provider.getBackend().sessions.abort({ sessionId: 'ses-pi' })
    expect(result).toBeUndefined()
    expect(internals.pendingQuestions.size).toBe(0)
    expect(process.sent).toEqual([{ type: 'extension_ui_response', id: 'ui-question', cancelled: true }])
    expect(events.some((event) => event.type === 'question.rejected' && event.requestId === 'ui-question')).toBe(true)
  })
})

describe('PiBackend busy follows Pi\'s active run over a stubbed rpc process', () => {
  const root = workspace()
  const endedTurns: string[] = []
  const provider = new PiBackendProvider({
    bin: 'pi',
    sessionDir: path.join(root, 'sessions'),
    idleTimeoutMs: 0,
    pool: { issueKey: () => 'pool-key', revokeKey: () => {}, endTurn: (sessionId) => endedTurns.push(sessionId) },
  })

  function stubSession() {
    const process = {
      requests: [] as Recorded[],
      exited: false,
      request: async (command: Recorded) => {
        process.requests.push(command)
        if (command.type === 'prompt') {
          return { disposition: String(command.message ?? '').startsWith('/roadie:append') ? 'handled' : 'started' }
        }
        return undefined
      },
      send: () => {},
      kill: () => {},
    }
    const dir = path.join(root, 'busy')
    fs.mkdirSync(dir, { recursive: true })
    const session = {
      id: 'ses-pi', directory: dir, sessionFile: path.join(root, 'ses-pi.jsonl'),
      systemFile: path.join(root, 'ses-pi.system.md'), mcpFile: path.join(root, 'ses-pi.mcp.json'),
      shellEnvFile: path.join(root, 'ses-pi.shell-env.json'),
      process, translator: new PiEventTranslator('ses-pi'), title: '', createdAt: 1, updatedAt: 1, busy: false,
      idleWaiters: [] as Array<() => void>,
    }
    internalsOf(provider).sessions.set(session.id, session)
    return { session, process, directory: dir }
  }

  const prompt = (text: string, directory: string) =>
    provider.getBackend().sessions.prompt({ sessionId: 'ses-pi', directory, parts: [{ kind: 'text', text }] })

  test('every prompt asks Pi to queue and steers, so a busy-session prompt lands at the next tool boundary and one sent while a run settles is not rejected', async () => {
    const { session, process, directory } = stubSession()
    const onRecord = (record: Recorded) => internalsOf(provider).onRecord(session, record)
    let idle = false
    session.idleWaiters.push(() => { idle = true })

    expect(await prompt('one', directory)).toBeUndefined()
    onRecord({ type: 'agent_start' })
    expect(session.busy).toBe(true)
    onRecord({ type: 'agent_end' })
    // agent_end is not idle: Pi may still retry, compact or run queued
    // continuations, and rejects a prompt without streamingBehavior (#327).
    expect(session.busy).toBe(true)
    expect(idle).toBe(false)
    expect(endedTurns).toEqual([])
    expect(await prompt('two', directory)).toBeUndefined()

    onRecord({ type: 'agent_settled' })
    expect(session.busy).toBe(false)
    expect(idle).toBe(true)
    expect(endedTurns).toEqual(['ses-pi'])
    expect(await prompt('three', directory)).toBeUndefined()

    expect(process.requests.filter((request) => request.type === 'prompt')).toEqual([
      { type: 'prompt', message: 'one', streamingBehavior: 'steer' },
      { type: 'prompt', message: 'two', streamingBehavior: 'steer' },
      { type: 'prompt', message: 'three', streamingBehavior: 'steer' },
    ])
  })

  test('a noReply context append never marks the session busy', async () => {
    const { session, process, directory } = stubSession()
    const result = await provider.getBackend().sessions.prompt({
      sessionId: 'ses-pi', directory, noReply: true, parts: [{ kind: 'text', text: 'context' }],
    })
    expect(result).toBeUndefined()
    expect(session.busy).toBe(false)
    expect(process.requests).toEqual([expect.objectContaining({ type: 'prompt', message: expect.stringContaining('/roadie:append') })])
  })
})
