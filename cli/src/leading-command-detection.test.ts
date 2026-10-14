import { describe, test, expect } from 'vitest'
import { extractLeadingCommand } from './leading-command-detection.js'
import type { RegisteredUserCommand } from './store.js'

const fixtures: RegisteredUserCommand[] = [
  {
    name: 'build',
    discordCommandName: 'build-cmd',
    description: 'build the project',
    source: 'command',
  },
  {
    name: 'namespace:foo',
    discordCommandName: 'namespace-foo-cmd',
    description: 'namespaced',
    source: 'command',
  },
  {
    name: 'review',
    discordCommandName: 'review-skill',
    description: 'review skill',
    source: 'skill',
  },
  {
    name: 'plan',
    discordCommandName: 'plan-mcp-prompt',
    description: 'plan via mcp',
    source: 'mcp',
  },
]

describe('extractLeadingCommand', () => {
  test('plain /build with args', () => {
    expect(
      extractLeadingCommand('/build foo bar', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "foo bar",
          "name": "build",
        },
      }
    `)
  })

  test('plain /build no args', () => {
    expect(extractLeadingCommand('/build', fixtures))
      .toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "",
          "name": "build",
        },
      }
    `)
  })

  test('/build-cmd suffix resolves to build', () => {
    expect(
      extractLeadingCommand('/build-cmd hello world', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "hello world",
          "name": "build",
        },
      }
    `)
  })

  test('-skill suffix', () => {
    expect(
      extractLeadingCommand('/review-skill a b', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "a b",
          "name": "review",
        },
      }
    `)
  })

  test('-mcp-prompt suffix', () => {
    expect(
      extractLeadingCommand('/plan-mcp-prompt go', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "go",
          "name": "plan",
        },
      }
    `)
  })

  test('original namespaced name with colon', () => {
    expect(
      extractLeadingCommand('/namespace:foo arg', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "arg",
          "name": "namespace:foo",
        },
      }
    `)
  })

  test('discord-sanitized namespaced name', () => {
    expect(
      extractLeadingCommand('/namespace-foo-cmd arg', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "arg",
          "name": "namespace:foo",
        },
      }
    `)
  })

  test('roadie-cli prefix on its own line', () => {
    expect(
      extractLeadingCommand(
        '» **roadie-cli:**\n/build foo bar',
        fixtures,
      ),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "foo bar",
          "name": "build",
        },
      }
    `)
  })

  test('queue-style user prefix on its own line', () => {
    expect(
      extractLeadingCommand('» **Tommy:**\n/build hey', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "hey",
          "name": "build",
        },
      }
    `)
  })

  test('username containing asterisk on its own line', () => {
    expect(
      extractLeadingCommand('» **A*B:**\n/build hi', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "hi",
          "name": "build",
        },
      }
    `)
  })

  test('Context from thread wrapping still detects command', () => {
    const wrapped =
      'Context from thread:\nsome starter text\n\nUser request:\n/build foo'
    expect(extractLeadingCommand(wrapped, fixtures))
      .toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "foo",
          "name": "build",
        },
      }
    `)
  })

  test('unknown command returns null', () => {
    expect(
      extractLeadingCommand('/nothing here', fixtures),
    ).toMatchInlineSnapshot(`null`)
  })

  test('no leading slash on any line returns null', () => {
    expect(
      extractLeadingCommand('hello /build\nmore text', fixtures),
    ).toMatchInlineSnapshot(`null`)
  })

  test('just slash returns null', () => {
    expect(extractLeadingCommand('/', fixtures)).toMatchInlineSnapshot(
      `null`,
    )
  })

  test('empty string returns null', () => {
    expect(extractLeadingCommand('', fixtures)).toMatchInlineSnapshot(
      `null`,
    )
  })

  test('empty registry returns null for tokens without Discord suffix', () => {
    expect(extractLeadingCommand('/build foo', [])).toMatchInlineSnapshot(
      `null`,
    )
  })

  test('empty registry fallback: -cmd suffix strips and returns base name', () => {
    expect(
      extractLeadingCommand('/hello-test-cmd', []),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "",
          "name": "hello-test",
        },
      }
    `)
  })

  test('empty registry fallback: -skill suffix with args', () => {
    expect(
      extractLeadingCommand('/review-skill check auth', []),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "check auth",
          "name": "review",
        },
      }
    `)
  })

  test('empty registry fallback skips non-suffixed, matches suffixed on next line', () => {
    expect(
      extractLeadingCommand('/unknown\n/deploy-cmd now', []),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "now",
          "name": "deploy",
        },
      }
    `)
  })

  test('leading whitespace before slash still matches', () => {
    expect(
      extractLeadingCommand('   /build foo', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "foo",
          "name": "build",
        },
      }
    `)
  })

  test('first matching line wins', () => {
    const prompt = 'noise line\n/build first args\n/review second args'
    expect(extractLeadingCommand(prompt, fixtures))
      .toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "first args",
          "name": "build",
        },
      }
    `)
  })

  test('unknown command on one line, known on next', () => {
    const prompt = '/unknown foo\n/build bar'
    expect(extractLeadingCommand(prompt, fixtures))
      .toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "bar",
          "name": "build",
        },
      }
    `)
  })

  test('suffix strip does not clobber a command whose name happens to end in -cmd', () => {
    const custom: RegisteredUserCommand[] = [
      {
        name: 'deploy-cmd',
        discordCommandName: 'deploy-cmd-cmd',
        description: '',
        source: 'command',
      },
    ]
    expect(
      extractLeadingCommand('/deploy-cmd now', custom),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "now",
          "name": "deploy-cmd",
        },
      }
    `)
  })
})
