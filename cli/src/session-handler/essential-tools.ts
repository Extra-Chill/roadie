// Which tool parts count as "essential" for text-and-essential-tools verbosity.

import type { AgentPart } from '../agent-backend/events.js'

/**
 * Built-in read-only tools that are hidden in default verbosity mode.
 * Any tool NOT in this list is considered "essential" and shown,
 * which means custom tools, MCP tools, and plugin tools are visible by default.
 */
const HIDDEN_READONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'describe-media',
  'todoread',
]

/** Check if a tool part is "essential" (shown in text-and-essential-tools mode). */
export function isEssentialToolName(toolName: string): boolean {
  // Hide known read-only built-in tools; show everything else
  // (custom tools, MCP tools, plugin tools are visible by default)
  return !HIDDEN_READONLY_TOOLS.some((name) => {
    return toolName === name || toolName.endsWith(`_${name}`)
  })
}

export function isEssentialToolPart(part: AgentPart): boolean {
  if (part.kind !== 'tool') {
    return false
  }
  if (!isEssentialToolName(part.tool)) {
    return false
  }
  if (part.tool === 'bash') {
    const hasSideEffect = part.input?.hasSideEffect
    return hasSideEffect !== false
  }
  return true
}
