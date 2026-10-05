// Per-channel policy: who the bot answers, when, whether it starts threads,
// and which directory/agent/model/capabilities a channel's sessions get.
//
// Configured by a host-written file (ROADIE_CHANNELS_CONFIG or
// --channels-config), YAML or JSON:
//
//   channels:
//     "123456789012345678":          # channel id, category id, or "*"
//       respond: always               # always | mention | never
//       who: [owner, "role:team", "user:42", "person:<host id>"]   # or "everyone"
//       threads: per-message          # per-message | existing-only
//       directory: /var/www/site
//       agent: build
//       model: anthropic/claude-opus-4-7
//       verbosity: text_and_essential_tools
//       capabilities: [sessions, shell, admin]
//       permissions: ["bash:deny"]
//     "*":
//       respond: never
//
// Resolution walks thread → channel → category → "*" and merges fields, the
// most specific value winning. Without a config file every getter returns
// undefined and Roadie keeps its built-in per-channel settings (database
// rows, --mention-mode, role checks). With a config file, a channel that
// resolves to no policy at all is not answered.
//
// The file is re-read when its mtime changes (checked at most every 2s). An
// invalid file is reported and the last valid config stays in effect; if no
// valid config was ever loaded, no channel is answered (fail closed).

import { applyFilters, hasFilter } from './hooks.js'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import YAML from 'yaml'
import { z } from 'zod'
import { getRoadieEnv } from './config.js'
import { createLogger, LogPrefix } from './logger.js'
import type { Capability } from './identity.js'

const logger = createLogger(LogPrefix.DISCORD)

const RELOAD_CHECK_MS = 2_000

const whoEntrySchema = z.union([
  z.literal('owner'),
  z.string().regex(/^(role|user|person):.+$/),
])

const policySchema = z
  .object({
    project: z.string().min(1).optional(),
    context: z.string().min(1).optional(),
    respond: z.enum(['always', 'mention', 'never']).optional(),
    who: z.union([z.literal('everyone'), z.array(whoEntrySchema).min(1)]).optional(),
    threads: z.enum(['per-message', 'existing-only']).optional(),
    directory: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    verbosity: z.enum(['tools_and_text', 'text_and_essential_tools', 'text_only']).optional(),
    capabilities: z.array(z.enum(['sessions', 'shell', 'admin'])).optional(),
    permissions: z.array(z.string().min(1)).optional(),
  })
  .strict()

const configSchema = z
  .object({
    application: z.object({
      channel: z.string().min(1),
      directory: z.string().refine(path.isAbsolute, 'Use an absolute application directory'),
    }).strict().optional(),
    projects: z.record(z.string().min(1), policySchema.omit({ project: true })).optional(),
    channels: z.record(z.string().min(1), policySchema),
  })
  .strict()

export type ChannelPolicy = z.infer<typeof policySchema>
export type ChannelsConfig = z.infer<typeof configSchema>
export type WhoEntry = z.infer<typeof whoEntrySchema>

/** Returns a channel's parent id (thread → channel, channel → category). */
export type ParentResolver = (channelId: string) => string | null | undefined

let configPathOverride: string | null | undefined
let parentResolver: ParentResolver = () => undefined

type LoadedState = {
  path: string
  mtimeMs: number
  checkedAt: number
  config: ChannelsConfig | null // null = configured but never valid
}
let loaded: LoadedState | undefined

/** Set or clear the config path (CLI flag, tests). `undefined` = use env. */
export function setChannelsConfigPath(path: string | null | undefined) {
  configPathOverride = path
  loaded = undefined
}

export function getChannelsConfigPath(): string | undefined {
  if (configPathOverride !== undefined) return configPathOverride ?? undefined
  const fromEnv = getRoadieEnv('ROADIE_CHANNELS_CONFIG')?.trim()
  return fromEnv || undefined
}

/** Register how to find a channel's parent (the Discord client cache). */
export function setChannelParentResolver(resolver: ParentResolver) {
  parentResolver = resolver
}

/** True when a channels config file or a `channel_policy` filter is in place. */
export function isChannelPolicyConfigured(): boolean {
  return Boolean(getChannelsConfigPath()) || hasFilter('channel_policy')
}

export function parseChannelsConfig(text: string): ChannelsConfig | Error {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (e) {
    return new Error(`invalid YAML/JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const parsed = configSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return new Error(`${issue?.path.join('.') || 'config'}: ${issue?.message || 'invalid'}`)
  }
  for (const [channelId, policy] of Object.entries(parsed.data.channels)) {
    if (policy.project && !parsed.data.projects?.[policy.project]) {
      return new Error(`channels.${channelId}.project: unknown project "${policy.project}"`)
    }
  }
  if (parsed.data.application && !parsed.data.channels[parsed.data.application.channel]) {
    return new Error('application.channel must name an explicitly configured channel')
  }
  return parsed.data
}

function currentConfig(): ChannelsConfig | null | undefined {
  const path = getChannelsConfigPath()
  if (!path) return undefined

  const now = Date.now()
  if (loaded && loaded.path === path && now - loaded.checkedAt < RELOAD_CHECK_MS) {
    return loaded.config
  }

  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(path).mtimeMs
  } catch (e) {
    if (!loaded || loaded.path !== path) {
      logger.error(`[CHANNEL POLICY] cannot read ${path}; no channel will be answered`)
      loaded = { path, mtimeMs: -1, checkedAt: now, config: null }
    } else {
      loaded.checkedAt = now
    }
    return loaded.config
  }

  if (loaded && loaded.path === path && loaded.mtimeMs === mtimeMs) {
    loaded.checkedAt = now
    return loaded.config
  }

  const result = parseChannelsConfig(fs.readFileSync(path, 'utf8'))
  const previous = loaded && loaded.path === path ? loaded.config : null
  if (result instanceof Error) {
    logger.error(
      `[CHANNEL POLICY] ${path} is invalid (${result.message}); ${previous ? 'keeping the previous config' : 'no channel will be answered'}`,
    )
    loaded = { path, mtimeMs, checkedAt: now, config: previous }
    return previous
  }
  logger.log(`[CHANNEL POLICY] loaded ${Object.keys(result.channels).length} policy entries from ${path}`)
  loaded = { path, mtimeMs, checkedAt: now, config: result }
  return result
}

/** Channel id, then each ancestor, then "*". */
function lookupChain(channelId: string): string[] {
  const chain: string[] = []
  let current: string | null | undefined = channelId
  const seen = new Set<string>()
  while (current && !seen.has(current) && chain.length < 4) {
    seen.add(current)
    chain.push(current)
    current = parentResolver(current)
  }
  chain.push('*')
  return chain
}

/**
 * Effective policy for a channel or thread, or:
 *   undefined → no config file: use Roadie's built-in settings
 *   null      → config file present but nothing matches: do not answer
 */
export function resolveChannelPolicy(channelId: string): ChannelPolicy | null | undefined {
  const config = currentConfig()
  if (config?.application && !lookupChain(channelId).some((id) => id !== '*' && config.channels[id])) {
    return null
  }
  const policy = applyFilters('channel_policy', configuredChannelPolicy(channelId), { channelId })
  if (policy && config?.application) return { ...policy, directory: config.application.directory }
  return policy
}

/** Application routing is explicit configuration, never a caller-directory lookup. */
export function resolveSendChannel(channelId?: string): string | Error {
  const config = currentConfig()
  if (config === null) return new Error('Cannot send: application channel configuration is unavailable')
  const target = channelId || config?.application?.channel
  if (!target) return new Error('Pass --channel, --thread or --session, or configure application.channel')
  if (config?.application && !config.channels[target]) {
    return new Error(`Channel ${target} is not explicitly configured for this Roadie application`)
  }
  const policy = resolveChannelPolicy(target)
  if (config && !policy) return new Error(`Channel ${target} is not configured`)
  if (config?.application && policy?.respond === 'never') return new Error(`Channel ${target} is unbound from this Roadie application`)
  return target
}

export function applicationBinding(): ChannelsConfig['application'] {
  const binding = currentConfig()?.application
  return binding ? { ...binding } : undefined
}

// One writer for the application policy. Serialized fresh reads keep different
// channel commands from overwriting each other's bindings.
let bindingWrites: Promise<unknown> = Promise.resolve()

export function setApplicationChannelBinding({ channelId, bound, application }: {
  channelId: string
  bound: boolean
  application: NonNullable<ChannelsConfig['application']>
}): Promise<{ changed: boolean } | Error> {
  const write = bindingWrites.then(() => {
    const configPath = getChannelsConfigPath()
    if (!configPath) return new Error('Configure ROADIE_CHANNELS_CONFIG before binding channels')
    let temporary: string | undefined
    try {
      // Follow an operator's config symlink without replacing the symlink itself.
      const file = fs.realpathSync(configPath)
      const stat = fs.statSync(file)
      fs.accessSync(file, fs.constants.W_OK)
      const text = fs.readFileSync(file, 'utf8')
      const config = parseChannelsConfig(text)
      if (config instanceof Error) return new Error(`Fix the channel policy before changing bindings: ${config.message}`)
      if (!config.application) return new Error('Configure application.channel and application.directory first')
      if (config.application.channel !== application.channel || config.application.directory !== application.directory) {
        return new Error('Application configuration changed; run the channel command again')
      }
      if (!bound && channelId === application.channel) return new Error('The application default cannot be unbound; change application.channel first')
      const previous = config.channels[channelId]
      const enabled = Boolean(previous && previous.respond !== 'never')
      if (enabled === bound) return { changed: false }
      const source = config.channels[application.channel]!
      if (bound && source.respond === 'never') return new Error('Enable the application default channel policy before binding another channel')
      // Disabling is a canonical respond: never policy, so category/wildcard
      // policies cannot re-enable an unbound channel or discard its settings.
      const policy: ChannelPolicy = bound
        ? { ...structuredClone(source), respond: source.respond ?? 'always' }
        : { ...previous, respond: 'never' }
      config.channels[channelId] = policy
      const document = YAML.parseDocument(text)
      document.setIn(['channels', channelId], policy)
      const contents = path.extname(file).toLowerCase() === '.json'
        ? `${JSON.stringify(config, null, 2)}\n`
        : document.toString()
      const validated = parseChannelsConfig(contents)
      if (validated instanceof Error) return validated
      if (!isDeepStrictEqual(validated, config)) return new Error('Cannot change this binding without altering an aliased policy; use an independent channel policy')
      temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
      fs.writeFileSync(temporary, contents, { flag: 'wx', mode: stat.mode & 0o777 })
      fs.chmodSync(temporary, stat.mode & 0o777)
      fs.chownSync(temporary, stat.uid, stat.gid)
      fs.renameSync(temporary, file)
      temporary = undefined
      loaded = undefined
      return { changed: true }
    } catch (cause) {
      return new Error('Could not persist the channel binding; the previous policy is unchanged', { cause })
    } finally {
      if (temporary) {
        try { fs.rmSync(temporary, { force: true }) } catch (cause) {
          logger.error('Could not clean up the channel policy temporary file', cause)
        }
      }
    }
  })
  bindingWrites = write.catch(() => undefined)
  return write
}

/** One runtime/context directory for an application, independent of repository work. */
export function applicationDirectory(): string | undefined {
  return currentConfig()?.application?.directory
}

export function validateApplicationDirectory(directory?: string): Error | undefined {
  const fixed = applicationDirectory()
  if (fixed && directory && path.resolve(directory) !== path.resolve(fixed)) {
    return new Error('Session directory is fixed by application.directory; use the host development workspace for repository work')
  }
  return undefined
}

function configuredChannelPolicy(channelId: string): ChannelPolicy | null | undefined {
  const config = currentConfig()
  if (config === undefined) return undefined
  if (config === null) return null

  const matches = lookupChain(channelId)
    .map((id) => config.channels[id])
    .filter((p): p is ChannelPolicy => Boolean(p))
  if (matches.length === 0) return null

  // Least specific first so more specific entries override field by field.
  const channel = matches.reverse().reduce<ChannelPolicy>((acc, policy) => ({ ...acc, ...policy }), {})
  const project = channel.project ? config.projects?.[channel.project] : undefined
  return { ...project, ...channel }
}

/** Opaque host context shared by every channel bound to the same project. */
export function channelContextBinding(channelId: string): { projectId?: string; contextId?: string } {
  const policy = resolveChannelPolicy(channelId)
  if (!policy) return {}
  return {
    ...(policy.project ? { projectId: policy.project } : {}),
    ...(policy.context ? { contextId: policy.context } : {}),
  }
}

/** All explicit channel bindings for a named project or canonical directory. */
export function channelsForProject(project: string): string[] {
  const config = currentConfig()
  if (!config) return []
  return Object.keys(config.channels).filter((id) => {
    if (id === '*') return false
    const policy = configuredChannelPolicy(id)
    return policy?.project === project || policy?.directory === project
  })
}

// ── Decisions used by the message pipeline ─────────────────────────

export type RespondDecision = 'answer' | 'ignore' | 'needs-mention' | 'builtin'

/** Whether the bot should consider a message in this channel at all. */
export function decideRespond(channelId: string): RespondDecision {
  const policy = resolveChannelPolicy(channelId)
  if (policy === undefined) return 'builtin'
  if (policy === null) return 'ignore'
  if (policy.capabilities && !policy.capabilities.includes('sessions')) return 'ignore'
  switch (policy.respond ?? 'always') {
    case 'never':
      return 'ignore'
    case 'mention':
      return 'needs-mention'
    default:
      return 'answer'
  }
}

export type WhoSubject = {
  userId: string
  isGuildOwner: boolean
  roleNames: string[]
  roleIds: string[]
  personId?: string
}

export function matchesWho(who: ChannelPolicy['who'], subject: WhoSubject): boolean {
  if (who === undefined || who === 'everyone') return true
  return who.some((entry) => {
    if (entry === 'owner') return subject.isGuildOwner
    const separator = entry.indexOf(':')
    const kind = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if (kind === 'user') return subject.userId === value
    if (kind === 'person') return Boolean(subject.personId) && subject.personId === value
    if (kind === 'role') {
      return (
        subject.roleIds.includes(value) ||
        subject.roleNames.some((name) => name.toLowerCase() === value.toLowerCase())
      )
    }
    return false
  })
}

/** Whether the channel allows this speaker. True without a config file. */
export function channelAllowsSpeaker(channelId: string, subject: WhoSubject): boolean {
  const policy = resolveChannelPolicy(channelId)
  if (policy === undefined) return true
  if (policy === null) return false
  return matchesWho(policy.who, subject)
}

/**
 * Whether the channel permits a capability. True without a config file or
 * when the channel sets no `capabilities` (no channel-level cap).
 */
export function channelAllowsCapability(channelId: string, capability: Capability): boolean {
  const policy = resolveChannelPolicy(channelId)
  if (policy === undefined) return true
  if (policy === null) return false
  return !policy.capabilities || policy.capabilities.includes(capability)
}

/** Whether a new thread may be started from a channel message. */
export function channelStartsThreads(channelId: string): boolean {
  const policy = resolveChannelPolicy(channelId)
  if (!policy) return true
  return (policy.threads ?? 'per-message') === 'per-message'
}

/** Per-channel overrides for settings Roadie otherwise stores in SQLite. */
export function channelPolicyOverrides(channelId: string): Pick<
  ChannelPolicy,
  'directory' | 'agent' | 'model' | 'verbosity' | 'permissions'
> {
  const policy = resolveChannelPolicy(channelId)
  if (!policy) return {}
  return {
    ...(policy.directory ? { directory: policy.directory } : {}),
    ...(policy.agent ? { agent: policy.agent } : {}),
    ...(policy.model ? { model: policy.model } : {}),
    ...(policy.verbosity ? { verbosity: policy.verbosity } : {}),
    ...(policy.permissions ? { permissions: policy.permissions } : {}),
  }
}
