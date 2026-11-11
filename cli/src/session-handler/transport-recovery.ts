// Per-session transport outage gate. Submitted turns stay in the backend's
// history; only not-yet-submitted work is held here while the transport recovers.
export class TransportRecovery {
  private pending = new Map<string, { controller: AbortController; work: Array<() => Promise<unknown>> }>()

  enqueue(sessionId: string, work: () => Promise<unknown>): boolean {
    const outage = this.pending.get(sessionId)
    if (!outage) return false
    outage.work.push(work)
    return true
  }

  start({ sessionId, wait, offline, online, resume, failed }: {
    sessionId: string
    wait: (signal: AbortSignal) => Promise<void>
    offline: () => void
    online: () => void
    resume: () => Promise<unknown>
    failed: (error: unknown) => void
  }): void {
    if (this.pending.has(sessionId)) return
    const outage = { controller: new AbortController(), work: [resume] }
    this.pending.set(sessionId, outage)
    offline()
    void wait(outage.controller.signal).then(async () => {
      if (outage.controller.signal.aborted) return
      this.pending.delete(sessionId)
      online()
      for (const work of outage.work) {
        if (outage.controller.signal.aborted) return
        const result = await work()
        if (result instanceof Error) failed(result)
      }
    }).catch(failed).finally(() => {
      if (this.pending.get(sessionId) === outage) this.pending.delete(sessionId)
    })
  }

  cancel(sessionId: string): void {
    this.pending.get(sessionId)?.controller.abort()
    this.pending.delete(sessionId)
  }

  dispose(): void {
    for (const sessionId of this.pending.keys()) this.cancel(sessionId)
  }
}
