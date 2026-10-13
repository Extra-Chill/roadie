// The Pi backend over a stubbed rpc process: noReply appends, and agent
// definitions reach the turn (system prompt, model, permission rules).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { AgentRequestError } from '../types.js'
import { PiBackendProvider } from './backend.js'
import { PiEventTranslator } from './events.js'

type Recorded = Record<string, unknown>

function workspace(): string {
  return fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pi-backend-'))
}

describe('PiBackend sessions.prompt over a stubbed rpc process', () => {
  const root = workspace()
  const provider = new PiBackendProvider({ bin: 'pi', sessionDir: path.join(root, 'sessions'), idleTimeoutMs: 0 })

  function stubProcess({ disposition = 'handled' }: { disposition?: string } = {}) {
    const requests: Recorded[] = []
    const sent: Recorded[] = []
    return {
      requests,
      sent,
      exited: false,
      request: async (command: Recorded) => {
        requests.push(command)
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

  function stubSession({ disposition, model, directory }: { disposition?: string; model?: { provider: string; id: string }; directory?: string } = {}) {
    const dir = directory ?? path.join(root, 'plain')
    fs.mkdirSync(dir, { recursive: true })
    const process = stubProcess({ disposition })
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
      ...(model && { model }),
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
      { type: 'prompt', message: 'hi' },
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
