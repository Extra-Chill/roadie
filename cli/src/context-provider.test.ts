// Host context provider: stdin contract, output validation, bounds, fail-open
// behavior and rendering.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import {
  renderContextSections,
  requestContext,
  setContextProviderCommand,
  speakerKey,
} from './context-provider.js'

let dir: string
const writeProvider = (name: string, body: string) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-context-'))
})
afterEach(() => {
  setContextProviderCommand(undefined)
})

describe('requestContext', () => {
  test('no provider configured returns nothing', async () => {
    setContextProviderCommand(null)
    expect(await requestContext({ event: 'session_start', sessionId: 's' })).toEqual([])
  })

  test('sends the versioned contract and returns sections', async () => {
    const stdinFile = path.join(dir, 'stdin.json')
    setContextProviderCommand(
      writeProvider(
        'ok.sh',
        `cat > ${stdinFile}; echo '{"sections":[{"id":"user-memory","title":"About Dee","content":"Dee likes jam bands."}]}'`,
      ),
    )
    const sections = await requestContext({
      event: 'turn',
      sessionId: 'ses_1',
      threadId: 't1',
      channelId: 'c1',
      directory: '/srv/site',
      actor: { platform: 'discord', id: '42', name: 'Dee' },
      personId: 'host:42',
    })
    expect(sections).toEqual([{ id: 'user-memory', title: 'About Dee', content: 'Dee likes jam bands.' }])
    expect(JSON.parse(fs.readFileSync(stdinFile, 'utf8'))).toEqual({
      version: 1,
      event: 'turn',
      session_id: 'ses_1',
      thread_id: 't1',
      channel_id: 'c1',
      directory: '/srv/site',
      actor: { platform: 'discord', id: '42', name: 'Dee' },
      person_id: 'host:42',
    })
  })

  test.each([
    ['non-zero exit', 'cat >/dev/null; exit 2'],
    ['invalid JSON', 'cat >/dev/null; echo nope'],
    ['schema mismatch', `cat >/dev/null; echo '{"sections":"x"}'`],
  ])('fails open on %s', async (_label, body) => {
    setContextProviderCommand(writeProvider(`bad-${_label.replace(/\W/g, '')}.sh`, body))
    expect(await requestContext({ event: 'session_start', sessionId: 's' })).toEqual([])
  })

  test('drops empty sections and truncates oversized ones', async () => {
    const big = 'x'.repeat(70_000)
    setContextProviderCommand(
      writeProvider(
        'big.sh',
        `cat >/dev/null; printf '%s' '{"sections":[{"id":"empty","content":"  "},{"id":"big","content":"${big}"}]}'`,
      ),
    )
    const sections = await requestContext({ event: 'session_start', sessionId: 's' })
    expect(sections.map((s) => s.id)).toEqual(['big'])
    expect(sections[0]!.content.endsWith('…[truncated]')).toBe(true)
    expect(sections[0]!.content.length).toBeLessThan(70_000)
  })
})

describe('rendering and speaker keys', () => {
  test('renders sections as a host-context block, escaping attributes', () => {
    expect(renderContextSections([])).toBe('')
    expect(
      renderContextSections([
        { id: 'a', title: 'Say "hi"', content: 'one' },
        { id: 'b', content: 'two' },
      ]),
    ).toBe(
      '\n<host-context>\n<context id="a" title="Say &quot;hi&quot;">\none\n</context>\n\n<context id="b">\ntwo\n</context>\n</host-context>\n',
    )
  })

  test('person id wins over actor; no speaker is "none"', () => {
    expect(speakerKey({ personId: 'host:1', actor: { platform: 'discord', id: '9' } })).toBe('person:host:1')
    expect(speakerKey({ actor: { platform: 'discord', id: '9' } })).toBe('discord:9')
    expect(speakerKey({})).toBe('none')
  })
})
