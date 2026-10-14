// Process-wide agent backend provider used by the session runtime.
//
// Pi is the default backend (#177): every new session starts in Pi, sessions
// OpenCode already owns keep routing to OpenCode by session id, and the
// OpenCode server starts lazily on their first use. ROADIE_BACKEND=opencode
// (or --backend opencode) restores the old OpenCode default, including the
// deprecated per-channel Pi opt-in via ROADIE_PI_CHANNELS. Plugins replace the
// provider through the `agent_backend` filter, resolved once at startup by
// `resolveAgentBackendProvider()`. Tests swap it with `setAgentBackendProvider`,
// which returns a function restoring the previous provider.

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { toOpenCodeBackend } from './opencode-sessions.js'
import { applyFilters, applyFiltersAsync } from '../hooks.js'
import { openCodeBackendProvider } from './opencode.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getDataDir } from '../config.js'
import { store } from '../store.js'
import { PiBackendProvider } from './pi/backend.js'
import { withPiChannels, withPiDefault } from './pi/router.js'
import type { AgentBackend, AgentBackendProvider, AgentCatalogOperations } from './types.js'

/**
 * The ROADIE_BACKEND choice: `pi` (the default) or `opencode` (the previous
 * default, including the ROADIE_PI_CHANNELS per-channel opt-in). The same
 * values are accepted by the bot command's --backend flag, which wins over the
 * environment variable. Anything else is a startup error, never a fallback.
 */
export function configuredBackend(): 'pi' | 'opencode' {
  const raw = process.env['ROADIE_BACKEND']
  const value = raw?.trim().toLowerCase()
  if (!value || value === 'pi') return 'pi'
  if (value === 'opencode') return 'opencode'
  throw new Error(`ROADIE_BACKEND must be "pi" or "opencode", got "${raw}"`)
}

/**
 * The OpenCode fallback inside the Pi default (#230): on by default so
 * OpenCode-owned threads keep working until the backend is deleted (#177).
 * `ROADIE_OPENCODE_FALLBACK=0|false|off` disables it: OpenCode never starts and
 * OpenCode-owned session ids are retired, so threads bound to them migrate to a
 * fresh Pi session instead.
 */
export function opencodeFallbackEnabled(env: string | undefined = process.env['ROADIE_OPENCODE_FALLBACK']): boolean {
  const value = env?.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'off')
}

/**
 * The built-in default: Pi for every new session, with OpenCode serving the
 * sessions it already owns. ROADIE_BACKEND=opencode restores the previous
 * default (OpenCode, plus Pi for the channels listed in ROADIE_PI_CHANNELS,
 * comma-separated ids, #51 spike).
 */
let resolvedDefault: AgentBackendProvider | undefined

/** Pi 1.x is required: built-in MCP, `--approve`, and the 1.x RPC stream. */
export const MIN_PI_MAJOR = 1

export function checkPiVersion(bin: string, run: (bin: string) => string = (b) => execFileSync(b, ['--version'], { encoding: 'utf8', timeout: 15_000 })): string | Error {
  let output: string
  try {
    output = run(bin).trim()
  } catch (cause) {
    return new Error(`cannot run ${bin} --version`, { cause })
  }
  const major = Number(/(\d+)\.\d+\.\d+/.exec(output)?.[1])
  if (!Number.isFinite(major) || major < MIN_PI_MAJOR) return new Error(`${bin} is ${output || 'unknown'}; Roadie needs Pi ${MIN_PI_MAJOR}.x or newer`)
  return output
}
let piPool: (PiPoolHandle & { agentDir: string }) | undefined

/**
 * Bill Pi channels to the credential pools (call before resolveAgentBackendProvider,
 * once the pool proxy is running). Without it Pi uses its own credentials.
 */
export function setPiPool(pool: PiPoolHandle & { agentDir: string }): void {
  piPool = pool
}

type PiPoolHandle = NonNullable<ConstructorParameters<typeof PiBackendProvider>[0]['pool']>

/**
 * Pi's own default model, `defaultProvider`/`defaultModel` in the agent dir's
 * settings.json, as "provider/model". Used when ROADIE_PI_MODEL is unset, so
 * every Roadie path that needs an explicit model (titles, the catalog default,
 * `config()`) agrees with the model Pi itself starts sessions on.
 */
export function piSettingsDefaultModel(agentDir: string | undefined): string | undefined {
  if (!agentDir) return undefined
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')) as Record<string, unknown>
    const provider = settings['defaultProvider']
    const model = settings['defaultModel']
    return typeof provider === 'string' && provider && typeof model === 'string' && model ? `${provider}/${model}` : undefined
  } catch {
    return undefined
  }
}

/** The agent dir Pi reads: the pools' when they run, else PI_CODING_AGENT_DIR, else Pi's default. */
function piAgentDir(): string | undefined {
  return piPool?.agentDir || process.env['PI_CODING_AGENT_DIR'] || (os.homedir() ? path.join(os.homedir(), '.pi', 'agent') : undefined)
}

function buildPiProvider(): PiBackendProvider {
  const model = process.env['ROADIE_PI_MODEL'] || piSettingsDefaultModel(piAgentDir())
  // Opt-in shell isolation (--isolate-shells): Pi's bash tool must go through
  // the same wrapper as OpenCode's, and Pi only takes a shell through
  // `shellPath` in a Roadie-owned agent dir (the pools'). Without that dir the
  // backend refuses Pi sessions instead of running them unisolated.
  const isolateShellsUser = store.getState().isolateShellsUser
  return new PiBackendProvider({
    bin: process.env['ROADIE_PI_BIN'] || 'pi',
    sessionDir: process.env['ROADIE_PI_SESSION_DIR'] || path.join(getDataDir(), 'pi-sessions'),
    fileEditLogDir: getDataDir(),
    // Same --enable-skill / --disable-skill filter the OpenCode backend applies.
    enabledSkills: store.getState().enabledSkills,
    disabledSkills: store.getState().disabledSkills,
    // Same configured --shell-env / ROADIE_SHELL_ENV templates the OpenCode
    // backend's shell.env hook applies to tool shells.
    shellEnvTemplates: store.getState().shellEnvTemplates,
    // Same per-session injection guard files the OpenCode plugin reads.
    injectionGuardDir: path.join(getDataDir(), 'injection-guard'),
    ...(model && { model }),
    ...(process.env['ROADIE_PI_TITLE_MODEL'] && { titleModel: process.env['ROADIE_PI_TITLE_MODEL'] }),
    ...(piPool && { pool: piPool, env: { PI_CODING_AGENT_DIR: piPool.agentDir } }),
    ...(isolateShellsUser && {
      isolateShells: { username: isolateShellsUser, dataDir: getDataDir(), agentDir: piPool?.agentDir ?? null },
    }),
  })
}

function defaultProvider(): AgentBackendProvider {
  if (resolvedDefault) return resolvedDefault
  const backend = configuredBackend()
  const channels = (process.env['ROADIE_PI_CHANNELS'] ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  if (backend === 'opencode') {
    // The previous default. ROADIE_PI_CHANNELS still works here but is
    // deprecated: use the Pi default instead of per-channel opt-in.
    if (channels.length === 0) return openCodeBackendProvider
    console.warn('[agent-backend] ROADIE_PI_CHANNELS is deprecated and will be removed: set ROADIE_BACKEND=pi (the default) to run every new session on Pi')
    const pi = buildPiProvider()
    const version = checkPiVersion(pi.options.bin)
    if (version instanceof Error) {
      console.warn(`[agent-backend] Pi channels disabled, staying on OpenCode: ${version.message}`)
      return openCodeBackendProvider
    }
    resolvedDefault = withPiChannels({ fallback: openCodeBackendProvider, pi, channels: new Set(channels) })
    return resolvedDefault
  }
  // Pi is the default (#177). Per-channel opt-in has no effect here.
  if (channels.length > 0) {
    console.warn('[agent-backend] ROADIE_PI_CHANNELS is ignored: Pi is already the default backend (set ROADIE_BACKEND=opencode to restore the old per-channel behaviour)')
  }
  const pi = buildPiProvider()
  const version = checkPiVersion(pi.options.bin)
  if (version instanceof Error) {
    // No silent fallback: a Pi default with a missing or outdated binary must
    // fail startup with a clear error (opt back into OpenCode explicitly).
    throw new Error(`${version.message}. Pi is the default agent backend; install Pi ${MIN_PI_MAJOR}.x or newer, or set ROADIE_BACKEND=opencode to keep OpenCode as the default`)
  }
  resolvedDefault = withPiDefault({ fallback: openCodeBackendProvider, pi, fallbackEnabled: opencodeFallbackEnabled() })
  return resolvedDefault
}

/** Tests: forget the cached default so the next resolution re-reads the environment. */
export function clearResolvedDefaultProvider(): void {
  resolvedDefault = undefined
}

// The default (Pi over OpenCode) is built only in resolveAgentBackendProvider(),
// after the data dir is set. Until then the runtime holds the OpenCode
// placeholder, same as before.
let currentProvider: AgentBackendProvider = withProviderFilters(openCodeBackendProvider)

/**
 * The channel a backend choice is keyed on: a thread's parent, else the channel
 * itself. Backend selection (e.g. Pi channels) is per parent channel.
 */
export function backendChannelId(channel: { id: string; isThread?: () => boolean; parentId?: string | null } | null | undefined): string | undefined {
  if (!channel) return undefined
  return channel.isThread?.() ? (channel.parentId ?? channel.id) : channel.id
}

export function getAgentBackendProvider(): AgentBackendProvider {
  return currentProvider
}

/** Id of the backend running `sessionId` (e.g. "pi" or "opencode"). */
export function getSessionBackendId(sessionId: string): string {
  return currentProvider.sessionBackendId?.(sessionId) ?? currentProvider.id
}

const BACKEND_LABELS: Record<string, string> = { pi: 'Pi', opencode: 'OpenCode' }

/** Human-readable backend name for prompts; unknown ids pass through. */
export function agentBackendLabel(backendId: string): string {
  return BACKEND_LABELS[backendId] ?? backendId
}

/** Catalog listings run through the `agent_providers` / `agent_definitions` filters. */
export function withCatalogFilters(catalog: AgentCatalogOperations): AgentCatalogOperations {
  return {
    async providers(input) {
      const result = await catalog.providers(input)
      return result instanceof Error ? result : applyFiltersAsync('agent_providers', result, input)
    },
    config: (input) => catalog.config(input),
    ...(catalog.commands && { commands: catalog.commands.bind(catalog) }),
    async agents(input) {
      const result = await catalog.agents(input)
      return result instanceof Error ? result : applyFiltersAsync('agent_definitions', result, input)
    },
  }
}

const filteredBackends = new WeakMap<AgentBackend, AgentBackend>()

function withFilters(backend: AgentBackend): AgentBackend {
  const cached = filteredBackends.get(backend)
  if (cached) return cached
  const filtered = { ...backend, catalog: withCatalogFilters(backend.catalog) }
  filteredBackends.set(backend, filtered)
  return filtered
}

/** The provider with catalog filters applied, whichever backend it is. */
function withProviderFilters(provider: AgentBackendProvider): AgentBackendProvider {
  return {
    ...provider,
    getBackend(directory) {
      const backend = provider.getBackend(directory)
      return backend ? withFilters(backend) : null
    },
    async initializeForDirectory(directory, options) {
      const getBackend = await provider.initializeForDirectory(directory, options)
      if (getBackend instanceof Error) return getBackend
      return () => withFilters(getBackend())
    },
  }
}

/**
 * Catalog getter for code that still holds a raw OpenCode client (some
 * commands). Same Roadie types and filters as the runtime sees.
 */
export function openCodeCatalogGetter(getClient: () => OpencodeClient): () => AgentBackend {
  return () => withFilters(toOpenCodeBackend(getClient()))
}

/** Apply the `agent_backend` filter. Call after plugins load, before the bot starts. */
export function resolveAgentBackendProvider(): AgentBackendProvider {
  currentProvider = withProviderFilters(applyFilters('agent_backend', defaultProvider(), {}))
  return currentProvider
}

export function setAgentBackendProvider(
  provider: AgentBackendProvider,
): () => void {
  const previous = currentProvider
  currentProvider = withProviderFilters(provider)
  return () => {
    currentProvider = previous
  }
}
