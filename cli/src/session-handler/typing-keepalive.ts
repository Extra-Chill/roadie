// Typing indicator scheduler for one thread runtime.
// Owns the 7s keepalive loop while a run stays busy and the debounce that
// collapses clustered immediate re-pulses after bot messages into one last
// pulse, because Discord hides typing on the next bot message and showing
// multiple back-to-back POSTs is wasteful.

import { createDebouncedTimeout } from '../debounce-timeout.js'
import { createLogger, LogPrefix } from '../logger.js'

const discordLogger = createLogger(LogPrefix.DISCORD)

const TYPING_REPULSE_DEBOUNCE_MS = 500

export type TypingKeepaliveOptions = {
  supportsTyping: () => boolean
  isDisposed: () => boolean
  hasPendingInteractiveUi: () => boolean | Promise<boolean>
  getSessionId: () => string | undefined
  isSessionBusy: (sessionId: string) => boolean
  sendTyping: () => Promise<Error | void>
}

export class TypingKeepalive {
  private readonly opts: TypingKeepaliveOptions
  private typingKeepaliveTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly typingRepulseDebounce: ReturnType<typeof createDebouncedTimeout>

  constructor(opts: TypingKeepaliveOptions) {
    this.opts = opts
    this.typingRepulseDebounce = createDebouncedTimeout({
      delayMs: TYPING_REPULSE_DEBOUNCE_MS,
      callback: async () => {
        if (!await this.shouldTypeNow()) {
          return
        }
        this.restartTypingKeepalive({ sendNow: true })
      },
    })
  }

  private async shouldTypeNow(): Promise<boolean> {
    if (!this.opts.supportsTyping()) return false
    if (this.opts.isDisposed()) {
      return false
    }
    if (await this.opts.hasPendingInteractiveUi()) {
      return false
    }
    // Database-backed pending checks yield; disposal may happen meanwhile.
    if (this.opts.isDisposed()) return false
    const sessionId = this.opts.getSessionId()
    if (!sessionId) {
      return false
    }
    return this.opts.isSessionBusy(sessionId)
  }

  private async sendTypingPulse(): Promise<void> {
    const result = await this.opts.sendTyping()
    if (result instanceof Error) {
      discordLogger.log(`Failed to send typing: ${result}`)
    }
  }

  private clearTypingKeepalive(): void {
    if (!this.typingKeepaliveTimeout) {
      return
    }
    clearTimeout(this.typingKeepaliveTimeout)
    this.typingKeepaliveTimeout = null
  }

  private armTypingKeepalive({
    delayMs,
  }: {
    delayMs: number
  }): void {
    this.typingKeepaliveTimeout = setTimeout(() => {
      const activeTimer = this.typingKeepaliveTimeout
      if (!activeTimer) {
        return
      }
      void (async () => {
        if (!await this.shouldTypeNow()) {
          this.stopTyping()
          return
        }
        await this.sendTypingPulse()
        if (this.typingKeepaliveTimeout !== activeTimer) {
          return
        }
        if (!await this.shouldTypeNow()) {
          this.stopTyping()
          return
        }
        this.armTypingKeepalive({ delayMs: 7000 })
      })()
    }, delayMs)
  }

  private restartTypingKeepalive({
    sendNow,
  }: {
    sendNow: boolean
  }): void {
    this.clearTypingKeepalive()
    this.armTypingKeepalive({ delayMs: sendNow ? 0 : 7000 })
  }

  async ensureTypingNow(): Promise<void> {
    if (!await this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    if (!this.typingKeepaliveTimeout && !this.typingRepulseDebounce.isPending()) {
      this.armTypingKeepalive({ delayMs: 0 })
      return
    }
    this.typingRepulseDebounce.trigger()
  }

  async ensureTypingKeepalive(): Promise<void> {
    if (!await this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    if (this.typingKeepaliveTimeout || this.typingRepulseDebounce.isPending()) {
      return
    }
    this.armTypingKeepalive({ delayMs: 7000 })
  }

  stopTyping(): void {
    this.typingRepulseDebounce.clear()
    this.clearTypingKeepalive()
  }

  async requestTypingRepulse(): Promise<void> {
    if (!await this.shouldTypeNow()) {
      return
    }
    this.typingRepulseDebounce.trigger()
  }
}
