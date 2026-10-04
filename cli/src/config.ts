// Runtime configuration for Roadie bot.
// Thin re-export layer over the centralized zustand store (store.ts).
// Getter/setter functions are kept for backwards compatibility so existing
// import sites don't need to change. They delegate to store.getState() and
// store.setState() under the hood.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from './store.js'

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.roadie')
/** Read a ROADIE_* environment variable. */
export function getRoadieEnv(name: string): string | undefined {
  return process.env[name]
}

/**
 * Read a secret from ROADIE_<NAME> or, failing that, from the file named by
 * ROADIE_<NAME>_FILE (trailing whitespace trimmed). File form keeps secrets
 * out of process environments and service units. Returns undefined when
 * neither is set; throws when the file is set but unreadable or empty.
 */
export function readRoadieSecret(name: string): string | undefined {
  const direct = process.env[name]?.trim()
  if (direct) return direct
  const file = process.env[`${name}_FILE`]?.trim()
  if (!file) return undefined
  let value: string
  try {
    value = fs.readFileSync(file, 'utf8').trim()
  } catch (e) {
    throw new Error(`${name}_FILE (${file}) is not readable: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!value) throw new Error(`${name}_FILE (${file}) is empty`)
  return value
}

/**
 * Get the data directory path.
 * Order: store value, vitest temp dir, ROADIE_DATA_DIR, then ~/.roadie.
 * Under vitest (ROADIE_VITEST env var), auto-creates an isolated temp dir so
 * tests never touch the real ~/.roadie/ database. Tests that need a specific
 * dir can still call setDataDir() before any DB access to override this.
 */
export function getDataDir(): string {
  const current = store.getState().dataDir
  if (current) {
    return current
  }
  // Tests stay isolated even if the parent process exported ROADIE_DATA_DIR.
  if (process.env.ROADIE_VITEST) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-test-'))
    store.setState({ dataDir: tmpDir })
    return tmpDir
  }
  // Child processes (OpenCode server, roadie shim commands) inherit this from
  // opencode.ts. Without it they would silently use ~/.roadie.
  const fromEnv = getRoadieEnv('ROADIE_DATA_DIR')
  if (fromEnv) {
    const resolved = path.resolve(fromEnv)
    store.setState({ dataDir: resolved })
    return resolved
  }
  const defaultDir = resolveDefaultDataDir(os.homedir())
  store.setState({ dataDir: defaultDir })
  return defaultDir
}

export function resolveDefaultDataDir(homeDir: string): string {
  return path.join(homeDir, '.roadie')
}

/**
 * Set the data directory path.
 * Creates the directory if it doesn't exist.
 * Must be called before any database or path-dependent operations.
 */
export function setDataDir(dir: string): void {
  const resolvedDir = path.resolve(dir)

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true })
  }

  store.setState({ dataDir: resolvedDir })
}

/**
 * Get the projects directory path (for /create-new-project command).
 * Returns the custom --projects-dir if set, otherwise <dataDir>/projects.
 */
export function getProjectsDir(): string {
  const custom = store.getState().projectsDir
  if (custom) {
    return custom
  }
  return path.join(getDataDir(), 'projects')
}

/**
 * Set a custom projects directory path (from --projects-dir CLI flag).
 * Creates the directory if it doesn't exist.
 */
export function setProjectsDir(dir: string): void {
  const resolvedDir = path.resolve(dir)

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true })
  }

  store.setState({ projectsDir: resolvedDir })
}

/**
 * Get the permission button timeout in milliseconds.
 * How long permission buttons remain active before auto-rejecting.
 * Defaults to 10 minutes (600000ms).
 */
export function getPermissionTimeoutMs(): number {
  return store.getState().permissionTimeoutMs
}

/**
 * Whether external directory access is restricted to the session working
 * directory plus a few known-safe paths.
 * Defaults to false: every directory is allowed and users protect specific
 * folders with their own `deny`/`ask` rules in opencode.json.
 */
export function getRestrictExternalDirectories(): boolean {
  return store.getState().restrictExternalDirectories
}

export function getOpencodeHostname(): string | null {
  return store.getState().opencodeHostname
}

export function getOpencodePort(): number | null {
  return store.getState().opencodePort
}

export type { RegisteredUserCommand } from './store.js'

const DEFAULT_LOCK_PORT = 29988
export const CUSTOM_LOCK_PORT_BASE = 12_000

/**
 * Derive a lock port from the data directory path.
 * If ROADIE_LOCK_PORT is set to a valid TCP port, it takes precedence.
 * Returns 29988 for the default ~/.roadie directory (backwards compatible).
 * For custom data dirs, uses a hash to generate a port in the range 12000-21999:
 * below the OS ephemeral range (32768+ on Linux), where the kernel could hand
 * the port to an unrelated connection, and clear of the test ranges (22000+).
 */
export function getLockPort(): number {
  const envPortRaw = getRoadieEnv('ROADIE_LOCK_PORT')
  if (envPortRaw) {
    const envPort = Number.parseInt(envPortRaw, 10)
    if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) {
      return envPort
    }
  }

  const dir = getDataDir()

  // Use original port for default data dir (backwards compatible)
  if (dir === DEFAULT_DATA_DIR) {
    return DEFAULT_LOCK_PORT
  }

  // Hash-based port for custom data dirs
  let hash = 0
  for (let i = 0; i < dir.length; i++) {
    const char = dir.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return CUSTOM_LOCK_PORT_BASE + (Math.abs(hash) % 10000)
}
