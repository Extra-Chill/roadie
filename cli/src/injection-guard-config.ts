// Per-session injection guard config (`send --injection-guard`). The bot
// writes `<dataDir>/injection-guard/<sessionId>.json`; the Pi backend's
// extension reads it and scans tool output for the patterns.

import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'

export function getInjectionGuardDir(): string {
  return path.join(getDataDir(), 'injection-guard')
}

/** Write a session's scan patterns; best effort, never throws. */
export function writeInjectionGuardConfig({
  sessionId,
  scanPatterns,
}: {
  sessionId: string
  scanPatterns: string[]
}): void {
  if (scanPatterns.length === 0) {
    return
  }
  try {
    const dir = getInjectionGuardDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ scanPatterns }))
  } catch {
    // Best effort -- don't crash the bot if data dir write fails
  }
}
