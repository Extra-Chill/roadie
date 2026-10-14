import { afterEach, describe, expect, test } from 'vitest'
import { findMatcher, startFakeModelServer, typedText, type FakeMatcher } from './fake-model-server.js'

const text = (id: string, delta: string): FakeMatcher['then'] => ({
  parts: [{ type: 'text-delta', id, delta }, { type: 'finish', finishReason: 'stop' }],
})

describe('fake model server matchers', () => {
  test('higher priority wins, ties keep list order, conditions all apply', () => {
    const matchers: FakeMatcher[] = [
      { id: 'any-user', when: { lastMessageRole: 'user' }, then: text('a', 'a') },
      { id: 'marker', priority: 10, when: { latestUserTextIncludes: 'MARK' }, then: text('b', 'b') },
      { id: 'marker-after-tool', priority: 20, when: { lastMessageRole: 'tool', latestUserTextIncludes: 'MARK' }, then: text('c', 'c') },
      { id: 'second-user', when: { lastMessageRole: 'user' }, then: text('d', 'd') },
    ]
    expect(findMatcher(matchers, { messages: [{ role: 'user', content: 'MARK' }] })?.id).toBe('marker')
    expect(findMatcher(matchers, { messages: [{ role: 'user', content: 'MARK' }, { role: 'tool', content: 'x' }] })?.id).toBe('marker-after-tool')
    expect(findMatcher(matchers, { messages: [{ role: 'user', content: 'hi' }] })?.id).toBe('any-user')
  })

  test("latest user text ignores Roadie's envelope", () => {
    const said = 'hello\n\n<discord-user name="u" thread-name="MARK thread" />\n\n<system-reminder>\nMARK\n</system-reminder>'
    expect(typedText(said)).toBe('hello')
    const matchers: FakeMatcher[] = [{ id: 'marker', when: { latestUserTextIncludes: 'MARK' }, then: text('a', 'a') }]
    expect(findMatcher(matchers, { messages: [{ role: 'user', content: [{ type: 'text', text: said }] }] })).toBeUndefined()
    // The raw prompt still sees everything.
    expect(findMatcher([{ id: 'raw', when: { rawPromptIncludes: 'MARK thread' }, then: text('a', 'a') }], { messages: [{ role: 'user', content: said }] })?.id).toBe('raw')
  })
})

describe('fake model server', () => {
  let server: Awaited<ReturnType<typeof startFakeModelServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const ask = (content: string, signal?: AbortSignal) =>
    fetch(`${server!.baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'fake-2', messages: [{ role: 'user', content }] }),
      ...(signal && { signal }),
    })

  test('streams matcher parts as chat completion chunks, with per-part delays', async () => {
    server = await startFakeModelServer({
      matchers: [{
        id: 'slow-tool',
        when: { latestUserTextIncludes: 'SLOW' },
        then: {
          parts: [
            { type: 'text-delta', id: 't', delta: 'working' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'bash', input: '{"command":"true"}' },
            { type: 'finish', finishReason: 'tool-calls' },
          ],
          partDelaysMs: [0, 300, 0],
        },
      }],
    })
    const started = Date.now()
    const body = await (await ask('SLOW please')).text()
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    const chunks = body.split('\n\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)))
    const deltas = chunks.flatMap((chunk) => chunk.choices.map((choice: { delta: unknown; finish_reason: unknown }) => [choice.delta, choice.finish_reason]))
    expect(deltas).toEqual([
      [{ role: 'assistant' }, null],
      [{ content: 'working' }, null],
      [{ tool_calls: [{ index: 0, id: 'call-1_1_0', type: 'function', function: { name: 'bash', arguments: '{"command":"true"}' } }] }, null],
      [{}, 'tool_calls'],
    ])
    expect(chunks[0].model).toBe('fake-2')
    expect(server.log.map((request) => [request.matcher, request.model, request.aborted])).toEqual([['slow-tool', 'fake-2', false]])
  })

  test('a multi-byte character split across request chunks survives', async () => {
    server = await startFakeModelServer({
      matchers: [{ id: 'cafe', when: { latestUserTextIncludes: 'café' }, then: { parts: [{ type: 'text-delta', id: 't', delta: 'x' }] } }],
    })
    const body = Buffer.from(JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'café' }] }))
    const split = body.indexOf(Buffer.from('é')) + 1
    // Two writes, the first ending inside 'é'.
    const { request } = await import('node:http')
    await new Promise<void>((resolve, reject) => {
      const req = request(`${server!.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-length': body.length } }, (res) => {
        res.resume()
        res.on('end', resolve)
      })
      req.on('error', reject)
      req.write(body.subarray(0, split))
      setTimeout(() => req.end(body.subarray(split)), 50)
    })
    expect(server.log[0]?.matcher).toBe('cafe')
  })

  test("the finish part's usage is reported", async () => {
    server = await startFakeModelServer({
      matchers: [{ id: 'big', then: { parts: [{ type: 'text-delta', id: 't', delta: 'x' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 15_000, outputTokens: 1, totalTokens: 15_001 } }] } }],
    })
    const body = await (await ask('anything')).text()
    const chunks = body.split('\n\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)))
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 15_000, completion_tokens: 1, total_tokens: 15_001 })
  })

  test('an error matcher fails the request with its status', async () => {
    server = await startFakeModelServer({ matchers: [{ id: 'overloaded', then: { error: { status: 529, message: 'Overloaded' } } }] })
    const response = await ask('anything')
    expect(response.status).toBe(529)
    expect(await response.json()).toMatchObject({ error: { message: 'Overloaded' } })
  })

  test('records a client abort mid-stream', async () => {
    server = await startFakeModelServer({
      matchers: [{ id: 'hang', then: { parts: [{ type: 'text-delta', id: 't', delta: 'x' }], partDelaysMs: [5_000] } }],
    })
    const controller = new AbortController()
    const response = await ask('hang', controller.signal)
    controller.abort()
    await response.text().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.log[0]?.aborted).toBe(true)
  })

  test('without a matching matcher, the built-in script answers', async () => {
    server = await startFakeModelServer()
    const body = await (await ask('hi')).text()
    const said = body.split('\n\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)).choices[0]?.delta?.content ?? '').join('')
    expect(said).toBe('hello from the fake model')
    expect(server.log[0]?.matcher).toBe('script')
  })
})
