// Roadie's permission policy: which tool calls a session may make.
//
// Roadie owns the rules; the agent backend enforces them. Rules come from
// checkout isolation (a thread in a separate git checkout may not touch the
// origin checkout), `roadie send --permission`, channel policy, the identity
// layer, and plugins (the `permission_rules` filter). The last matching rule
// wins, so later sources override earlier ones.
//
// Backends with their own permission engine (OpenCode) receive the rules on
// session create/update. Backends without one call `evaluatePermission` before
// running a tool: "ask" means Roadie shows an approval prompt in chat.

import { applyFilters } from './hooks.js'
import type { AgentPermissionRule } from './agent-backend/types.js'

export type PermissionAction = AgentPermissionRule['action']

/**
 * Build the per-session permission ruleset passed to session.create/update.
 *
 * Keep this list minimal. Session rules are the LAST ruleset opencode
 * evaluates — `Permission.merge(agent.permission, session.permission)` in
 * session/tools.ts, then `findLast()` in permission/index.ts — so every rule
 * here silently overrides the user's own opencode.json. Only rules that must
 * beat user config belong here.
 *
 * In particular, directory *allow* rules must NOT go here. They live in the
 * server config so a project opencode.json can still deny or ask for specific
 * folders. Putting an `external_directory: '*' allow` rule here would make
 * every user `deny` rule a no-op.
 *
 * The session's own working directory never needs a rule either: opencode skips
 * the external_directory gate entirely for paths inside the active instance
 * (`containsPath` in tool/external-directory.ts).
 *
 * That leaves one rule: checkout isolation. A thread bound to a separate git
 * checkout (`--cwd`) is denied the origin checkout so it does not edit the main repo.
 */
export function buildSessionPermissions({
  directory,
  originalRepoDirectory,
}: {
  directory: string
  originalRepoDirectory?: string
}): AgentPermissionRule[] {
  // Normalize path separators for cross-platform compatibility (Windows uses backslashes)
  const normalizedDirectory = directory.replaceAll('\\', '/')
  const originalRepo = originalRepoDirectory?.replaceAll('\\', '/')

  if (!originalRepo || originalRepo === normalizedDirectory) {
    return []
  }

  return buildExternalDirectoryPermissionRules({
    resolvedPattern: originalRepo,
    action: 'deny',
  })
}

const ALL_EXTERNAL_DIRECTORIES_PATTERN = '*'

function buildExternalDirectoryPermissionRules({
  resolvedPattern,
  action,
}: {
  resolvedPattern: string
  action: 'allow' | 'deny' | 'ask'
}): AgentPermissionRule[] {
  if (resolvedPattern === ALL_EXTERNAL_DIRECTORIES_PATTERN) {
    return [
      {
        permission: 'external_directory',
        pattern: ALL_EXTERNAL_DIRECTORIES_PATTERN,
        action,
      },
    ]
  }

  return [
    {
      permission: 'external_directory',
      pattern: resolvedPattern,
      action,
    },
    {
      permission: 'external_directory',
      pattern: `${resolvedPattern}/*`,
      action,
    },
  ]
}

/**
 * Parse raw permission strings into permission rules.
 *
 * Accepted formats:
 *   "tool:action"           → { permission: tool, pattern: "*", action }
 *   "tool:pattern:action"   → { permission: tool, pattern,      action }
 *
 * The action must be one of "allow", "deny", "ask" (case-insensitive).
 * Parts are trimmed to tolerate whitespace from YAML deserialization.
 * Invalid entries are silently skipped (bad user input shouldn't crash the bot).
 * If `raw` is not an array, returns empty (defensive against malformed YAML markers).
 */
export function parsePermissionRules(raw: unknown): AgentPermissionRule[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const validActions = new Set(['allow', 'deny', 'ask'])
  return raw.flatMap((entry) => {
    if (typeof entry !== 'string') {
      return []
    }
    const parts = entry.split(':').map((s) => {
      return s.trim()
    })
    if (parts.length === 2) {
      const [permission, rawAction] = parts
      const action = rawAction!.toLowerCase()
      if (!permission || !validActions.has(action)) {
        return []
      }
      return [{ permission, pattern: '*', action: action as 'allow' | 'deny' | 'ask' }]
    }
    if (parts.length >= 3) {
      // Last segment is the action, first segment is the permission,
      // everything in between is the pattern (may contain colons in theory,
      // but unlikely for tool patterns).
      const permission = parts[0]!
      const rawAction = parts[parts.length - 1]!
      const action = rawAction.toLowerCase()
      const pattern = parts.slice(1, -1).join(':')
      if (!permission || !pattern || !validActions.has(action)) {
        return []
      }
      return [{ permission, pattern, action: action as 'allow' | 'deny' | 'ask' }]
    }
    return []
  })
}

/** Glob match used for permission patterns: `*` any run, `?` one character. */
export function matchesPermissionPattern({ value, pattern }: { value: string; pattern: string }): boolean {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  // "git *" also matches bare "git".
  if (regex.endsWith(' .*')) {
    regex = regex.slice(0, -3) + '( .*)?'
  }
  return new RegExp(`^${regex}$`, 's').test(value)
}

/**
 * Decide one tool call. Every target (a command, a path) must be allowed;
 * any deny wins, then any ask. Returns `fallback` when no rule matches a
 * target, so callers keep the backend's own default for unlisted tools.
 */
export function evaluatePermission({
  rules,
  permission,
  targets,
  fallback = 'ask',
}: {
  rules: AgentPermissionRule[]
  permission: string
  targets: string[]
  fallback?: PermissionAction
}): PermissionAction {
  const decisions = (targets.length > 0 ? targets : ['*']).map((target) => {
    const match = rules.findLast((rule) =>
      matchesPermissionPattern({ value: permission, pattern: rule.permission })
      && matchesPermissionPattern({ value: target, pattern: rule.pattern }),
    )
    return match?.action ?? fallback
  })
  if (decisions.includes('deny')) return 'deny'
  if (decisions.includes('ask')) return 'ask'
  return 'allow'
}

export type PermissionRulesContext = {
  directory: string
  /** "create": the full rule set for a new session; "update": rules added to an existing one. */
  phase: 'create' | 'update'
}

/** The rules for a session, after the `permission_rules` filter. */
export function resolveSessionPermissionRules({
  directory,
  originalRepoDirectory,
  requested,
  phase,
}: {
  directory: string
  originalRepoDirectory?: string
  /** Raw "tool:action" / "tool:pattern:action" strings from send, channel policy and identity. */
  requested?: string[]
  phase: PermissionRulesContext['phase']
}): AgentPermissionRule[] {
  const base = phase === 'create' ? buildSessionPermissions({ directory, originalRepoDirectory }) : []
  return applyFilters('permission_rules', [...base, ...parsePermissionRules(requested ?? [])], { directory, phase })
}
