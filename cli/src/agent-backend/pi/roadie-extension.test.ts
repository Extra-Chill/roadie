// The Roadie Pi extension's injection guard helpers (Pi parity of the
// injection guard) and the native MCP form elicitation loop: pure functions,
// no `pi` process needed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult } from '@earendil-works/pi-coding-agent'
import roadieExtension from './roadie-extension.js'
import {
  FORM_TITLE,
  MAX_FORM_ROUNDS,
  ROADIE_INJECTION_GUARD_DIR_ENV,
  injectionGuardBlockedOutput,
  injectionGuardBuildUserMessage,
  injectionGuardConfig,
  injectionGuardMatchesScanPatterns,
  injectionGuardParseJudgeResponse,
  injectionGuardSessionPatterns,
  injectionGuardWildcardMatch,
  nativeMcpToolName,
  runNativeToolCall,
  type NativeToolAsk,
} from './roadie-extension.js'
import type { NativeCallContinuation, NativeCallResult } from './mcp-native.js'

describe('bounded compaction through the extension hook', () => {
  function setup() {
    let handler!: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<SessionBeforeCompactResult | undefined>
    roadieExtension({
      on: (name: string, callback: typeof handler) => { if (name === 'session_before_compact') handler = callback },
      registerTool: () => {},
      getAllTools: () => [],
    } as unknown as Parameters<typeof roadieExtension>[0])
    const completeSimple = vi.fn()
    const ctx = { model: { id: 'current-model', reasoning: true }, modelRegistry: { streamSimple: (...args: unknown[]) => ({ result: () => completeSimple(...args) }) } } as unknown as ExtensionContext
    const event = {
      preparation: {
        previousSummary: 'old decisions '.repeat(6000),
        messagesToSummarize: [{ role: 'user', content: 'NEW_WORK path/to/file.ts abc123', timestamp: 1 }],
        turnPrefixMessages: [{ role: 'user', content: 'TURN_PREFIX', timestamp: 2 }],
        isSplitTurn: true,
        fileOps: { read: new Set(['z.ts', 'a.ts']), edited: new Set(['a.ts']), written: new Set(['b.ts']) },
        firstKeptEntryId: 'kept-id', tokensBefore: 190000,
      },
      customInstructions: 'Focus on migration IDs',
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent
    return { handler, ctx, event, completeSimple }
  }
  const reply = (text: string, stopReason = 'stop') => ({ content: [{ type: 'text', text }], stopReason, usage: { output: 20 } })

  test('merges long history with a fixed output budget, focus and file lists', async () => {
    const { handler, ctx, event, completeSimple } = setup()
    completeSimple.mockResolvedValue(reply('bounded summary'))
    const result = await handler(event, ctx)
    expect(completeSimple).toHaveBeenCalledTimes(1)
    const [model, request, options] = completeSimple.mock.calls[0]!
    expect(model).toBe(ctx.model)
    expect(request.systemPrompt).toContain('at most 8192 tokens')
    expect(request.systemPrompt).toContain('Compress and merge older sections')
    expect(request.messages[0].content).toContain(event.preparation.previousSummary)
    expect(request.messages[0].content).toContain('NEW_WORK path/to/file.ts abc123')
    expect(request.messages[0].content).toContain('TURN_PREFIX')
    expect(request.messages[0].content).toContain('Additional focus:\nFocus on migration IDs')
    expect(options).toEqual({ maxTokens: 16384, reasoning: 'minimal', signal: event.signal, cacheRetention: 'none' })
    expect(result?.compaction).toEqual({
      summary: 'bounded summary\n\n<read-files>\nz.ts\n</read-files>\n\n<modified-files>\na.ts\nb.ts\n</modified-files>',
      firstKeptEntryId: 'kept-id', tokensBefore: 190000, usage: { output: 20 },
    })
  })

  test.each(['length', 'empty'])('%s retries exactly once with a tighter target, then falls back', async (failure) => {
    const { handler, ctx, event, completeSimple } = setup()
    completeSimple.mockResolvedValue(reply(failure === 'empty' ? '  ' : 'incomplete', failure === 'length' ? 'length' : 'stop'))
    expect(await handler(event, ctx)).toBeUndefined()
    expect(completeSimple).toHaveBeenCalledTimes(2)
    expect(completeSimple.mock.calls[1]![1].systemPrompt).toContain('at most 4096 tokens')
    expect(completeSimple.mock.calls[1]![2].maxTokens).toBe(16384)
  })

  test('retry succeeds and excludes an unsplit turn prefix', async () => {
    const { handler, ctx, event, completeSimple } = setup()
    event.preparation.isSplitTurn = false
    completeSimple.mockResolvedValueOnce(reply('partial', 'length')).mockResolvedValueOnce(reply('compressed'))
    expect((await handler(event, ctx))?.compaction?.summary).toContain('compressed')
    expect(completeSimple.mock.calls[1]![1].messages[0].content).not.toContain('TURN_PREFIX')
  })

  test('aborted or failed requests fall back to Pi', async () => {
    const { handler, ctx, event, completeSimple } = setup()
    completeSimple.mockRejectedValue(new Error('unavailable'))
    expect(await handler(event, ctx)).toBeUndefined()
    expect(completeSimple).toHaveBeenCalledTimes(1)
    completeSimple.mockClear()
    event.signal = AbortSignal.abort()
    expect(await handler(event, ctx)).toBeUndefined()
    expect(completeSimple).not.toHaveBeenCalled()
  })
})

describe('native MCP tool names', () => {
  test('keeps the mcp__<server>__<tool> shape Pi\'s built-in client uses', () => {
    expect(nativeMcpToolName('rpm_abc123def456_wordpress', 'search')).toBe('mcp__rpm_abc123def456_wordpress__search')
    // Non-alphanumerics fold to _, like Pi's own naming.
    expect(nativeMcpToolName('srv', 'buy-plan')).toBe('mcp__srv__buy_plan')
  })
})

describe('runNativeToolCall (form elicitation)', () => {
  const SERVER = 'rpm_abc123def456_wordpress'

  const formRequest = (): NativeCallResult => ({
    content: [],
    inputRequired: {
      inputRequests: { k1: { method: 'elicitation/create', params: { mode: 'form', message: 'Buy the pro plan?', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } } } } },
      requestState: 'signed-state',
    },
  })

  const done = (text: string): NativeCallResult => ({ content: [{ type: 'text', text }] })

  /** A call fake scripted per round; records continuations. */
  function scriptedCall(rounds: NativeCallResult[], errors?: Error[]) {
    const calls: Array<{ args: unknown; continuation: NativeCallContinuation | undefined }> = []
    const call = async (args: Record<string, unknown>, continuation?: NativeCallContinuation) => {
      calls.push({ args, continuation })
      const error = errors?.[calls.length - 1]
      if (error) throw error
      return rounds[Math.min(calls.length - 1, rounds.length - 1)]!
    }
    return { call, calls }
  }

  test('accept continues the call with inputResponses and the request state', async () => {
    const { call, calls } = scriptedCall([formRequest(), done('bought')])
    const asks: unknown[] = []
    const ask: NativeToolAsk = async (payload) => {
      asks.push(payload)
      return { action: 'accept', content: { confirm: true } }
    }
    const outcome = await runNativeToolCall({ server: SERVER, tool: 'buy-plan', args: { plan: 'pro' }, call, ask })
    expect(outcome.notes).toEqual([])
    expect(outcome.result.content).toEqual([{ type: 'text', text: 'bought' }])
    expect(asks).toEqual([{
      server: SERVER,
      tool: 'buy-plan',
      message: 'Buy the pro plan?',
      schema: { type: 'object', properties: { confirm: { type: 'boolean' } } },
    }])
    expect(calls[1]?.continuation).toEqual({
      inputResponses: { k1: { action: 'accept', content: { confirm: true } } },
      requestState: 'signed-state',
    })
  })

  test('decline and cancel are answered as given and reach the server', async () => {
    const { call, calls } = scriptedCall([formRequest(), formRequest(), done('nothing done')])
    let round = 0
    const ask: NativeToolAsk = async () => {
      round += 1
      return round === 1 ? { action: 'decline' } : { action: 'cancel' }
    }
    const outcome = await runNativeToolCall({ server: SERVER, tool: 'buy-plan', args: {}, call, ask })
    expect(outcome.notes).toEqual(['the approval form was cancelled, so the server ran nothing'])
    expect(calls[1]?.continuation?.inputResponses.k1).toEqual({ action: 'decline' })
    expect(calls[2]?.continuation?.inputResponses.k1).toEqual({ action: 'cancel' })
  })

  test('a dismissed, timed out or aborted form answers cancel and says so', async () => {
    const { call, calls } = scriptedCall([formRequest(), done('cancelled by the server')])
    const ask: NativeToolAsk = async () => undefined
    const outcome = await runNativeToolCall({ server: SERVER, tool: 'buy-plan', args: {}, call, ask })
    expect(calls[1]?.continuation?.inputResponses.k1).toEqual({ action: 'cancel' })
    expect(outcome.notes.join(' ')).toContain('no answer')
  })

  test('an unrenderable form is answered cancel with the reason', async () => {
    const unrenderable = (): NativeCallResult => ({
      content: [],
      inputRequired: {
        inputRequests: { k1: { method: 'elicitation/create', params: { mode: 'form', message: 'Config?', requestedSchema: { type: 'object', properties: { meta: { type: 'object' } } } } } },
        requestState: 'state-2',
      },
    })
    const { call, calls } = scriptedCall([unrenderable(), done('ok')])
    const ask: NativeToolAsk = async () => { throw new Error('Roadie must not ask what it cannot render') }
    const outcome = await runNativeToolCall({ server: SERVER, tool: 'configure', args: {}, call, ask })
    expect(outcome.notes.join(' ')).toContain('"meta"')
    expect(calls[1]?.continuation?.inputResponses.k1).toEqual({ action: 'cancel' })
  })

  test('non-form elicitation requests are cancelled, not asked', async () => {
    const urlMode = (): NativeCallResult => ({
      content: [],
      inputRequired: {
        inputRequests: { u1: { method: 'elicitation/create', params: { mode: 'url', message: 'https://example.com/approve' } } },
        requestState: 'state-3',
      },
    })
    const { call, calls } = scriptedCall([urlMode(), done('ok')])
    const ask: NativeToolAsk = async () => { throw new Error('Roadie must not ask a url mode') }
    const outcome = await runNativeToolCall({ server: SERVER, tool: 'x', args: {}, call, ask })
    expect(calls[1]?.continuation?.inputResponses.u1).toEqual({ action: 'cancel' })
    expect(outcome.notes.join(' ')).toContain('non-form')
  })

  test('a malformed dialog answer answers cancel', async () => {
    const { call, calls } = scriptedCall([formRequest(), done('ok')])
    const ask: NativeToolAsk = async () => ({ nonsense: true })
    const outcome = await runNativeToolCall({ server: SERVER, tool: 'buy-plan', args: {}, call, ask })
    expect(calls[1]?.continuation?.inputResponses.k1).toEqual({ action: 'cancel' })
    expect(outcome.result.content[0]?.text).toBe('ok')
  })

  test('rounds are bounded at 5 and the tool result explains the stop', async () => {
    const { call, calls } = scriptedCall([formRequest()]) // every round asks again
    const ask: NativeToolAsk = async () => ({ action: 'accept', content: { confirm: true } })
    const outcome = await runNativeToolCall({ server: SERVER, tool: 'loop', args: {}, call, ask })
    expect(calls).toHaveLength(MAX_FORM_ROUNDS + 1)
    expect(outcome.notes.join(' ')).toContain('still asking for input after 5 rounds')
  })

  test('a transport error throws so the tool result is an error', async () => {
    const { call } = scriptedCall([], [new Error('HTTP 503')])
    const ask: NativeToolAsk = async () => undefined
    await expect(runNativeToolCall({ server: SERVER, tool: 'buy-plan', args: {}, call, ask })).rejects.toThrow('HTTP 503')
  })

  test('the form dialog title is Roadie\'s form title', () => {
    expect(FORM_TITLE).toBe('roadie:form')
  })
})

describe('injectionGuardWildcardMatch', () => {
  test('matches exact values and * spans', () => {
    expect(injectionGuardWildcardMatch('bash', 'bash')).toBe(true)
    expect(injectionGuardWildcardMatch('bash', 'Bash')).toBe(true)
    expect(injectionGuardWildcardMatch('bash', 'webfetch')).toBe(false)
    expect(injectionGuardWildcardMatch('*curl*', `echo curl http://x`)).toBe(true)
    expect(injectionGuardWildcardMatch('*curl*', 'echo wget')).toBe(false)
    expect(injectionGuardWildcardMatch('a*c*e', 'abcde')).toBe(true)
    expect(injectionGuardWildcardMatch('a*c*e', 'abdc')).toBe(false)
    expect(injectionGuardWildcardMatch('pre*fix', 'premiddlefix')).toBe(true)
    expect(injectionGuardWildcardMatch('pre*fix', 'prefixmiddle')).toBe(false)
  })
})

describe('injectionGuardMatchesScanPatterns', () => {
  test('"tool:argsGlob" patterns match tool plus arguments', () => {
    const patterns = ['bash:*', 'webfetch:*curl*']
    expect(
      injectionGuardMatchesScanPatterns({ tool: 'bash', args: '{"command":"ls"}', patterns }),
    ).toBe(true)
    expect(
      injectionGuardMatchesScanPatterns({ tool: 'read', args: '{"path":"/x"}', patterns }),
    ).toBe(false)
    expect(
      injectionGuardMatchesScanPatterns({
        tool: 'webfetch',
        args: '{"url":"https://x/?q=curl"}',
        patterns,
      }),
    ).toBe(true)
    expect(
      injectionGuardMatchesScanPatterns({
        tool: 'webfetch',
        args: '{"url":"https://x/"}',
        patterns,
      }),
    ).toBe(false)
  })

  test('a pattern without a colon matches the tool name alone', () => {
    expect(
      injectionGuardMatchesScanPatterns({ tool: 'bash', args: 'anything', patterns: ['bash'] }),
    ).toBe(true)
    expect(
      injectionGuardMatchesScanPatterns({ tool: 'read', args: 'anything', patterns: ['bash'] }),
    ).toBe(false)
  })
})

describe('injectionGuardParseJudgeResponse', () => {
  test('parses JSON, fenced JSON, and loose text', () => {
    expect(
      injectionGuardParseJudgeResponse(
        '{"flagged": true, "confidence": 0.9, "observation": "inject"}',
      ),
    ).toEqual({
      flagged: true,
      confidence: 0.9,
      observation: 'inject',
    })
    expect(
      injectionGuardParseJudgeResponse('```json\n{"flagged":false,"confidence":0.1}\n```'),
    ).toEqual({
      flagged: false,
      confidence: 0.1,
    })
    expect(injectionGuardParseJudgeResponse('I think "flagged": true but invalid json')).toEqual({
      flagged: true,
      confidence: 0.5,
    })
    expect(injectionGuardParseJudgeResponse('no json here')).toEqual({
      flagged: false,
      confidence: 0,
    })
    expect(injectionGuardParseJudgeResponse('{"flagged":true}')).toEqual({
      flagged: true,
      confidence: 0,
    })
  })
})

describe('injectionGuardSessionPatterns', () => {
  test('reads the per-session scan patterns file written by Roadie', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pi-guard-'))
    fs.writeFileSync(path.join(dir, 'ses-guard.json'), JSON.stringify({ scanPatterns: ['bash:*'] }))
    expect(injectionGuardSessionPatterns({ dir, sessionId: 'ses-guard' })).toEqual(['bash:*'])
    expect(injectionGuardSessionPatterns({ dir, sessionId: 'ses-other' })).toBeNull()
    expect(injectionGuardSessionPatterns({ dir: undefined, sessionId: 'ses-guard' })).toBeNull()
    fs.writeFileSync(path.join(dir, 'ses-bad.json'), 'not json')
    expect(injectionGuardSessionPatterns({ dir, sessionId: 'ses-bad' })).toBeNull()
  })
})

describe('injectionGuardConfig', () => {
  const cwd = '/some/project'

  test('is off without any opt-in source', () => {
    expect(injectionGuardConfig({ sessionId: 'ses-1', cwd, env: {} })).toBeNull()
  })

  test('per-session patterns replace the global patterns', () => {
    const guardDir = fs.mkdtempSync(
      path.join(process.env.TMPDIR || os.tmpdir(), 'pi-guard-session-'),
    )
    fs.writeFileSync(
      path.join(guardDir, 'ses-guarded.json'),
      JSON.stringify({ scanPatterns: ['bash:*'] }),
    )
    const env = {
      [ROADIE_INJECTION_GUARD_DIR_ENV]: guardDir,
      OPENCODE_INJECTION_GUARD: JSON.stringify({ scanPatterns: ['read:*'] }),
    }
    expect(injectionGuardConfig({ sessionId: 'ses-guarded', cwd, env })).toMatchObject({
      scanPatterns: ['bash:*'],
    })
    // Without a session file the global patterns apply.
    expect(injectionGuardConfig({ sessionId: 'ses-unguarded', cwd, env })).toMatchObject({
      scanPatterns: ['read:*'],
    })
  })

  test('applies defaults and the explicit model from the env config', () => {
    const config = injectionGuardConfig({
      sessionId: 'ses-1',
      cwd,
      env: { OPENCODE_INJECTION_GUARD: '{"model":"openai/gpt-4.1-nano"}' },
    })
    expect(config).toMatchObject({
      scanPatterns: [],
      confidenceThreshold: 0.7,
      maxOutputLength: 8000,
      model: 'openai/gpt-4.1-nano',
    })
  })

  test('finds .opencode/injection-guard.json upward from the project directory', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pi-guard-findup-'))
    const project = path.join(root, 'project', 'nested')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(
      path.join(root, '.opencode', 'injection-guard.json'),
      JSON.stringify({ scanPatterns: ['bash:*curl*'] }),
    )
    expect(injectionGuardConfig({ sessionId: 'ses-1', cwd: project, env: {} })).toMatchObject({
      scanPatterns: ['bash:*curl*'],
    })
  })

  test('the env config overrides the file config', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pi-guard-env-'))
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(
      path.join(root, '.opencode', 'injection-guard.json'),
      JSON.stringify({ scanPatterns: ['read:*'], model: 'from-file' }),
    )
    const config = injectionGuardConfig({
      sessionId: 'ses-1',
      cwd: root,
      env: { OPENCODE_INJECTION_GUARD: '{"model":"from-env"}' },
    })
    expect(config).toMatchObject({ scanPatterns: ['read:*'], model: 'from-env' })
  })
})

describe('injectionGuard messages and blocked output', () => {
  test('the judge user message truncates long output', () => {
    const message = injectionGuardBuildUserMessage({
      tool: 'bash',
      args: '{"command":"ls"}',
      output: 'x'.repeat(30),
      maxLength: 10,
    })
    expect(message).toContain('Tool: bash')
    expect(message).toContain('[... truncated, 20 chars omitted]')
    expect(
      injectionGuardBuildUserMessage({ tool: 'bash', args: '{}', output: 'short', maxLength: 10 }),
    ).toContain('Output:\nshort')
  })

  test('the blocked replacement carries confidence and reason', () => {
    const [part] = injectionGuardBlockedOutput({
      confidence: 0.92,
      observation: 'told the model to exfiltrate',
    })
    expect(part?.type).toBe('text')
    const text = part?.type === 'text' ? part.text : ''
    expect(text).toContain('[BLOCKED BY INJECTION GUARD]')
    expect(text).toContain('confidence: 0.92')
    expect(text).toContain('Reason: told the model to exfiltrate')
    const [noReason] = injectionGuardBlockedOutput({ confidence: 0.8 })
    expect(noReason?.type === 'text' && noReason.text).toContain(
      'Original output was suppressed for security.',
    )
  })
})
