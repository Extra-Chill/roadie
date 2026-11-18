// Plain-text @name mentions in agent replies do not ping on Discord: only the
// `<@USER_ID>` form does. Before agent text is chunked and sent, rewrite
// `@name` to `<@id>` when the name resolves unambiguously to a Discord user
// Roadie already knows about. Resolution is in-memory only (participants seen
// in the thread plus discord.js caches): the send path never makes a network
// call to look a name up. Unknown or ambiguous names stay plain text.

export type MentionResolver = (name: string) => string | undefined

export type MentionCandidate = {
  id: string
  names: Array<string | null | undefined>
}

const RESERVED_MENTIONS = new Set(['everyone', 'here'])

// Regions that must pass through untouched: inline code (matching backtick
// runs), Discord entity markup (<@id>, <@!id>, <@&id>, <#id>, custom emoji),
// angle-bracketed and bare URLs, and email addresses.
const PROTECTED_INLINE =
  /(`+)[\s\S]*?\1|<(?:@[!&]?|#)\d+>|<a?:\w+:\d+>|<[a-z][a-z0-9+.-]*:[^>\s]*>|\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi

// A mention starts at a token boundary and ends on a name character, so
// trailing punctuation ("@chubes," or "@chubes.") stays outside the name.
const PLAIN_MENTION = /(?<![\w@<>/\\.+:`-])@([\w](?:[\w.-]*\w)?)/g

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/

function rewriteInline(text: string, resolve: MentionResolver): string {
  const rewriteSpan = (span: string) =>
    span.replace(PLAIN_MENTION, (match, name: string) => {
      if (RESERVED_MENTIONS.has(name.toLowerCase())) return match
      const id = resolve(name)
      return id ? `<@${id}>` : match
    })
  let output = ''
  let last = 0
  for (const protectedMatch of text.matchAll(PROTECTED_INLINE)) {
    const start = protectedMatch.index ?? 0
    output += rewriteSpan(text.slice(last, start)) + protectedMatch[0]
    last = start + protectedMatch[0].length
  }
  return output + rewriteSpan(text.slice(last))
}

/**
 * Rewrite plain `@name` tokens to `<@id>` using `resolve`. Fenced code blocks,
 * inline code, URLs, emails, existing Discord mentions, `@everyone` and
 * `@here` are left untouched. Pure: no I/O.
 */
export function rewritePlainMentions(text: string, resolve: MentionResolver): string {
  if (!text.includes('@')) return text
  const lines = text.split(/(?<=\n)/)
  let output = ''
  let prose = ''
  let fence: { char: string; size: number } | undefined
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_LINE)
    if (fence) {
      output += line
      const marker = fenceMatch?.[1]
      if (marker && marker[0] === fence.char && marker.length >= fence.size && !line.slice(fenceMatch[0].length).trim()) {
        fence = undefined
      }
      continue
    }
    if (fenceMatch?.[1]) {
      output += rewriteInline(prose, resolve) + line
      prose = ''
      fence = { char: fenceMatch[1][0]!, size: fenceMatch[1].length }
      continue
    }
    prose += line
  }
  return output + rewriteInline(prose, resolve)
}

/**
 * Build a case-insensitive name resolver from candidate groups tried in
 * order. The first group with any match decides: exactly one user id resolves,
 * several distinct ids are ambiguous and resolve to nothing.
 */
export function createMentionResolver(groups: Array<MentionCandidate[] | (() => MentionCandidate[])>): MentionResolver {
  // Indexes are built lazily on the first lookup so text without a plain
  // mention never walks a large guild member cache.
  let indexes: Array<Map<string, Set<string>>> | undefined
  const buildIndexes = () => groups.map((group) => {
    const candidates = typeof group === 'function' ? group() : group
    const index = new Map<string, Set<string>>()
    for (const candidate of candidates) {
      if (!candidate.id) continue
      for (const name of candidate.names) {
        const key = name?.trim().toLowerCase()
        if (!key) continue
        const ids = index.get(key) ?? new Set<string>()
        ids.add(candidate.id)
        index.set(key, ids)
      }
    }
    return index
  })
  return (name) => {
    const key = name.toLowerCase()
    indexes ??= buildIndexes()
    for (const index of indexes) {
      const ids = index.get(key)
      if (!ids) continue
      return ids.size === 1 ? [...ids][0] : undefined
    }
    return undefined
  }
}

// ── Thread participant registry ─────────────────────────────────────────
// People seen speaking in each Discord thread/channel, recorded at message
// ingress. Bounded so a long-running bot does not grow without limit.

const MAX_TRACKED_CHANNELS = 1000
const MAX_PARTICIPANTS_PER_CHANNEL = 200
const participantsByChannel = new Map<string, Map<string, MentionCandidate>>()

export function recordDiscordParticipant(channelId: string, participant: MentionCandidate): void {
  if (!channelId || !participant.id) return
  let participants = participantsByChannel.get(channelId)
  if (participants) {
    // Refresh recency so active channels survive eviction.
    participantsByChannel.delete(channelId)
  } else {
    participants = new Map()
  }
  participantsByChannel.set(channelId, participants)
  if (participantsByChannel.size > MAX_TRACKED_CHANNELS) {
    const oldest = participantsByChannel.keys().next().value
    if (oldest !== undefined) participantsByChannel.delete(oldest)
  }
  const previous = participants.get(participant.id)
  participants.delete(participant.id)
  const names = new Set([...(previous?.names ?? []), ...participant.names].filter(Boolean))
  participants.set(participant.id, { id: participant.id, names: [...names] })
  if (participants.size > MAX_PARTICIPANTS_PER_CHANNEL) {
    const oldest = participants.keys().next().value
    if (oldest !== undefined) participants.delete(oldest)
  }
}

export function getDiscordParticipants(channelId: string): MentionCandidate[] {
  return [...(participantsByChannel.get(channelId)?.values() ?? [])]
}

export function clearDiscordParticipantsForTests(): void {
  participantsByChannel.clear()
}

// ── discord.js adapters (cache reads only, never fetch) ─────────────────

type CachedUser = {
  id: string
  username?: string | null
  globalName?: string | null
  displayName?: string | null
}

type CachedMember = {
  id: string
  nickname?: string | null
  displayName?: string | null
  user?: CachedUser | null
}

type MentionChannel = {
  id: string
  client?: { user?: { id: string } | null } | null
  guild?: { members?: { cache?: { values(): Iterable<CachedMember> } } } | null
  recipient?: CachedUser | null
}

export function discordUserNames(user: CachedUser | null | undefined): Array<string | null | undefined> {
  return user ? [user.username, user.globalName, user.displayName] : []
}

export function discordMemberNames(member: CachedMember): Array<string | null | undefined> {
  return [member.nickname, member.displayName, ...discordUserNames(member.user)]
}

function cachedGuildMembers(channel: MentionChannel): MentionCandidate[] {
  const cache = channel.guild?.members?.cache
  if (!cache) return []
  return [...cache.values()].map((member) => ({ id: member.id, names: discordMemberNames(member) }))
}

/**
 * Resolver for a Discord channel: thread participants first, then the DM
 * recipient and the guild member cache. Reads in-memory caches only. The bot
 * itself is never a mention target.
 */
export function discordMentionResolver(channel: MentionChannel): MentionResolver {
  const botUserId = channel.client?.user?.id
  const withoutBot = (candidates: MentionCandidate[]) =>
    candidates.filter((candidate) => candidate.id !== botUserId)
  return createMentionResolver([
    () => withoutBot(getDiscordParticipants(channel.id)),
    () => {
      const recipient = channel.recipient
        ? [{ id: channel.recipient.id, names: discordUserNames(channel.recipient) }]
        : []
      return withoutBot([...recipient, ...cachedGuildMembers(channel)])
    },
  ])
}

/** Rewrite plain `@name` mentions in agent text bound for `channel`. */
export function rewriteDiscordMentions(text: string, channel: MentionChannel): string {
  if (!text.includes('@')) return text
  return rewritePlainMentions(text, discordMentionResolver(channel))
}
