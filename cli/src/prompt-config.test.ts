// Host prompt config: parsing, section disable/replace/append, reload, and
// that the default render is unchanged.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import {
  applyPromptConfig,
  BUILTIN_PROMPT_SECTION_IDS,
  getPromptConfig,
  parsePromptConfig,
  setPromptConfigPath,
} from './prompt-config.js'
import { getSystemMessage } from './system-message.js'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-prompt-config-'))
})
afterEach(() => {
  setPromptConfigPath(undefined)
})

const sections = [
  { id: 'a', text: '\n## a\nalpha\n' },
  { id: 'b', text: '\n## b\nbeta\n' },
]

describe('applyPromptConfig', () => {
  test('no config renders intro plus every section unchanged', () => {
    expect(applyPromptConfig({ intro: 'X', sections, config: null })).toBe('X\n## a\nalpha\n\n## b\nbeta\n')
  })

  test('disable, replace and append', () => {
    const extra = path.join(dir, 'extra.md')
    fs.writeFileSync(extra, '## extra\nfrom file\n')
    const out = applyPromptConfig({
      intro: 'X',
      sections,
      config: {
        disable: ['a'],
        replace: { b: '## b\nBETA' },
        append: [
          { id: 'house', content: '## house rules\nbe kind' },
          { id: 'extra', file: extra },
        ],
      },
    })
    expect(out).toBe('X\n## b\nBETA\n\n## house rules\nbe kind\n\n## extra\nfrom file\n')
  })

  test('an unreadable append file is skipped', () => {
    const out = applyPromptConfig({
      intro: 'X',
      sections,
      config: { append: [{ id: 'gone', file: path.join(dir, 'missing.md') }] },
    })
    expect(out).toBe('X\n## a\nalpha\n\n## b\nbeta\n')
  })
})

describe('parsePromptConfig', () => {
  test.each([
    ['unknown key', 'remove: [a]\n'],
    ['append without content or file', 'append:\n  - id: x\n'],
    ['append with both', 'append:\n  - id: x\n    content: c\n    file: f\n'],
    ['broken yaml', 'disable: [\n'],
  ])('rejects %s', (_label, text) => {
    expect(parsePromptConfig(text)).toBeInstanceOf(Error)
  })

  test('accepts JSON', () => {
    expect(parsePromptConfig('{"disable":["permissions"]}')).toEqual({ disable: ['permissions'] })
  })
})

describe('system prompt with a config file', () => {
  test.each(['discord', 'slack'])('commands alone retain the CLI reference on %s', (platform) => {
    const file = path.join(dir, `commands-${platform}.json`)
    fs.writeFileSync(file, JSON.stringify({
      disable: BUILTIN_PROMPT_SECTION_IDS.filter((id) => id !== 'commands'),
    }))
    setPromptConfigPath(file)
    const message = getSystemMessage({ platform, sessionId: 'current-session', channelId: 'current-channel', threadId: 'current-thread' })
    for (const command of [
      'upload-to-discord', 'upload-to-chat', 'session archive', 'session title',
      'send --thread', 'send --channel', '--notify-only', '--send-at',
      'session search', 'session read', 'session fork', 'session wait',
      'task list', 'task edit', 'task delete', 'project list', '/roadie.log',
    ]) {
      expect(message).toContain(command)
    }
    for (const debt of ['hasSideEffect', 'ses_xxx', 'opencode.json', 'current-session', 'current-channel', 'current-thread']) {
      expect(message).not.toContain(debt)
    }
    expect(message).toContain('Local Markdown image paths do not render')
    expect(message).toContain('only when the user asks')
    expect(message).toContain('$ROADIE_THREAD_ID')
    expect(message).toContain('$ROADIE_CHANNEL_ID')
    expect(message).not.toContain('## scheduling guidance')
  })

  test('disabling a built-in section removes it; invalid files fall back to the built-in prompt', () => {
    const file = path.join(dir, 'prompt.yaml')
    fs.writeFileSync(file, 'disable: [permissions, upgrading]\nappend:\n  - id: host\n    content: "## host section\\nhello"\n')
    setPromptConfigPath(file)
    const message = getSystemMessage({ sessionId: 'ses_1' })
    expect(message).not.toContain('## permissions')
    expect(message).not.toContain('## upgrading roadie')
    expect(message).toContain('## host section\nhello')
    expect(message).toContain('## discord output'.replace('discord output', 'Discord output'))

    fs.writeFileSync(file, 'disable: [\n')
    const t = new Date(Date.now() + 10_000)
    fs.utimesSync(file, t, t)
    expect(getPromptConfig()).toBeNull()
    expect(getSystemMessage({ sessionId: 'ses_1' })).toContain('## permissions')
  })

  test('no config file leaves the built-in prompt and drops removed features', () => {
    setPromptConfigPath(null)
    const message = getSystemMessage({ sessionId: 'ses_1' })
    expect(message).toContain('## permissions')
    expect(message).not.toContain('roadie tts')
  })
})
