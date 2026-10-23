// Derive a Discord thread name from a session title.

import { STATUS_PREFIX } from '../message-formatting.js'

const DISCORD_THREAD_NAME_MAX = 100
const PRESERVED_THREAD_PREFIXES: string[] = [
  STATUS_PREFIX,
  // Legacy prefix from the removed /btw command; existing threads keep it.
  'btw: ',
  'Fork: ',
]

function stripPreservedThreadPrefix(name: string) {
  const matchedPrefix = PRESERVED_THREAD_PREFIXES.find((prefix) => {
    return name.startsWith(prefix)
  })
  if (!matchedPrefix) return name
  return name.slice(matchedPrefix.length).trim()
}

function getThreadNameCandidateFromSessionTitle({
  sessionTitle,
  currentName,
}: {
  sessionTitle: string | undefined | null
  currentName: string
}) {
  const trimmed = sessionTitle
    ?.replace(/<\/?callout\b[^>]*>/gi, '')
    .trim()
  if (!trimmed) {
    return null
  }
  const withoutCopiedPrefix = stripPreservedThreadPrefix(trimmed)
  if (!withoutCopiedPrefix) {
    return null
  }
  if (/^new session\s*-/i.test(withoutCopiedPrefix)) {
    return null
  }
  const matchedPrefix =
    PRESERVED_THREAD_PREFIXES.find((p) => {
      return p !== 'Fork: ' && currentName.startsWith(p)
    }) ?? ''
  return `${matchedPrefix}${withoutCopiedPrefix}`.slice(0, DISCORD_THREAD_NAME_MAX)
}

export function deriveThreadNameFromSessionTitle({
  sessionTitle,
  currentName,
}: {
  sessionTitle: string | undefined | null
  currentName: string
}): string | undefined {
  const candidate = getThreadNameCandidateFromSessionTitle({
    sessionTitle,
    currentName,
  })
  if (candidate === null) {
    return undefined
  }
  if (candidate === currentName) {
    return undefined
  }
  return candidate
}

// True when the thread's current name no longer matches the name Roadie last
// applied (persisted in thread_sessions.last_synced_name), ignoring Roadie's
// preserved prefixes — i.e. a person renamed the thread by hand. A thread with
// no stored name has never been renamed by Roadie, so it cannot have been
// renamed manually.
export function wasThreadManuallyRenamed({
  currentName,
  lastSyncedName,
}: {
  currentName: string
  lastSyncedName: string | undefined | null
}): boolean {
  if (!lastSyncedName) return false
  return stripPreservedThreadPrefix(currentName) !== stripPreservedThreadPrefix(lastSyncedName)
}

// Decide whether Roadie may rename the thread for this session title, and to
// what. Returns the new name, or undefined when the rename must be skipped.
//
// Once a stored name exists, a mismatch with the thread's current name means
// someone renamed the thread by hand, so Roadie leaves the name alone. With no
// stored name, the first usable session title names the thread as before.
export function resolveAutoThreadRename({
  sessionTitle,
  currentName,
  lastSyncedName,
}: {
  sessionTitle: string | undefined | null
  currentName: string
  lastSyncedName: string | undefined | null
}): string | undefined {
  if (wasThreadManuallyRenamed({ currentName, lastSyncedName })) {
    return undefined
  }
  return deriveThreadNameFromSessionTitle({ sessionTitle, currentName })
}
