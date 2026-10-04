// Append-only log file with a size cap. When the file passes maxBytes it is
// moved to `<file>.1` (replacing the previous one) and a fresh file starts, so
// at most two files of about maxBytes each exist on disk.

import fs from 'node:fs'
import path from 'node:path'

export type BoundedLogFile = {
  append(line: string): void
  readonly filePath: string
}

export function createBoundedLogFile({
  filePath,
  maxBytes,
}: {
  filePath: string
  maxBytes: number
}): BoundedLogFile {
  let size = 0
  let ready = false

  const open = (): boolean => {
    if (ready) return true
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
      ready = true
    } catch {
      return false
    }
    return true
  }

  const rotate = () => {
    try {
      fs.renameSync(filePath, `${filePath}.1`)
    } catch {
      // A failed rotation keeps appending; the next line tries again.
      return
    }
    size = 0
  }

  return {
    filePath,
    append(line) {
      if (!open()) return
      const text = line.endsWith('\n') ? line : `${line}\n`
      if (size > 0 && size + Buffer.byteLength(text) > maxBytes) rotate()
      try {
        fs.appendFileSync(filePath, text)
        size += Buffer.byteLength(text)
      } catch {
        // Diagnostics must never break the bot.
      }
    },
  }
}
