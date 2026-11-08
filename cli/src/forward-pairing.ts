// Discord sends "forward with a comment" as two messages: the forward (empty
// content, message snapshots) and, a moment later, the comment. Pairing them
// makes one conversation turn instead of two threads.

import type { Message } from 'discord.js'

export const FORWARD_COMMENT_WINDOW_MS = 2_000

type ParkedForward = { message: Message; settle: (claimed: boolean) => void }

const parkedForwards = new Map<string, ParkedForward>()

function pairingKey(message: Message): string {
  return `${message.channelId}:${message.author.id}`
}

export function isBareForward(message: Message): boolean {
  return (message.messageSnapshots?.size ?? 0) > 0 && !message.content.trim()
}

/**
 * Hold a bare forward until its comment claims it. Resolves `true` when the
 * comment took it (the caller drops the forward), `false` after the window
 * passes so the forward proceeds on its own.
 */
export function parkForward(message: Message, windowMs = FORWARD_COMMENT_WINDOW_MS): Promise<boolean> {
  const key = pairingKey(message)
  // A newer forward releases the older one: only the latest pairs with a comment.
  parkedForwards.get(key)?.settle(false)
  return new Promise((resolve) => {
    const entry: ParkedForward = { message, settle }
    const timer = setTimeout(() => settle(false), windowMs)
    function settle(claimed: boolean) {
      clearTimeout(timer)
      if (parkedForwards.get(key) === entry) parkedForwards.delete(key)
      resolve(claimed)
    }
    parkedForwards.set(key, entry)
  })
}

/** Take the forward the same author parked in this channel just before `comment`. */
export function claimParkedForward(comment: Message): Message | undefined {
  if (isBareForward(comment)) return undefined
  const entry = parkedForwards.get(pairingKey(comment))
  if (!entry) return undefined
  entry.settle(true)
  return entry.message
}
