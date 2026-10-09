// Opt-in OS isolation for agent tool shells (--isolate-shells <user>).
//
// #144 scoped what a tool shell may do through the bot (per-session agent
// token, no database credentials), but the shell still runs as the bot's own
// OS user: it can read the OpenCode server's /proc/<pid>/environ, <dataDir>
// and the credential pool files. This module closes that gap when the
// operator opts in: Roadie generates a shell wrapper that drops to an
// unprivileged user with util-linux setpriv and replaces the environment with
// a fixed allowlist, and the OpenCode server is started with SHELL pointing
// at the wrapper. OpenCode picks its tool shell from $SHELL (accepting bash,
// zsh or fish by basename), so every bash tool call runs as the agent user.
//
// The wrapper passes an allowlist only: PATH (fixed value, not inherited),
// HOME (the agent user's home), TERM, LANG, and the ROADIE_* attribution
// vars, ROADIE_SESSION_ID and ROADIE_AGENT_TOKEN from #144. Nothing else is
// inherited, so ROADIE_DB_*, ROADIE_SERVICE_TOKEN_FILE,
// ROADIE_AGENT_TOKEN_SECRET and provider keys never reach a tool shell.
//
// Off by default: with the flag unset, SHELL and the generated OpenCode
// config are unchanged.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execAsync } from './exec-async.js'

export const ISOLATE_SHELLS_ENV = 'ROADIE_ISOLATE_SHELLS'

/** Linux capability bits: CAP_SETGID=6, CAP_SETUID=7. */
const CAP_SETGID_BIT = 1 << 6
const CAP_SETUID_BIT = 1 << 7
export const SETUID_SETGID_CAPABILITY_MASK = CAP_SETUID_BIT | CAP_SETGID_BIT

/** Fixed PATH inside isolated shells. Deliberately not inherited: the bot user's PATH may point at root-only tool dirs. */
export const ISOLATED_SHELL_PATH = '/usr/local/bin:/usr/bin:/bin'

/**
 * Env names forwarded from the shell env OpenCode gives $SHELL into the inner
 * bash. The attribution names mirror turn-attribution-env.ts
 * (TURN_ATTRIBUTION_ENV_NAMES, prefixed with ROADIE_), ROADIE_SESSION_ID is
 * the bash env contract from bash-tool-schema-plugin.ts, and
 * ROADIE_AGENT_TOKEN is the #144 per-session agent token from agent-token.ts.
 * Credentials (ROADIE_DB_*, ROADIE_SERVICE_TOKEN_FILE,
 * ROADIE_AGENT_TOKEN_SECRET, provider keys) are never in this list, and
 * `env -i` drops everything else.
 */
export const ISOLATED_SHELL_FORWARD_ENV_NAMES = [
  'ROADIE_SESSION_ID',
  'ROADIE_AGENT_TOKEN',
  'ROADIE_THREAD_ID',
  'ROADIE_CHANNEL_ID',
  'ROADIE_ACTOR_PLATFORM',
  'ROADIE_ACTOR_ID',
  'ROADIE_ACTOR_NAME',
  'ROADIE_ACTOR_VIA',
  'ROADIE_PERSON_ID',
] as const

/** `<dataDir>/bin/isolated-shell/bash` — the generated wrapper passed as SHELL. */
export function isolatedShellWrapperPath({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, 'bin', 'isolated-shell', 'bash')
}

/**
 * The agent account resolved from the password database (getent passwd):
 * numeric ids go into the wrapper so setpriv never needs an NSS lookup at
 * shell-spawn time.
 */
export type IsolatedShellAccount = {
  username: string
  uid: number
  gid: number
  home: string
}

/** Parse a CapEff hex value (e.g. from /proc/self/status) into a Number. Returns null when unparsable. */
export function parseCapEffHex(hex: string): number | null {
  const value = hex.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(value)) return null
  const parsed = Number.parseInt(value, 16)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Pure privilege contract for --isolate-shells: the bot must run as root or
 * hold CAP_SETUID and CAP_SETGID in its effective set. Injectable so unit
 * tests never need root.
 */
export function checkShellIsolationPrivileges({
  effectiveUid,
  effectiveCapabilities,
  platform,
}: {
  effectiveUid: number | null
  effectiveCapabilities: string | null
  platform: NodeJS.Platform
}): true | Error {
  if (platform !== 'linux') {
    return new Error(
      `--isolate-shells is Linux-only (it wraps shells with util-linux setpriv); ${platform} is not supported`,
    )
  }
  if (effectiveUid === 0) return true
  const bits = effectiveCapabilities === null ? null : parseCapEffHex(effectiveCapabilities)
  if (bits !== null && (bits & SETUID_SETGID_CAPABILITY_MASK) === SETUID_SETGID_CAPABILITY_MASK) {
    return true
  }
  return new Error(
    `Shell isolation requires the bot to run as root or with CAP_SETUID and CAP_SETGID ` +
      `(current euid=${effectiveUid ?? 'unknown'}, CapEff=${effectiveCapabilities ?? 'unavailable'}). ` +
      'Run roadie as root, or grant the capabilities to its service unit ' +
      '(AmbientCapabilities=CAP_SETUID CAP_SETGID)',
  )
}

/** Live privilege inputs for checkShellIsolationPrivileges, read from this process. */
export function readShellIsolationPrivilegeInputs(): {
  effectiveUid: number | null
  effectiveCapabilities: string | null
  platform: NodeJS.Platform
} {
  const effectiveUid = typeof process.getuid === 'function' ? process.getuid() : null
  let effectiveCapabilities: string | null = null
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8')
    effectiveCapabilities = /^CapEff:\s+(\S+)$/m.exec(status)?.[1] ?? null
  } catch {
    effectiveCapabilities = null
  }
  return { effectiveUid, effectiveCapabilities, platform: process.platform }
}

/** Resolve a command to an absolute PATH entry with `which`, failing closed. */
export async function resolveIsolationBinary({ name }: { name: string }): Promise<string | Error> {
  const result = await execAsync(`which ${name}`, { timeout: 5_000 }).catch(() => undefined)
  const resolved = result?.stdout.trim().split('\n')[0]?.trim()
  if (!resolved) {
    return new Error(
      `Shell isolation requires ${name} on PATH` +
        (name === 'setpriv' ? ' (util-linux; install the util-linux package)' : ''),
    )
  }
  return resolved
}

/** Resolve the agent user's uid/gid/home from the password database. */
export async function resolveAgentAccount({
  username,
}: {
  username: string
}): Promise<IsolatedShellAccount | Error> {
  const result = await execAsync(
    { command: 'getent', args: ['passwd', username] },
    { timeout: 5_000 },
  ).catch(() => undefined)
  const entry = result?.stdout.trim().split('\n')[0]?.trim()
  if (!entry) {
    return new Error(
      `Shell isolation user "${username}" does not exist (getent passwd failed). ` +
        `Create it first, e.g. useradd --system --create-home --home-dir /home/${username} ${username}`,
    )
  }
  const fields = entry.split(':')
  const uid = Number(fields[2])
  const gid = Number(fields[3])
  const home = fields[5] ?? ''
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || !home) {
    return new Error(`Could not parse the passwd entry for shell isolation user "${username}": ${entry}`)
  }
  if (uid === 0 || gid === 0) {
    // Dropping to uid/gid 0 isolates nothing: the shell would still read the
    // server's environment, the data dir and the credential pools.
    return new Error(
      `Shell isolation user "${username}" has uid ${uid} / gid ${gid}; it must be an unprivileged account`,
    )
  }
  return { username, uid, gid, home }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Pure wrapper generator. The exec'd env -i allowlist is the security
 * boundary: every name not listed below is dropped, and the ROADIE_* names
 * are forwarded only from the shell env OpenCode already gave $SHELL (the
 * shell.env hook output), with an empty value when unset.
 */
export function buildIsolatedShellScript({
  setprivPath,
  envPath,
  bashPath,
  account,
  pathValue = ISOLATED_SHELL_PATH,
}: {
  setprivPath: string
  envPath: string
  bashPath: string
  account: IsolatedShellAccount
  pathValue?: string
}): string {
  const forwarded = ISOLATED_SHELL_FORWARD_ENV_NAMES.map(
    (name) => `  ${name}="\${${name}-}"`,
  )
  return [
    '#!/bin/bash',
    `# Generated by Roadie (--isolate-shells ${account.username}). Do not edit:`,
    '# the bot rewrites this file on every OpenCode server start.',
    '# Runs the agent tool shell as an unprivileged user: setpriv drops to the',
    '# account below and env -i replaces the environment with a fixed allowlist,',
    "# so the OpenCode server's credentials never reach a tool shell.",
    `exec ${shellSingleQuote(setprivPath)} --reuid=${account.uid} --regid=${account.gid} --init-groups --no-new-privs \\`,
    `  ${shellSingleQuote(envPath)} -i \\`,
    `  PATH=${shellSingleQuote(pathValue)} \\`,
    `  HOME=${shellSingleQuote(account.home)} \\`,
    '  TERM="${TERM:-dumb}" \\',
    '  LANG="${LANG:-C.UTF-8}" \\',
    // The bash invocation is part of the same env command: every line above
    // continues with " \", and only this final line ends without one — a
    // missing continuation would leave env without a command operand and make
    // it print the environment instead of exec'ing the shell.
    [...forwarded, `  ${shellSingleQuote(bashPath)} "$@"`].join(' \\\n'),
    '',
  ].join('\n')
}

/** Write the wrapper under <dataDir>/bin/isolated-shell/bash, mode 0755. Idempotent. */
export function writeIsolatedShellWrapper({
  dataDir,
  script,
}: {
  dataDir: string
  script: string
}): string | Error {
  const wrapperPath = isolatedShellWrapperPath({ dataDir })
  try {
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true })
    const existing = (() => {
      try {
        return fs.readFileSync(wrapperPath, 'utf8')
      } catch {
        return ''
      }
    })()
    if (existing !== script) {
      fs.writeFileSync(wrapperPath, script, { mode: 0o755 })
    }
    fs.chmodSync(wrapperPath, 0o755)
    return wrapperPath
  } catch (error) {
    return new Error(`Could not write the isolated shell wrapper at ${wrapperPath}`, { cause: error })
  }
}

/**
 * Fail-fast setup for --isolate-shells: verify privileges, resolve the agent
 * account and the wrapper binaries (setpriv, env, bash) from PATH, and write
 * the wrapper. Returns the wrapper path (to pass as SHELL) plus the account
 * for the advisory directory check.
 */
export async function ensureIsolatedShellWrapper({
  dataDir,
  username,
}: {
  dataDir: string
  username: string
}): Promise<{ shellPath: string; account: IsolatedShellAccount } | Error> {
  const privileges = checkShellIsolationPrivileges({
    ...readShellIsolationPrivilegeInputs(),
  })
  if (privileges instanceof Error) return privileges
  if (!username.trim()) {
    return new Error('--isolate-shells requires a username')
  }
  const account = await resolveAgentAccount({ username })
  if (account instanceof Error) return account
  const [setprivPath, envPath, bashPath] = await Promise.all([
    resolveIsolationBinary({ name: 'setpriv' }),
    resolveIsolationBinary({ name: 'env' }),
    resolveIsolationBinary({ name: 'bash' }),
  ])
  if (setprivPath instanceof Error) return setprivPath
  if (envPath instanceof Error) return envPath
  if (bashPath instanceof Error) return bashPath
  const script = buildIsolatedShellScript({ setprivPath, envPath, bashPath, account })
  const shellPath = writeIsolatedShellWrapper({ dataDir, script })
  if (shellPath instanceof Error) return shellPath
  return { shellPath, account }
}

// ── Doctor-style access check ────────────────────────────────────
// Advisory confirmation that the agent user can work in the project
// directories (shared group plus setgid directories) while the bot's private
// paths stay out of reach. Pure evaluation over stat results; the caller
// gathers them so tests never need root.

export type IsolationAccessExpectation = 'agent-read-write' | 'agent-denied'

export type IsolationAccessEntry = {
  path: string
  expectation: IsolationAccessExpectation
  uid: number
  gid: number
  mode: number
}

function canReadWriteExecute({
  uid,
  gid,
  mode,
  agentUid,
  agentGid,
}: {
  uid: number
  gid: number
  mode: number
  agentUid: number
  agentGid: number
}): boolean {
  if (uid === agentUid && (mode & 0o700) === 0o700) return true
  if (gid === agentGid && (mode & 0o070) === 0o070) return true
  return (mode & 0o007) === 0o007
}

function canRead({
  uid,
  gid,
  mode,
  agentUid,
  agentGid,
}: {
  uid: number
  gid: number
  mode: number
  agentUid: number
  agentGid: number
}): boolean {
  if (uid === agentUid && (mode & 0o400) !== 0) return true
  if (gid === agentGid && (mode & 0o040) !== 0) return true
  return (mode & 0o004) !== 0
}

/** Human-readable problems; an empty list means the layout matches the isolation contract. */
export function evaluateIsolatedShellAccess({
  agentUid,
  agentGid,
  entries,
}: {
  agentUid: number
  agentGid: number
  entries: IsolationAccessEntry[]
}): string[] {
  const problems: string[] = []
  for (const entry of entries) {
    const { path: entryPath, expectation, uid, gid, mode } = entry
    if (expectation === 'agent-read-write') {
      if (!canReadWriteExecute({ uid, gid, mode, agentUid, agentGid })) {
        problems.push(
          `${entryPath}: the agent user cannot read and write here. ` +
            `Share it with a group the agent belongs to with setgid directories: ` +
            `chgrp <agent-group> ${entryPath} && chmod 2770 ${entryPath}`,
        )
      }
      continue
    }
    if (canRead({ uid, gid, mode, agentUid, agentGid })) {
      problems.push(
        `${entryPath}: the agent user can read this. Keep the bot's data ` +
          `private from tool shells: run chown root ${entryPath} && chmod 700 ${entryPath}`,
      )
    }
  }
  return problems
}

/**
 * Advisory doctor-style check for the flag on: the projects directory must be
 * agent-writable while the bot's private paths (<dataDir>, the credential
 * pool directory and the OpenCode state home) must not be agent-readable.
 * Missing paths are skipped. `deniedPaths` overrides the defaults so tests
 * stay hermetic.
 */
export function checkIsolatedShellSetup({
  dataDir,
  projectDirectories,
  account,
  deniedPaths = [
    dataDir,
    path.join(dataDir, 'credentials'),
    path.join(os.homedir(), '.local', 'share', 'opencode'),
  ],
}: {
  dataDir: string
  projectDirectories: string[]
  account: IsolatedShellAccount
  deniedPaths?: string[]
}): string[] {
  const candidates: Array<{ path: string; expectation: IsolationAccessExpectation }> = [
    ...projectDirectories.map((projectDirectory) => ({
      path: projectDirectory,
      expectation: 'agent-read-write' as const,
    })),
    ...deniedPaths.map((deniedPath) => ({
      path: deniedPath,
      expectation: 'agent-denied' as const,
    })),
  ]
  const entries: IsolationAccessEntry[] = []
  for (const candidate of candidates) {
    const stat = (() => {
      try {
        return fs.statSync(candidate.path)
      } catch {
        return null
      }
    })()
    if (!stat) continue
    entries.push({
      path: candidate.path,
      expectation: candidate.expectation,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode,
    })
  }
  return evaluateIsolatedShellAccess({ agentUid: account.uid, agentGid: account.gid, entries })
}
