// Signal delivery is not process termination. Release files and ports only
// after the owned child closes; bound a stubborn shutdown.
import type { ChildProcess } from 'node:child_process'
import * as errore from 'errore'

class ChildShutdownError extends errore.createTaggedError({
  name: 'ChildShutdownError',
  message: 'Owned child $pid failed to stop',
}) {}

export function stopOwnedChild({
  child,
  graceMs = 2000,
  killWaitMs = 1000,
}: {
  child: ChildProcess
  graceMs?: number
  killWaitMs?: number
}): Promise<void | Error> {
  const exited = child.exitCode !== null || child.signalCode !== null
  if (
    exited &&
    (!child.stdout || child.stdout.destroyed) &&
    (!child.stderr || child.stderr.destroyed)
  )
    return Promise.resolve()
  return new Promise((resolve) => {
    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(force)
      clearTimeout(deadline)
      child.off('close', onClose)
      child.off('error', onError)
      resolve(error)
    }
    const onClose = () => finish()
    const onError = (cause: Error) => finish(new ChildShutdownError({ pid: child.pid ?? 0, cause }))
    child.once('close', onClose)
    child.once('error', onError)
    const force = setTimeout(() => {
      const killed = errore.try({
        try: () => child.kill('SIGKILL'),
        catch: (cause) => new ChildShutdownError({ pid: child.pid ?? 0, cause }),
      })
      if (killed instanceof Error) finish(killed)
    }, graceMs)
    const deadline = setTimeout(
      () => finish(new ChildShutdownError({ pid: child.pid ?? 0 })),
      graceMs + killWaitMs,
    )
    const signalled = errore.try({
      try: () => child.kill('SIGTERM'),
      catch: (cause) => new ChildShutdownError({ pid: child.pid ?? 0, cause }),
    })
    if (signalled instanceof Error) finish(signalled)
  })
}
