// Pi → Roadie event translation over real recorded `pi --mode rpc` streams.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AgentEvent, AgentPart } from '../events.js'
import { PiEventTranslator, piMessageId, toAgentHistory, type PiMessage } from './events.js'
import { splitRecords, type PiRecord } from './rpc.js'
import { decidePermission } from './backend.js'
import { fromOpenCodeMcp, openCodeToolName } from './mcp.js'
import { PERSON_MCP_TOOL_GLOB, personMcpPermissions, personMcpScope } from '../../person-mcp.js'
import { parsePermissionRules } from '../../permission-policy.js'

const fixtures = path.join(import.meta.dirname, 'fixtures')

function records(name: string): PiRecord[] {
  return fs.readFileSync(path.join(fixtures, name), 'utf8').split('\n').filter((l) => l.trim()).map((line): PiRecord => {
    const parsed = JSON.parse(line) as { record?: PiRecord } & PiRecord
    return parsed.record ?? parsed
  })
}

function translate(name: string): AgentEvent[] {
  const translator = new PiEventTranslator('ses-pi')
  return records(name).flatMap((record) => translator.translate(record))
}

describe('splitRecords', () => {
  test('splits on LF only, keeps U+2028 inside records, strips CR', () => {
    const { lines, rest } = splitRecords('{"a":"x\u2028y"}\r\n{"b":1}\n{"c"')
    expect(lines).toEqual(['{"a":"x\u2028y"}', '{"b":1}'])
    expect(rest).toBe('{"c"')
  })
})

describe('PiEventTranslator on a recorded tool turn', () => {
  const events = translate('pi-tool-turn.jsonl')

  test('busy at the start, idle at the end', () => {
    expect(events[0]).toEqual({ type: 'status', sessionId: 'ses-pi', status: { state: 'busy' } })
    expect(events.slice(-2)).toEqual([
      { type: 'status', sessionId: 'ses-pi', status: { state: 'idle' } },
      { type: 'idle', sessionId: 'ses-pi' },
    ])
  })

  test('the tool-calling step finishes as tool-calls, the final reply as stop, both answering the user', () => {
    const user = events.find((e) => e.type === 'message' && e.message.role === 'user')
    const finished = events.flatMap((e) => (e.type === 'message' && e.message.role === 'assistant' && e.message.completedAt ? [e.message] : []))
    expect(finished.map((m) => m.finish)).toEqual(['tool-calls', 'stop'])
    for (const message of finished) {
      expect(message.parentId).toBe(user?.type === 'message' ? user.message.id : undefined)
      expect(message.model).toEqual({ providerId: 'zai-coding-plan', modelId: 'glm-5.3-flash' })
      expect(message.usage?.input).toBeGreaterThan(0)
    }
  })

  test('tool parts go pending → running → completed with output, on the assistant message that called them', () => {
    const toolParts = events.flatMap((e) => (e.type === 'part' && e.part.kind === 'tool' ? [e.part] : []))
    const byCall = new Map<string, Array<Extract<AgentPart, { kind: 'tool' }>>>()
    for (const part of toolParts) if (part.kind === 'tool') byCall.set(part.callId, [...(byCall.get(part.callId) ?? []), part])
    expect(byCall.size).toBe(2)
    for (const parts of byCall.values()) {
      expect(parts.map((p) => p.status)).toEqual(['pending', 'running', 'completed'])
      expect(new Set(parts.map((p) => p.messageId)).size).toBe(1)
      expect(parts.at(-1)?.output).toBeTruthy()
    }
  })

  test('text streams as deltas on a started part and closes with the full text', () => {
    const textParts = events.flatMap((e) => (e.type === 'part' && e.part.kind === 'text' && e.part.messageId.startsWith('pi-assistant') ? [e.part] : []))
    const closed = textParts.find((p) => p.kind === 'text' && p.endedAt)
    expect(closed?.kind === 'text' && closed.text).toMatch(/files/)
    const deltas = events.filter((e) => e.type === 'part.delta' && e.partId === closed?.id)
    expect(deltas.map((e) => (e.type === 'part.delta' ? e.delta : '')).join('')).toBe(closed?.kind === 'text' ? closed.text : '')
  })

  test('every assistant message gets a step-finish part', () => {
    const finishes = events.filter((e) => e.type === 'part' && e.part.kind === 'step-finish')
    expect(finishes).toHaveLength(2)
  })
})

describe('history', () => {
  test('agent_end messages translate with tool results folded into their calls, ids matching the live stream', () => {
    const end = records('pi-tool-turn.jsonl').find((r) => r.type === 'agent_end') as unknown as { messages: PiMessage[] }
    const history = toAgentHistory({ messages: end.messages, sessionId: 'ses-pi' })
    expect(history.map((h) => h.message.role)).toEqual(['user', 'assistant', 'assistant'])
    const live = translate('pi-tool-turn.jsonl')
    const liveIds = new Set(live.flatMap((e) => (e.type === 'message' ? [e.message.id] : [])))
    for (const entry of history) expect(liveIds.has(entry.message.id)).toBe(true)
    const tools = history.flatMap((h) => h.parts.filter((p) => p.kind === 'tool'))
    expect(tools).toHaveLength(2)
    for (const tool of tools) if (tool.kind === 'tool') expect(tool.output).toBeTruthy()
    expect(history[1]?.message.parentId).toBe(history[0]?.message.id)
  })

  test('message ids come from role and timestamp', () => {
    expect(piMessageId({ role: 'user', timestamp: 5 })).toBe('pi-user-5')
  })

  test('an aborted reply carries MessageAbortedError and no finish', () => {
    const [entry] = toAgentHistory({
      sessionId: 's',
      messages: [{ role: 'assistant', content: [], stopReason: 'aborted', timestamp: 1 }],
    })
    expect(entry?.message.error?.name).toBe('MessageAbortedError')
    expect(entry?.message.finish).toBeUndefined()
  })
})

describe('decidePermission', () => {
  const cwd = '/repo'
  test('Pi defaults to allow, like Roadie on OpenCode', () => {
    expect(decidePermission({ rules: [], tool: 'bash', input: { command: 'ls' }, cwd }).action).toBe('allow')
  })
  test('session rules apply by OpenCode permission name and pattern, last match wins', () => {
    const rules = [
      { permission: 'bash', pattern: '*', action: 'ask' as const },
      { permission: 'bash', pattern: 'git status*', action: 'allow' as const },
    ]
    expect(decidePermission({ rules, tool: 'bash', input: { command: 'rm -rf x' }, cwd })).toEqual({ action: 'ask', permission: 'bash', patterns: ['rm -rf x'] })
    expect(decidePermission({ rules, tool: 'bash', input: { command: 'git status' }, cwd }).action).toBe('allow')
  })
  test('writes map to edit; a path outside the directory also checks external_directory', () => {
    const rules = [{ permission: 'external_directory', pattern: '*', action: 'deny' as const }]
    expect(decidePermission({ rules, tool: 'write', input: { path: 'src/a.ts' }, cwd }).action).toBe('allow')
    expect(decidePermission({ rules, tool: 'write', input: { path: '/etc/passwd' }, cwd })).toEqual({ action: 'deny', permission: 'external_directory', patterns: ['/etc'] })
  })
  test('a session with no rules is denied per-person MCP tools, though other tools default to allow', () => {
    expect(decidePermission({ rules: [], tool: 'bash', input: { command: 'ls' }, cwd }).action).toBe('allow')
    expect(decidePermission({ rules: [], tool: `mcp__${PERSON_MCP_TOOL_GLOB.replace('*', 'abc')}_jira__search`, input: {}, cwd: '/r' }).action).toBe('deny')
  })
  test('the owning person\'s per-turn allow pair still allows their own roadie_pm_* tools', () => {
    const scope = personMcpScope('person-a')
    const rules = parsePermissionRules(personMcpPermissions({ personKey: 'person-a', hasServers: true }))
    expect(decidePermission({ rules, tool: `mcp__${scope}_jira__search`, input: {}, cwd: '/r' }).action).toBe('allow')
    expect(decidePermission({ rules, tool: `mcp__${personMcpScope('person-b')}_jira__search`, input: {}, cwd: '/r' }).action).toBe('deny')
  })
})

describe('Pi 1.x stream shape', () => {
  test('message_update without `message` still lands on the assistant message from message_start', () => {
    const translator = new PiEventTranslator('ses-pi')
    translator.translate({ type: 'message_start', message: { role: 'system', content: '', timestamp: 1 } })
    const [started] = translator.translate({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 7 } })
    const delta = translator.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' } })
    const end = translator.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'hi' } })
    expect(started?.type === 'message' && started.message.id).toBe('pi-assistant-7')
    expect(delta).toEqual([{ type: 'part.delta', sessionId: 'ses-pi', messageId: 'pi-assistant-7', partId: 'pi-assistant-7-0', field: 'text', delta: 'hi' }])
    expect(end[0]?.type === 'part' && end[0].part.kind === 'text' && end[0].part.startedAt).toBe(7)
    expect(translator.translate({ type: 'agent_settled', aborted: false })).toEqual([])
  })
})

describe('MCP config for Pi', () => {
  test('OpenCode mcp entries convert to Pi servers with direct exposure', () => {
    expect(fromOpenCodeMcp({
      fs: { type: 'local', command: ['npx', '-y', 'server-fs', '.'], environment: { TOKEN: '{env:FS_TOKEN}' } },
      docs: { type: 'remote', url: 'https://x/mcp', headers: { Authorization: 'Bearer {env:DOCS}' }, enabled: false },
    })).toEqual({
      fs: { command: 'npx', args: ['-y', 'server-fs', '.'], env: { TOKEN: '${FS_TOKEN}' }, enabled: true, exposure: 'direct' },
      docs: { url: 'https://x/mcp', headers: { Authorization: 'Bearer ${DOCS}' }, enabled: false, exposure: 'direct' },
    })
  })
  test('Pi MCP tool names map to OpenCode names, so person-scoped rules still match', () => {
    expect(openCodeToolName('mcp__roadie_pm_abc_jira__search')).toBe('roadie_pm_abc_jira_search')
    expect(openCodeToolName('bash')).toBe('bash')
    const rules = [{ permission: 'roadie_pm_*', pattern: '*', action: 'deny' as const }]
    expect(decidePermission({ rules, tool: 'mcp__roadie_pm_abc_jira__search', input: {}, cwd: '/r' }).action).toBe('deny')
  })
})

