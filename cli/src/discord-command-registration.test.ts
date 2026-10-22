// Tests Discord slash command payloads for quick agent commands.

import { describe, expect, test } from 'vitest'
import {
  buildQuickAgentSlashCommand,
  buildStaticSlashCommands,
} from './discord-command-registration.js'

describe('buildQuickAgentSlashCommand', () => {
  test('puts variant last after prompt', () => {
    const command = buildQuickAgentSlashCommand({
      commandName: 'plan-agent',
      description: 'Switch to plan agent',
    }).toJSON()

    expect(command.options?.map((option) => option.name)).toMatchInlineSnapshot(`
      [
        "prompt",
        "variant",
      ]
    `)
  })
})

describe('buildStaticSlashCommands', () => {
  test('channel registers optional bind behavior and required behavior-change choices', () => {
    const commands = buildStaticSlashCommands()
    expect(commands.some((command) => command.name === 'toggle-mention-mode')).toBe(false)
    const channel = commands.find((command) => command.name === 'channel')
    expect(channel?.options?.map((option) => option.name)).toEqual(['bind', 'behavior', 'unbind'])
    for (const name of ['bind', 'behavior']) {
      const subcommand = channel?.options?.find((option) => option.name === name)
      if (!subcommand || !('options' in subcommand)) throw new Error('Missing subcommand')
      const behavior = subcommand.options?.find((option) => option.name === 'behavior')
      expect(behavior?.required ?? false).toBe(name === 'behavior')
      if (!behavior || !('choices' in behavior)) throw new Error('Missing choices')
      expect(behavior.choices?.map((choice) => choice.value)).toEqual(['always', 'mention', 'listen', 'off'])
    }
  })
  test('fork registers prompt and from options without a workspace option', () => {
    const fork = buildStaticSlashCommands().find((command) => command.name === 'fork')
    expect(fork).toBeDefined()
    expect(fork?.options?.map((option) => option.name)).toEqual(['prompt', 'from'])
    expect(fork?.options?.map((option) => option.name)).not.toContain('workspace')
  })
})

describe('person commands', () => {
  test('registers /connect, /link and /start as ephemeral-reply guild commands', () => {
    const names = buildStaticSlashCommands().map((command) => command.name)
    expect(names).toContain('connect')
    expect(names).toContain('link')
    expect(names).toContain('start')
    for (const name of ['connect', 'link', 'start']) {
      const command = buildStaticSlashCommands().find((entry) => entry.name === name)
      expect(command?.options ?? []).toEqual([])
      expect(command?.description.length).toBeLessThanOrEqual(100)
    }
  })
})
