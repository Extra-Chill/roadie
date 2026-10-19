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
