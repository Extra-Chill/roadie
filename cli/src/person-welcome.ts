// Welcome newly admitted people (issue #272).
//
// The first time the identity layer resolves an *allowed* person for a
// platform-authenticated chat actor, Roadie sends them a short private
// welcome: what the agent is, where to ask, and, when some of their
// person-scoped MCP servers have no stored token yet, how to connect them
// (`/connect`, plus Connect buttons on platforms that render them).
//
// Once per person key, persisted in the `person_welcomes` table, so restarts
// and concurrent turns never send it twice. Denied or unmapped actors, actors
// asserted by the CLI and bots never get it, and without an identity layer
// there are no "admitted people" so nothing is sent.
//
// The text comes from the `welcome_message` filter (value: Roadie's generic
// default; null or '' disables). `/start` re-shows it on demand.
//
// This module is platform-neutral: delivery is a callback, so Discord
// (commands/start.ts) and Slack (slack-connect.ts) each send a DM with
// buttons in their own way.

import { getDataDir } from './config.js'
import { personKeyFrom } from './credentials/person-pool.js'
import { listPersonMcpCredentials } from './credentials/person-mcp-store.js'
import { claimPersonWelcome, releasePersonWelcome } from './database.js'
import { applyFiltersAsync } from './hooks.js'
import { isIdentityHookConfigured, type IdentityActor, type Person, type PersonMcpServer } from './identity.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.DISCORD)

export type WelcomeTrigger = 'first_contact' | 'command'

/** Context handed to the `welcome_message` filter. */
export type WelcomeMessageContext = {
  actor: IdentityActor
  person: Person
  personKey: string
  /** Channel the person was seen in, when known. */
  channelId?: string
  /** Names of the person's MCP servers that have no stored token yet. */
  pendingMcpServers: string[]
  trigger: WelcomeTrigger
}

export type PersonWelcome = {
  text: string
  personKey: string
  /** Servers lacking a token: render Connect buttons for these. */
  pendingMcpServers: PersonMcpServer[]
}

/**
 * How a person types a Roadie command on their platform: Discord registers
 * `/connect`, Slack has one `/roadie <subcommand>` command.
 */
export function roadieCommandHint(platform: string, name: string): string {
  return platform === 'slack' ? `/roadie ${name}` : `/${name}`
}

/** A channel reference both Discord and Slack render as a link. */
function channelMention(platform: string, channelId: string | undefined): string {
  if (!channelId) return ''
  if (platform === 'discord') return ` (like <#${channelId}>)`
  // Slack: public/private channel ids only; DMs (D...) are not "a channel".
  if (platform === 'slack' && /^[CG][A-Z0-9]+$/.test(channelId)) return ` (like <#${channelId}>)`
  return ''
}

export function defaultWelcomeText({
  actor,
  channelId,
  pendingMcpServers,
}: {
  actor: IdentityActor
  channelId?: string
  pendingMcpServers: readonly string[]
}): string {
  const where = channelMention(actor.platform, channelId)
  const lines = [
    `Welcome${actor.name ? `, ${actor.name}` : ''}! I'm Roadie, an AI agent your team can ask for help.`,
    `Mention me in a channel${where} with a question or a task, and I'll answer in a thread.`,
  ]
  if (pendingMcpServers.length > 0) {
    lines.push(
      `Some services need your own account first (${pendingMcpServers.join(', ')}). Use \`${roadieCommandHint(actor.platform, 'connect')}\` or the button below to sign in.`,
    )
  }
  lines.push(`Use \`${roadieCommandHint(actor.platform, 'start')}\` any time to see this again.`)
  return lines.join('\n')
}

/** Servers among the person's mcp_servers that have no stored token for them. */
export function pendingMcpServersFor({
  dataDir,
  personKey,
  person,
}: {
  dataDir: string
  personKey: string
  person: Person
}): PersonMcpServer[] {
  const servers = person.mcpServers ?? []
  if (servers.length === 0) return []
  const stored = new Set(listPersonMcpCredentials({ dataDir, personKey }))
  return servers.filter((server) => !stored.has(server.credential))
}

/**
 * Who may be welcomed: an allowed person behind a platform-authenticated
 * human actor, with an identity layer in place.
 */
export function welcomePersonKey({
  actor,
  person,
  via = 'chat',
  isBot = false,
}: {
  actor: IdentityActor
  person: Person | null | undefined
  via?: 'chat' | 'cli'
  isBot?: boolean
}): string | null {
  if (via !== 'chat' || isBot) return null
  if (!isIdentityHookConfigured()) return null
  if (!person?.allowed) return null
  return personKeyFrom({ personId: person.personId, platform: actor.platform, actorId: actor.id })
}

/** The welcome text for a person, or null when the host disabled it. */
export async function buildPersonWelcome({
  actor,
  person,
  personKey,
  channelId,
  trigger,
  dataDir = getDataDir(),
}: {
  actor: IdentityActor
  person: Person
  personKey: string
  channelId?: string
  trigger: WelcomeTrigger
  dataDir?: string
}): Promise<PersonWelcome | null> {
  const pending = pendingMcpServersFor({ dataDir, personKey, person })
  const pendingNames = pending.map((server) => server.name)
  const text = await applyFiltersAsync(
    'welcome_message',
    defaultWelcomeText({ actor, ...(channelId ? { channelId } : {}), pendingMcpServers: pendingNames }),
    { actor, person, personKey, ...(channelId ? { channelId } : {}), pendingMcpServers: pendingNames, trigger },
  )
  if (typeof text !== 'string' || !text.trim()) return null
  return { text: text.slice(0, 2000), personKey, pendingMcpServers: pending }
}

// Person keys already welcomed (or claimed) in this process: skips the
// database on every later message from them.
const seen = new Set<string>()

/** Tests only. */
export function resetWelcomeCache(): void {
  seen.clear()
}

export type WelcomeOutcome = 'sent' | 'skipped' | 'disabled' | 'failed'

/**
 * Send the first-contact welcome if this person has never had one. Never
 * throws; delivery failures are logged and not retried (no DM spam).
 */
export async function maybeWelcomePerson({
  actor,
  person,
  via,
  isBot,
  channelId,
  deliver,
  dataDir,
}: {
  actor: IdentityActor
  person: Person | null | undefined
  via?: 'chat' | 'cli'
  isBot?: boolean
  channelId?: string
  deliver: (welcome: PersonWelcome) => Promise<void | Error>
  dataDir?: string
}): Promise<WelcomeOutcome> {
  try {
    const personKey = welcomePersonKey({ actor, person, ...(via ? { via } : {}), ...(isBot !== undefined ? { isBot } : {}) })
    if (!personKey || !person) return 'skipped'
    if (seen.has(personKey)) return 'skipped'
    seen.add(personKey)
    if (!(await claimPersonWelcome(personKey))) return 'skipped'
    const welcome = await buildPersonWelcome({
      actor,
      person,
      personKey,
      ...(channelId ? { channelId } : {}),
      trigger: 'first_contact',
      ...(dataDir ? { dataDir } : {}),
    })
    if (!welcome) {
      // Disabled by the host: release the claim so enabling it later still
      // welcomes this person.
      await releasePersonWelcome(personKey)
      seen.delete(personKey)
      return 'disabled'
    }
    const delivered = await deliver(welcome).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    if (delivered instanceof Error) {
      logger.warn(`[WELCOME] could not deliver welcome to ${actor.platform}:${actor.id}: ${delivered.message}`)
      return 'failed'
    }
    logger.log(`[WELCOME] welcomed ${actor.platform}:${actor.id}`)
    return 'sent'
  } catch (error) {
    logger.warn(`[WELCOME] welcome failed for ${actor.platform}:${actor.id}: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}
