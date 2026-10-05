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
  test('fork registers prompt and from options without a workspace option', () => {
    const fork = buildStaticSlashCommands().find((command) => command.name === 'fork')
    expect(fork).toBeDefined()
    expect(fork?.options?.map((option) => option.name)).toEqual(['prompt', 'from'])
    expect(fork?.options?.map((option) => option.name)).not.toContain('workspace')
  })
})
