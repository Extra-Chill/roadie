// Agent definitions for Pi sessions.
//
// Roadie maps OpenCode-format project config onto Pi turns:
// - `catalog.agents` lists built-in agents plus `.opencode/agents|agent/*.md`
//   and `agent` entries in `opencode.json[c]`;
// - a selected agent contributes its system prompt, model and permission rules;
// - agent rules precede session rules, with last-match-wins evaluation.
// Built-in agents keep Pi's base prompt and apply their permission defaults.

import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { AgentDefinition, AgentModelSelection, AgentPermissionRule } from '../types.js'

export type PiAgent = {
  name: string
  description?: string
  mode: string
  hidden?: boolean
  model?: AgentModelSelection
  /** The markdown body: a system prompt appended to the turn's. */
  prompt?: string
  permission: AgentPermissionRule[]
}

/** OpenCode-format project config `agent` entries in `opencode.json` / agent markdown frontmatter. */
type ProjectAgentConfig = {
  description?: string
  mode?: string
  model?: string
  prompt?: string
  permission?: unknown
  hidden?: boolean
  disable?: boolean
}

const ACTIONS = new Set(['allow', 'deny', 'ask'])

/** `permission: { edit: "ask", bash: { "*": "ask", "git status": "allow" } }` as rules. */
export function parseProjectPermissionRules(raw: unknown): AgentPermissionRule[] {
  if (!raw || typeof raw !== 'object') return []
  const rules: AgentPermissionRule[] = []
  for (const [permission, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && ACTIONS.has(value)) {
      rules.push({ permission, pattern: '*', action: value as AgentPermissionRule['action'] })
      continue
    }
    if (value && typeof value === 'object') {
      for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
        if (typeof action === 'string' && ACTIONS.has(action)) {
          rules.push({ permission, pattern, action: action as AgentPermissionRule['action'] })
        }
      }
    }
  }
  return rules
}

function toModelSelection(model: unknown): AgentModelSelection | undefined {
  if (typeof model !== 'string') return undefined
  const separator = model.indexOf('/')
  if (separator <= 0) return undefined
  return { providerId: model.slice(0, separator), modelId: model.slice(separator + 1) }
}

function fromConfig(name: string, config: ProjectAgentConfig): PiAgent {
  return {
    name,
    ...(config.description && { description: config.description }),
    mode: typeof config.mode === 'string' ? config.mode : 'all',
    ...(config.hidden === true && { hidden: true }),
    ...(toModelSelection(config.model) && { model: toModelSelection(config.model)! }),
    ...(typeof config.prompt === 'string' && { prompt: config.prompt }),
    permission: parseProjectPermissionRules(config.permission),
  }
}

/** One `.opencode/agents|agent/<name>.md` file: frontmatter config, body prompt. */
export function parseAgentMarkdown({ file, content }: { file: string; content: string }): PiAgent | undefined {
  const match = /^---\r?\n(.*)\r?\n---\r?\n?/s.exec(content)
  let config: ProjectAgentConfig = {}
  let prompt = content
  if (match) {
    try {
      config = YAML.parse(match[1]!) as ProjectAgentConfig
    } catch {
      return undefined
    }
    if (!config || typeof config !== 'object') return undefined
    if (config.disable === true) return undefined
    prompt = content.slice(match[0].length)
  }
  const name = path.basename(file).replace(/\.md$/, '')
  if (!/^[\w.-]+$/.test(name)) return undefined
  const agent = fromConfig(name, config)
  const body = prompt.trim()
  return { ...agent, ...(body && { prompt: body }) }
}

/** Built-in primary and subagent definitions. */
const BUILT_INS: PiAgent[] = [
  { name: 'build', description: 'Default agent with all tools enabled', mode: 'primary', permission: [] },
  {
    name: 'plan',
    description: 'Planning and analysis; edits and commands ask first',
    mode: 'primary',
    permission: parseProjectPermissionRules({ edit: 'ask', bash: 'ask' }),
  },
  { name: 'general', description: 'General-purpose subagent for research and multi-step tasks', mode: 'subagent', permission: [] },
  { name: 'explore', description: 'Read-only subagent for exploring codebases', mode: 'subagent', permission: parseProjectPermissionRules({ edit: 'deny' }) },
  { name: 'scout', description: 'Read-only subagent for external docs and dependency research', mode: 'subagent', permission: parseProjectPermissionRules({ edit: 'deny' }) },
]

/** The project's agents: `.opencode/agents|agent/*.md` plus `opencode.json` `agent` entries. */
export function projectAgents(directory: string): PiAgent[] {
  const agents = new Map<string, PiAgent>()
  for (const parent of ['agents', 'agent']) {
    const dir = path.join(directory, '.opencode', parent)
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const agent = parseAgentMarkdown({ file: path.join(dir, file), content: fs.readFileSync(path.join(dir, file), 'utf8') })
        if (agent) agents.set(agent.name, agent)
      } catch {}
    }
  }
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    let config: { agent?: Record<string, ProjectAgentConfig> }
    try {
      config = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { agent?: Record<string, ProjectAgentConfig> }
    } catch {
      continue
    }
    for (const [agentName, entry] of Object.entries(config.agent ?? {})) {
      if (!entry || typeof entry !== 'object' || entry.disable === true || !/^[\w.-]+$/.test(agentName)) continue
      agents.set(agentName, fromConfig(agentName, entry))
    }
  }
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A project definition named like a built-in customizes it:
 * the project's fields win, and its permission rules come after the
 * built-in's so they take precedence (last match wins).
 */
function overlay(builtIn: PiAgent, project: PiAgent | undefined): PiAgent {
  if (!project) return builtIn
  return {
    ...builtIn,
    ...project,
    ...(!project.description && builtIn.description && { description: builtIn.description }),
    permission: [...builtIn.permission, ...project.permission],
  }
}

/** Built-ins (with project customizations) followed by the project's own agents. */
function resolvedAgents(directory?: string): PiAgent[] {
  const project = directory ? projectAgents(directory) : []
  const byName = new Map(project.map((agent) => [agent.name, agent]))
  return [
    ...BUILT_INS.map((builtIn) => overlay(builtIn, byName.get(builtIn.name))),
    ...project.filter((agent) => !BUILT_INS.some((builtIn) => builtIn.name === agent.name)),
  ]
}

/** Every agent a Pi session can run as, in Roadie's catalog shape. */
export function piAgents(directory?: string): AgentDefinition[] {
  return resolvedAgents(directory).map((agent): AgentDefinition => ({
    name: agent.name,
    ...(agent.description && { description: agent.description }),
    mode: agent.mode,
    ...(agent.hidden && { hidden: true }),
    ...(agent.model && { model: agent.model }),
  }))
}

/** The agent a turn runs as, or undefined when the name is unknown. */
export function agentFor({ directory, agent }: { directory: string; agent: string }): PiAgent | undefined {
  return resolvedAgents(directory).find((candidate) => candidate.name === agent)
}
