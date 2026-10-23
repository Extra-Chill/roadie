// OpenCode-format agent definitions for Pi: markdown/opencode.json parsing,
// permission conversion, and what catalog.agents lists.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { agentFor, parseProjectPermissionRules, parseAgentMarkdown, piAgents, projectAgents } from './agents.js'

function projectWithAgents(): string {
  const dir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pi-agents-'))
  fs.mkdirSync(path.join(dir, '.opencode', 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.opencode', 'agents', 'review.md'), [
    '---',
    'description: Reviews code for quality',
    'mode: subagent',
    'model: anthropic/claude-sonnet-4-20250514',
    'permission:',
    '  edit: deny',
    '  bash:',
    '    "*": ask',
    '    "git diff": allow',
    '---',
    'You are in code review mode.',
    'Focus on quality.',
    '',
  ].join('\n'))
  fs.mkdirSync(path.join(dir, '.opencode', 'agent'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.opencode', 'agent', 'docs.md'), '---\ndescription: Writes docs\nmode: primary\n---\n\nYou write documentation.\n')
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({
    agent: {
      auditor: { description: 'Audits dependencies', mode: 'subagent', model: 'openai/gpt-6', permission: { edit: 'deny' } },
      gone: { disable: true, description: 'disabled', mode: 'primary' },
    },
  }))
  return dir
}

describe('parseProjectPermissionRules', () => {
  test('shorthand and pattern forms become rules, last match wins order', () => {
    expect(parseProjectPermissionRules({ edit: 'deny', bash: { '*': 'ask', 'git diff': 'allow' }, webfetch: 'nope' })).toEqual([
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'git diff', action: 'allow' },
    ])
    expect(parseProjectPermissionRules(undefined)).toEqual([])
    expect(parseProjectPermissionRules('deny')).toEqual([])
  })
})

describe('parseAgentMarkdown', () => {
  test('name from file, frontmatter config, body as prompt', () => {
    const agent = parseAgentMarkdown({ file: '/p/.opencode/agents/review.md', content: '---\ndescription: Reviews code\nmode: subagent\n---\nBe thorough.\n' })
    expect(agent).toEqual({ name: 'review', description: 'Reviews code', mode: 'subagent', permission: [], prompt: 'Be thorough.' })
  })

  test('defaults and a disable flag', () => {
    expect(parseAgentMarkdown({ file: '/p/.opencode/agents/plain.md', content: 'Just a prompt.' }))
      .toEqual({ name: 'plain', mode: 'all', permission: [], prompt: 'Just a prompt.' })
    expect(parseAgentMarkdown({ file: '/p/.opencode/agents/off.md', content: '---\ndisable: true\n---\nNope.\n' })).toBeUndefined()
    expect(parseAgentMarkdown({ file: '/p/.opencode/agents/bad.md', content: '---\ndescription: [unclosed\n---\nNope.\n' })).toBeUndefined()
  })
})

describe('piAgents / projectAgents / agentFor', () => {
  test('built-ins always list; project agents come from both directories and opencode.json', () => {
    const dir = projectWithAgents()
    const names = piAgents(dir).map((agent) => agent.name)
    expect(names).toEqual(['build', 'plan', 'general', 'explore', 'scout', 'auditor', 'docs', 'review'])
    expect(piAgents().map((agent) => agent.name)).toEqual(['build', 'plan', 'general', 'explore', 'scout'])
    const review = projectAgents(dir).find((agent) => agent.name === 'review')
    expect(review).toEqual({
      name: 'review',
      description: 'Reviews code for quality',
      mode: 'subagent',
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
      prompt: 'You are in code review mode.\nFocus on quality.',
      permission: [
        { permission: 'edit', pattern: '*', action: 'deny' },
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'bash', pattern: 'git diff', action: 'allow' },
      ],
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a selected agent resolves with its turn config; built-ins carry documented rules', () => {
    const dir = projectWithAgents()
    expect(agentFor({ directory: dir, agent: 'review' })?.prompt).toContain('code review mode')
    expect(agentFor({ directory: dir, agent: 'build' })?.permission).toEqual([])
    expect(agentFor({ directory: dir, agent: 'plan' })?.permission).toEqual([
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: '*', action: 'ask' },
    ])
    expect(agentFor({ directory: dir, agent: 'nope' })).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a project agent named like a built-in customizes it instead of being shadowed', () => {
    const dir = projectWithAgents()
    fs.writeFileSync(path.join(dir, '.opencode', 'agents', 'plan.md'), [
      '---',
      'mode: primary',
      'model: anthropic/claude-plan',
      'permission:',
      '  bash:',
      '    "git status": allow',
      '---',
      'Plan carefully.',
    ].join('\n'))
    const plan = agentFor({ directory: dir, agent: 'plan' })
    expect(plan?.model).toEqual({ providerId: 'anthropic', modelId: 'claude-plan' })
    expect(plan?.prompt).toBe('Plan carefully.')
    expect(plan?.description).toBe('Planning and analysis; edits and commands ask first')
    // The built-in's rules still apply; the project's come later and win.
    expect(plan?.permission).toEqual([
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'git status', action: 'allow' },
    ])
    const listed = piAgents(dir).filter((agent) => agent.name === 'plan')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.model).toEqual({ providerId: 'anthropic', modelId: 'claude-plan' })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
