// Per-turn attribution for tool processes.
//
// The bot records who is speaking before every prompt/command dispatch
// (`setSessionTurnAttribution`). The OpenCode plugin's shell.env hook reads
// that row and exports it to every shell the agent runs, so tools can see the
// current speaker and conversation without parsing the prompt.
//
// Contract (all optional; unset when unknown, never stale):
//   ROADIE_THREAD_ID       chat thread bound to the session
//   ROADIE_CHANNEL_ID      parent channel of that thread
//   ROADIE_ACTOR_PLATFORM  chat platform of the current speaker, e.g. "discord"
//   ROADIE_ACTOR_ID        opaque platform user id of the current speaker
//   ROADIE_ACTOR_NAME      display name, for display only
//   ROADIE_ACTOR_VIA       "chat" = authenticated by the chat platform;
//                          "cli" = asserted by a local `roadie send --user`
//   ROADIE_PERSON_ID       opaque host person id from the identity hook
//
// Attribution only. The actor is not authority: hosts that grant permissions
// per person must map it through their own identity hook.
//
// Extra shell variables: --shell-env <NAME=template> (repeatable) and
// ROADIE_SHELL_ENV (JSON object) define additional variables as templates over
// the same session fields, applied wherever Roadie builds the agent shell
// environment (OpenCode's shell.env hook and the Pi backend's shell env file).
// Names come only from configuration; Roadie knows no consumers.

import {
  getSessionTurnAttribution,
  getThreadIdBySessionId,
  type SessionTurnAttribution,
} from './database.js'

export const TURN_ATTRIBUTION_ENV_NAMES = [
  'THREAD_ID',
  'CHANNEL_ID',
  'ACTOR_PLATFORM',
  'ACTOR_ID',
  'ACTOR_NAME',
  'ACTOR_VIA',
  'PERSON_ID',
] as const

/**
 * Write attribution into `env` as ROADIE_* variables. Every
 * attribution variable is first removed, so a value from a previous turn (or
 * inherited from the parent process) can never leak into this one.
 */
export function applyTurnAttributionEnv({
  env,
  attribution,
}: {
  env: Record<string, string>
  attribution: SessionTurnAttribution | undefined
}) {
  for (const name of TURN_ATTRIBUTION_ENV_NAMES) {
    delete env[`ROADIE_${name}`]
  }
  if (!attribution) return

  const values: Partial<Record<(typeof TURN_ATTRIBUTION_ENV_NAMES)[number], string>> = {
    THREAD_ID: attribution.threadId,
    CHANNEL_ID: attribution.channelId,
    ACTOR_PLATFORM: attribution.actor?.platform,
    ACTOR_ID: attribution.actor?.id,
    ACTOR_NAME: attribution.actor?.name,
    ACTOR_VIA: attribution.actor?.via,
    PERSON_ID: attribution.personId,
  }
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue
    env[`ROADIE_${name}`] = value
  }
}

/**
 * Resolve the current turn's attribution for a session. Falls back to the
 * thread binding for sessions that have not dispatched a turn since this
 * feature shipped (thread id only, no actor).
 */
export async function resolveTurnAttribution(
  sessionId: string,
): Promise<SessionTurnAttribution | undefined> {
  const recorded = await getSessionTurnAttribution(sessionId)
  if (recorded) return recorded
  const threadId = await getThreadIdBySessionId(sessionId)
  return threadId ? { sessionId, threadId } : undefined
}

// ── Configured shell env templates (--shell-env / ROADIE_SHELL_ENV) ────────

/** Environment variable carrying the templates as a JSON object. */
export const SHELL_ENV_TEMPLATES_ENV = 'ROADIE_SHELL_ENV'

/**
 * Template fields available at shell-env time, and where each comes from:
 *   {session_id}  the agent session id (Pi session id)
 *   {thread_id}   the chat thread bound to the session (turn attribution or
 *                 thread binding)
 *   {channel_id}  the parent channel of that thread (turn attribution)
 *   {platform}    chat platform of the current turn's speaker
 *   {actor_id}    opaque platform user id of the current turn's speaker
 *   {person_id}   opaque host person id from the identity hook, recorded with
 *                 the actor
 *
 * There is no {thread_url}: building one needs platform-specific context
 * (a Discord guild id, a Slack workspace) that the turn attribution row does
 * not carry, so it is unknown here like any other field.
 */
export const SHELL_ENV_TEMPLATE_FIELDS = [
  'session_id',
  'thread_id',
  'channel_id',
  'platform',
  'actor_id',
  'person_id',
] as const

export type ShellEnvTemplateField = (typeof SHELL_ENV_TEMPLATE_FIELDS)[number]

/** Valid POSIX-style environment variable name. */
const SHELL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const TEMPLATE_TOKEN_PATTERN = /\{([^{}]*)\}/g

function checkShellEnvTemplate({
  name,
  template,
  source,
}: {
  name: string
  template: string
  source: string
}): Error | undefined {
  if (!SHELL_ENV_NAME_PATTERN.test(name)) {
    return new Error(
      `Invalid ${source} variable name "${name}": must match [A-Za-z_][A-Za-z0-9_]*`,
    )
  }
  if (template === '') {
    return new Error(`Invalid ${source} template for "${name}": template must not be empty`)
  }
  for (const match of template.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    const field = match[1] ?? ''
    if (!(SHELL_ENV_TEMPLATE_FIELDS as readonly string[]).includes(field)) {
      return new Error(
        `Unknown template field {${field}} in ${source} variable "${name}": supported fields are ${SHELL_ENV_TEMPLATE_FIELDS.map((f) => `{${f}}`).join(', ')}`,
      )
    }
  }
  return undefined
}

/**
 * Parse --shell-env / ROADIE_SHELL_ENV into variable name → template.
 * Anything invalid (bad JSON, non-object, non-string value, invalid variable
 * name, empty template, unknown template field) is an error: callers must
 * fail startup instead of exporting empty values. Flag entries win over the
 * same name from the env var, matching the other ROADIE_* flags.
 */
export function parseShellEnvTemplates({
  flag,
  json,
}: {
  flag?: string[]
  json?: string
}): Record<string, string> | Error {
  const templates: Record<string, string> = {}
  if (json !== undefined && json.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (cause) {
      return new Error(`Invalid ${SHELL_ENV_TEMPLATES_ENV}: not valid JSON`, { cause })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return new Error(
        `Invalid ${SHELL_ENV_TEMPLATES_ENV}: must be a JSON object of variable name → template`,
      )
    }
    for (const [name, template] of Object.entries(parsed)) {
      if (typeof template !== 'string') {
        return new Error(
          `Invalid ${SHELL_ENV_TEMPLATES_ENV} entry "${name}": template must be a string`,
        )
      }
      const problem = checkShellEnvTemplate({ name, template, source: SHELL_ENV_TEMPLATES_ENV })
      if (problem) return problem
      templates[name] = template
    }
  }
  for (const entry of flag ?? []) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      return new Error(`Invalid --shell-env entry "${entry}": expected NAME=template`)
    }
    const name = entry.slice(0, separator)
    const template = entry.slice(separator + 1)
    const problem = checkShellEnvTemplate({ name, template, source: '--shell-env' })
    if (problem) return problem
    templates[name] = template
  }
  return templates
}

/** Substitute {field} tokens; undefined when any referenced field is unset. */
function renderShellEnvTemplate(
  template: string,
  fields: Record<ShellEnvTemplateField, string | undefined>,
): string | undefined {
  let value = ''
  for (const token of template.split(/(\{[^{}]*\})/)) {
    const match = /^\{([^{}]*)\}$/.exec(token)
    if (!match) {
      value += token
      continue
    }
    const replacement = fields[match[1] as ShellEnvTemplateField]
    if (replacement === undefined) return undefined
    value += replacement
  }
  return value
}

/**
 * Write the configured shell env variables into `env`. A variable is set only
 * when every field its template references has a value for this turn;
 * otherwise it is left unset (removed from `env`, never a stale or empty
 * value).
 */
export function applyShellEnvTemplates({
  env,
  sessionId,
  attribution,
  templates,
}: {
  env: Record<string, string>
  sessionId: string | undefined
  attribution: SessionTurnAttribution | undefined
  templates: Record<string, string> | undefined
}): void {
  if (!templates) return
  const fields: Record<ShellEnvTemplateField, string | undefined> = {
    session_id: sessionId,
    thread_id: attribution?.threadId,
    channel_id: attribution?.channelId,
    platform: attribution?.actor?.platform,
    actor_id: attribution?.actor?.id,
    person_id: attribution?.personId,
  }
  for (const [name, template] of Object.entries(templates)) {
    const value = renderShellEnvTemplate(template, fields)
    if (value === undefined) delete env[name]
    else env[name] = value
  }
}
