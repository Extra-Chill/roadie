// Process-wide agent backend provider used by the session runtime.
//
// Pi is Roadie's agent backend (#177). Plugins replace the provider through
// the `agent_backend` filter, resolved once at startup by
// `resolveAgentBackendProvider()`. Tests swap it with `setAgentBackendProvider`,
// which returns a function restoring the previous provider.

import { applyFilters, applyFiltersAsync } from '../hooks.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getDataDir } from '../config.js'
import { store } from '../store.js'
import { PiBackendProvider } from './pi/backend.js'
import { getInjectionGuardDir } from '../injection-guard-config.js'
import { AgentRequestError, type AgentBackend, type AgentBackendProvider, type AgentCatalogOperations } from './types.js'

/**
 * ROADIE_BACKEND, when set, must be `pi`: the bot command's --backend flag
 * and the variable only accept the backend Roadie runs. Anything else is a
 * startup error, never a fallback.
 */
export function assertConfiguredBackend(): void {
  const raw = process.env['ROADIE_BACKEND']
  const value = raw?.trim().toLowerCase()
  if (!value || value === 'pi') return
  throw new Error(`ROADIE_BACKEND must be "pi", got "${raw}"`)
}

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
  // Opt-in shell isolation (--isolate-shells): Pi's bash tool goes through
  // the isolated-shell wrapper, and Pi only takes a shell through
  // `shellPath` in a Roadie-owned agent dir (the pools'). Without that dir the
  // backend refuses Pi sessions instead of running them unisolated.
  const isolateShellsUser = store.getState().isolateShellsUser
  return new PiBackendProvider({
    bin: process.env['ROADIE_PI_BIN'] || 'pi',
    sessionDir: process.env['ROADIE_PI_SESSION_DIR'] || path.join(getDataDir(), 'pi-sessions'),
    fileEditLogDir: getDataDir(),
    // --enable-skill / --disable-skill.
    enabledSkills: store.getState().enabledSkills,
    disabledSkills: store.getState().disabledSkills,
    // Configured --shell-env / ROADIE_SHELL_ENV templates for tool shells.
    shellEnvTemplates: store.getState().shellEnvTemplates,
    // Per-session injection guard files.
    injectionGuardDir: getInjectionGuardDir(),
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
  assertConfiguredBackend()
  const pi = buildPiProvider()
  const version = checkPiVersion(pi.options.bin)
  if (version instanceof Error) {
    throw new Error(`${version.message}. Roadie runs its agent sessions on Pi; install Pi ${MIN_PI_MAJOR}.x or newer`)
  }
  resolvedDefault = pi
  return resolvedDefault
}

/** Tests: forget the cached default so the next resolution re-reads the environment. */
export function clearResolvedDefaultProvider(): void {
  resolvedDefault = undefined
}

/**
 * Placeholder until resolveAgentBackendProvider() runs (after the data dir is
 * set): no backend yet, so every session operation fails clearly and no
 * session is owned.
 */
const unresolvedProvider: AgentBackendProvider = {
  id: 'unresolved',
  owns: () => false,
  getBackend: () => null,
  initializeForDirectory: async () => new AgentRequestError({ detail: 'Agent backend is not started yet' }),
  subscribeEvents: () => null,
  onStarted: () => {},
}

let currentProvider: AgentBackendProvider = withProviderFilters(unresolvedProvider)

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

/**
 * Whether `sessionId` is retired: the backend does not own it (e.g. a session
 * from the removed OpenCode backend, #177). Its thread starts a new session,
 * seeded from the thread, on the next prompt.
 */
export function isRetiredSession(sessionId: string): boolean {
  return !currentProvider.owns(sessionId)
}

const BACKEND_LABELS: Record<string, string> = { pi: 'Pi' }

/** Human-readable name of the running backend for prompts; unknown ids pass through. */
export function agentBackendLabel(): string {
  return BACKEND_LABELS[currentProvider.id] ?? currentProvider.id
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
  // Explicit delegation: providers are often class instances, whose methods a
  // spread would drop.
  return {
    id: provider.id,
    owns: (sessionId) => provider.owns(sessionId),
    getBackend(directory) {
      const backend = provider.getBackend(directory)
      return backend ? withFilters(backend) : null
    },
    async initializeForDirectory(directory, options) {
      const getBackend = await provider.initializeForDirectory(directory, options)
      if (getBackend instanceof Error) return getBackend
      return () => withFilters(getBackend())
    },
    subscribeEvents: (options) => provider.subscribeEvents(options),
    onStarted: (listener) => provider.onStarted(listener),
    ...(provider.dispose && { dispose: () => provider.dispose!() }),
  }
}

/** Stop the running backend's agent processes (bot shutdown). */
export async function stopAgentBackend(): Promise<void> {
  await currentProvider.dispose?.()
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
