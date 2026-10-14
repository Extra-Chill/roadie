// Deterministic markdown export tests: sessions are fixed backend-shaped
// fixtures, so the output depends only on the renderer.

import { test, expect } from 'vitest'
import * as errore from 'errore'
import type { AgentPart, AgentSession } from './agent-backend/events.js'
import type { AgentBackend, AgentSessionMessage } from './agent-backend/types.js'
import {
  ShareMarkdown,
  fileBaseName,
  formatCompactToolSummary,
  formatDuration,
  truncateChars,
  userPromptDurationMs,
} from './markdown.js'

test('truncateChars keeps short text and ellipsizes long text', () => {
  expect(truncateChars('hello world', 80)).toBe('hello world')
  expect(truncateChars('  a   b  ', 80)).toBe('a b')
  expect(truncateChars('abcdefghij', 5)).toBe('abcd…')
  expect(truncateChars('ab', 1)).toBe('…')
})

test('formatDuration uses ms, seconds, then minutes', () => {
  expect(formatDuration(250)).toBe('250ms')
  expect(formatDuration(1500)).toBe('1.5s')
  expect(formatDuration(65_000)).toBe('1m 5s')
})

test('userPromptDurationMs spans user send to last following assistant', () => {
  const messages = [
    { info: { role: 'user', time: { created: 1000 } } },
    { info: { role: 'assistant', time: { created: 1100, completed: 4000 } } },
    { info: { role: 'assistant', time: { created: 4100, completed: 9000 } } },
    { info: { role: 'user', time: { created: 20_000 } } },
    { info: { role: 'assistant', time: { created: 20_100, completed: 21_000 } } },
  ]
  expect(userPromptDurationMs({ messages, userIndex: 0 })).toBe(8000)
  expect(userPromptDurationMs({ messages, userIndex: 3 })).toBe(1000)
})

test('fileBaseName strips directories on posix and windows paths', () => {
  expect(fileBaseName('/Users/morse/README.md')).toBe('README.md')
  expect(fileBaseName('src\\cli.ts')).toBe('cli.ts')
})

test('formatCompactToolSummary indexes read, task, and bash inputs', () => {
  expect(formatCompactToolSummary({
    tool: 'read',
    input: { filePath: '/Users/morse/Documents/GitHub/kimakivoice/README.md', offset: 1 },
  })).toBe('README.md')

  expect(formatCompactToolSummary({
    tool: 'task',
    input: { description: 'analyze gpuix-solid', task_id: 'ses_child123' },
  })).toBe('analyze gpuix-solid ses_child123')

  expect(formatCompactToolSummary({
    tool: 'task',
    input: { description: 'analyze gpuix-solid' },
    metadata: { sessionId: 'ses_from_meta' },
  })).toBe('analyze gpuix-solid ses_from_meta')

  expect(formatCompactToolSummary({
    tool: 'bash',
    input: { command: 'echo hello world', description: 'Print greeting' },
  })).toBe('echo hello world')

  expect(formatCompactToolSummary({
    tool: 'bash',
    input: {
      command: 'a'.repeat(120),
      description: 'Rebuild native addon',
    },
    maxChars: 80,
  })).toBe('Rebuild native addon')

  expect(formatCompactToolSummary({
    tool: 'grep',
    input: { pattern: 'ShareMarkdown', path: 'cli/src/markdown.ts' },
    maxChars: 40,
  })).toBe('pattern=ShareMarkdown path=cli/src/mark…')
})

const sessionID = 'session-hello'
const toolSessionID = 'session-tool'
const MODEL = { providerId: 'fake', modelId: 'fake-1' }

function part(sessionId: string, messageId: string, index: number, body: Record<string, unknown>): AgentPart {
  return { id: `${messageId}-part-${index}`, sessionId, messageId, ...body } as AgentPart
}

function turn({ sessionId, prompt, reply, at }: { sessionId: string; prompt: string; reply: Array<Record<string, unknown>>; at: number }): AgentSessionMessage[] {
  const userId = `${sessionId}-user`
  const assistantId = `${sessionId}-assistant`
  return [
    {
      message: { id: userId, sessionId, role: 'user', createdAt: at },
      parts: [part(sessionId, userId, 0, { kind: 'text', text: prompt })],
    },
    {
      message: { id: assistantId, sessionId, role: 'assistant', createdAt: at + 100, completedAt: at + 1600, parentId: userId, model: MODEL, finish: 'stop' },
      parts: [
        part(sessionId, assistantId, 0, { kind: 'step-start' }),
        ...reply.map((body, index) => part(sessionId, assistantId, index + 1, body)),
        part(sessionId, assistantId, reply.length + 1, { kind: 'step-finish' }),
      ],
    },
  ]
}

const sessions: Record<string, { session: AgentSession; messages: AgentSessionMessage[] }> = {
  [sessionID]: {
    session: { id: sessionID, title: 'Markdown Test Session', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_002_000, version: '1.2.0' },
    messages: turn({
      sessionId: sessionID,
      prompt: 'hello markdown test',
      at: 1_700_000_000_000,
      reply: [
        { kind: 'reasoning', text: 'thinking about the greeting' },
        { kind: 'text', text: 'Hello! This is a deterministic markdown test response.' },
      ],
    }),
  },
  [toolSessionID]: {
    session: { id: toolSessionID, title: 'Tool Call Session', createdAt: 1_700_000_010_000, updatedAt: 1_700_000_012_000 },
    messages: turn({
      sessionId: toolSessionID,
      prompt: 'use a tool please',
      at: 1_700_000_010_000,
      reply: [{
        kind: 'tool',
        callId: 'tc1',
        tool: 'bash',
        status: 'completed',
        input: { command: 'echo hello world', description: 'Print greeting' },
        output: 'hello world\n',
      }],
    }),
  },
}

const backend = {
  sessions: {
    get: async ({ sessionId }: { sessionId: string }) => sessions[sessionId]?.session ?? new Error(`no session ${sessionId}`),
    messages: async ({ sessionId }: { sessionId: string }) => sessions[sessionId]?.messages ?? new Error(`no session ${sessionId}`),
  },
} as unknown as Pick<AgentBackend, 'sessions'>

// Strip dynamic parts (timestamps, durations) for stable assertions
function normalizeMarkdown(md: string): string {
  return md
    .replace(/^duration: .+$/gm, 'duration: <duration>')
    .replace(/\*\*Created\*\*: .+/g, '**Created**: <date>')
    .replace(/\*\*Updated\*\*: .+/g, '**Updated**: <date>')
    .replace(/\*\*Backend Version\*\*: v[\d.]+.*/g, '**Backend Version**: v<version>')
}

test('generate markdown with system info', async () => {
  const exporter = new ShareMarkdown(backend)

  const markdownResult = await exporter.generate({
    sessionID,
    includeSystemInfo: true,
  })

  expect(errore.isOk(markdownResult)).toBe(true)
  const markdown = errore.unwrap(markdownResult)

  expect(markdown).toContain('# Markdown Test Session')
  expect(markdown).toContain('## Session Information')
  expect(markdown).toContain('## Conversation')
  expect(markdown).toContain('### user')
  expect(markdown).toContain('hello markdown test')
  expect(markdown).toContain(
    '### assistant (fake/fake-1)',
  )
  expect(markdown).toContain('Hello! This is a deterministic markdown test response.')
  expect(markdown).not.toContain('Started using')
  expect(markdown).not.toContain('Completed in')
  expect(markdown).toMatch(/^duration: /m)

  const normalized = normalizeMarkdown(markdown)
  expect(normalized).toMatchInlineSnapshot(`
    "# Markdown Test Session

    ## Session Information

    - **Created**: <date>
    - **Updated**: <date>
    - **Backend Version**: v<version>

    ## Conversation

    ### user

    hello markdown test


    ### assistant (fake/fake-1)

    Hello! This is a deterministic markdown test response.


    duration: <duration>
    "
  `)
})

test('generate markdown without system info', async () => {
  const exporter = new ShareMarkdown(backend)

  const markdown = await exporter.generate({
    sessionID,
    includeSystemInfo: false,
  })

  expect(errore.isOk(markdown)).toBe(true)
  const md = errore.unwrap(markdown as string)
  expect(md).toContain('# Markdown Test Session')
  expect(md).not.toContain('## Session Information')
  expect(md).toContain('## Conversation')

  const normalized = normalizeMarkdown(md)
  expect(normalized).toMatchInlineSnapshot(`
    "# Markdown Test Session

    ## Conversation

    ### user

    hello markdown test


    ### assistant (fake/fake-1)

    Hello! This is a deterministic markdown test response.


    duration: <duration>
    "
  `)
})

test('error handling for non-existent session', async () => {
  const exporter = new ShareMarkdown(backend)
  const badSessionID = 'ses_nonexistent_' + Date.now()

  const result = await exporter.generate({ sessionID: badSessionID })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain(`Session ${badSessionID} not found`)
})

test('generate markdown with lastAssistantOnly', async () => {
  const exporter = new ShareMarkdown(backend)

  const markdownResult = await exporter.generate({
    sessionID,
    lastAssistantOnly: true,
  })

  expect(errore.isOk(markdownResult)).toBe(true)
  const markdown = errore.unwrap(markdownResult)

  // lastAssistantOnly should NOT include title header or conversation section header
  expect(markdown).not.toContain('# Markdown Test Session')
  expect(markdown).not.toContain('## Conversation')
  // Should contain the assistant response
  expect(markdown).toContain('Hello! This is a deterministic markdown test response.')
})

test('thinking is omitted unless includeThinking is set', async () => {
  const exporter = new ShareMarkdown(backend)
  const hidden = await exporter.generate({
    sessionID,
    includeThinking: false,
  })
  expect(errore.isOk(hidden)).toBe(true)
  expect(errore.unwrap(hidden)).not.toContain('thinking:')

  const shown = await exporter.generate({
    sessionID,
    includeThinking: true,
  })
  expect(errore.isOk(shown)).toBe(true)
  expect(errore.unwrap(shown)).not.toContain('💭')
})

test('compact tools: tool calls show one-liner with line count', async () => {
  const exporter = new ShareMarkdown(backend)

  const result = await exporter.generate({
    sessionID: toolSessionID,
    compactTools: true,
  })

  expect(errore.isOk(result)).toBe(true)
  const md = errore.unwrap(result)

  // Compact mode: exact one-liner format with params and line count
  expect(md).toContain('tool: bash echo hello world')
  expect(md).toMatch(/\(\d+ lines?\)/)
  // Should NOT contain full output code blocks or input YAML
  expect(md).not.toContain('**Output:**')
  expect(md).not.toContain('**Input:**')
  expect(md).not.toContain('```yaml')
})

test('verbose tools: tool calls show full input and output', async () => {
  const exporter = new ShareMarkdown(backend)

  const result = await exporter.generate({
    sessionID: toolSessionID,
    compactTools: false,
  })

  expect(errore.isOk(result)).toBe(true)
  const md = errore.unwrap(result)

  // Verbose mode: full tool rendering with input YAML and output code block
  expect(md).toContain('#### tool: bash')
  expect(md).toContain('**Input:**')
  expect(md).toContain('```yaml')
  expect(md).toContain('**Output:**')
  expect(md).toContain('hello world')
})

