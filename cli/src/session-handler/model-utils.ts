// Model resolution utilities.
// getDefaultModel resolves the default model from OpenCode when no user preference is set.
// listModels wraps provider.list() with a per-directory memoized cache.

import fs from 'node:fs'
import path from 'node:path'
import { xdgState } from 'xdg-basedir'
import * as errore from 'errore'
import type { AgentProviderInfo } from '../agent-backend/types.js'
import type { AgentCatalogGetter } from '../agent-backend/types.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import {
  formatCandidateRef,
  PROVIDER_ID as SUBROUTER_PROVIDER_ID,
  resolveLiveModel,
} from '@subrouter/cli'
import { InvalidModelError, OpenCodeSdkError } from '../errors.js'
import {
  subscribeOpencodeServerLifecycle,
} from '../opencode.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getDataDir } from '../config.js'
import { store } from '../store.js'
import { hasSubrouterHandoff } from '../credentials/migrate-subrouter.js'
import { ROADIE_PROVIDER_ID } from '../credentials/provider.js'
import { readSessionRoute } from '../credentials/routes.js'
import type { ScheduledTaskScheduleKind } from '../database.js'

const sessionLogger = createLogger(LogPrefix.SESSION)

export type DefaultModelSource =
  | 'opencode-config'
  | 'opencode-recent'
  | 'opencode-provider-default'

export type SessionStartSourceContext = {
  scheduleKind: ScheduledTaskScheduleKind
  scheduledTaskId?: number
  scheduledTaskRunId?: number
}

/**
 * Read user's recent models from OpenCode TUI's state file.
 * Uses same path as OpenCode: path.join(xdgState, "opencode", "model.json")
 * Returns all recent models so we can iterate until finding a valid one.
 * See: opensrc/repos/github.com/sst/opencode/packages/opencode/src/global/index.ts
 */
function getRecentModelsFromTuiState(): Array<{
  providerID: string
  modelID: string
}> {
  if (!xdgState) {
    return []
  }
  // Same path as OpenCode TUI: path.join(Global.Path.state, "model.json")
  const modelJsonPath = path.join(xdgState, 'opencode', 'model.json')

  const result = errore.tryFn(() => {
    const content = fs.readFileSync(modelJsonPath, 'utf-8')
    const data = JSON.parse(content) as {
      recent?: Array<{ providerID: string; modelID: string }>
    }
    return data.recent ?? []
  })

  if (result instanceof Error) {
    // File doesn't exist or is invalid - this is normal for fresh installs
    return []
  }

  return result
}

/**
 * Parse a model string in format "provider/model" into providerID and modelID.
 */
export function parseModelId(
  model: string,
): { providerID: string; modelID: string } | undefined {
  const [providerID, ...modelParts] = model.split('/')
  const modelID = modelParts.join('/')
  if (!providerID || !modelID) {
    return undefined
  }
  return { providerID, modelID }
}

function getModelFromProjectConfig({
  directory,
}: {
  directory?: string
}): { providerID: string; modelID: string } | undefined {
  if (!directory) {
    return undefined
  }

  const result = errore.tryFn(() => {
    const configPath = path.join(directory, 'opencode.json')
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as { model?: string }
    if (!parsed.model) {
      return undefined
    }
    return parseModelId(parsed.model)
  })
  if (result instanceof Error) return undefined
  return result
}

/**
 * Validate that a model is available (provider connected + model exists).
 */
function isModelValid(
  model: { providerID: string; modelID: string },
  connected: string[],
  providers: Array<{ id: string; models?: Record<string, unknown> }>,
): boolean {
  const isConnected = connected.includes(model.providerID)
  const provider = providers.find((p) => {
    return p.id === model.providerID
  })
  const modelExists = provider?.models && model.modelID in provider.models
  return isConnected && !!modelExists
}

export type ListedModel = {
  providerID: string
  modelID: string
  name: string
  connected: boolean
}

type ProviderModelLookup = {
  id: string
  models?: Record<string, { name?: string } | undefined>
}

/** SDK display name from provider.list. */
export function getProviderModelName({
  providers,
  providerID,
  modelID,
}: {
  providers: ProviderModelLookup[]
  providerID?: string
  modelID?: string
}): string | undefined {
  if (!providerID || !modelID) return undefined
  const provider = providers.find((p) => p.id === providerID)
  const model = provider?.models?.[modelID]
  if (!model) return undefined
  if (typeof model.name === 'string' && model.name.trim()) return model.name
  return modelID
}

/** Use the SDK name only when it is the model id, or the model id plus `(live-model)`. */
export function displayedModelLabel({
  modelID,
  name,
}: {
  modelID: string
  name?: string
}): string {
  if (!name) return modelID
  if (name === modelID) return name
  if (name.startsWith(`${modelID} (`) && name.endsWith(')')) {
    // A subrouter preset named after its own live model ("anthropic-claude-
    // opus-5-5 (anthropic/claude-opus-5-5)") says the same thing twice. Show
    // the live model once. A preset with its own name, or one that fell back
    // to a different model, keeps both parts.
    const live = name.slice(modelID.length + 2, -1)
    return modelNameSlug(live) === modelNameSlug(modelID) ? live : name
  }
  return modelID
}

function modelNameSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function formatDisplayedModelId({
  providerID,
  modelID,
  name,
}: {
  providerID?: string
  modelID?: string
  name?: string
}): string | undefined {
  if (!providerID || !modelID) return undefined
  return `${providerID}/${displayedModelLabel({ modelID, name })}`
}

/**
 * `roadie/<rotation>` resolves to the live candidate the session's held route
 * points at (credentials/routes.ts, pinned by the pool provider and cleared on
 * session.idle). Without a route the rotation name itself is shown: the SDK
 * name falls through `displayedModelLabel`, which keeps the model id.
 */
export function resolveRoadieRouteDisplayName({
  dataDir,
  rotation,
  sessionID,
  now = Date.now(),
}: {
  dataDir: string
  rotation: string
  sessionID?: string
  now?: number
}): string | undefined {
  if (!sessionID) return undefined
  const route = readSessionRoute({ dataDir, sessionId: sessionID, now })
  if (!route || route.rotation !== rotation) return undefined
  return `${rotation} (${route.provider}/${route.modelId})`
}

/** Subrouter presets and roadie rotations resolve to the live candidate. */
export async function resolveDisplayedModelName({
  providers,
  providerID,
  modelID,
  sessionID,
}: {
  providers: ProviderModelLookup[]
  providerID?: string
  modelID?: string
  sessionID?: string
}): Promise<string | undefined> {
  // After the subrouter handoff `subrouter/<preset>` is served by the pool, so
  // it resolves like `roadie/<rotation>` and subrouter's own store is never read.
  const subrouterServedByPool =
    providerID === SUBROUTER_PROVIDER_ID &&
    store.getState().credentialPoolsEnabled &&
    hasSubrouterHandoff({ dataDir: getDataDir() })
  if (providerID === SUBROUTER_PROVIDER_ID && modelID && !subrouterServedByPool) {
    const candidate = await resolveLiveModel({ preset: modelID, sessionID }).catch((e) => {
      sessionLogger.warn(
        `[MODEL] Failed to resolve subrouter candidate for ${modelID}:`,
        e instanceof Error ? e.message : e,
      )
      return null
    })
    if (candidate) return `${modelID} (${formatCandidateRef(candidate)})`
  }
  if ((providerID === ROADIE_PROVIDER_ID || subrouterServedByPool) && modelID) {
    const live = resolveRoadieRouteDisplayName({
      dataDir: getDataDir(),
      rotation: modelID,
      sessionID,
    })
    if (live) return live
  }
  return getProviderModelName({ providers, providerID, modelID })
}

export async function resolveDisplayedModelId({
  providers,
  providerID,
  modelID,
  sessionID,
}: {
  providers: ProviderModelLookup[]
  providerID?: string
  modelID?: string
  sessionID?: string
}): Promise<string | undefined> {
  return formatDisplayedModelId({
    providerID,
    modelID,
    name: await resolveDisplayedModelName({ providers, providerID, modelID, sessionID }),
  })
}

type ModelListCacheEntry =
  | { status: 'pending'; promise: Promise<ListedModel[] | OpenCodeSdkError> }
  | { status: 'ready'; value: ListedModel[] }

const modelListCache = new Map<string, ModelListCacheEntry>()

export function clearModelListCache() {
  modelListCache.clear()
}

subscribeOpencodeServerLifecycle(() => {
  clearModelListCache()
})

function flattenProviderModels({
  providers,
  connected,
}: {
  providers: AgentProviderInfo[]
  connected: string[]
}): ListedModel[] {
  const connectedSet = new Set(connected)
  const models: ListedModel[] = []
  for (const provider of providers) {
    const isConnected = connectedSet.has(provider.id)
    for (const [modelID, model] of Object.entries(provider.models)) {
      models.push({
        providerID: provider.id,
        modelID,
        name: model.name || modelID,
        connected: isConnected,
      })
    }
  }
  return models
}

export async function listModels({
  getClient,
  directory,
}: {
  getClient: AgentCatalogGetter
  directory?: string
}): Promise<ListedModel[] | OpenCodeSdkError> {
  const cacheKey = directory ?? ''
  const cached = modelListCache.get(cacheKey)
  if (cached?.status === 'ready') return cached.value
  if (cached?.status === 'pending') return cached.promise

  const promise = (async () => {
    const catalog = await getClient().catalog.providers({ directory })
    if (catalog instanceof Error) return new OpenCodeSdkError({ operation: 'provider.list', cause: catalog })
    return flattenProviderModels({
      providers: catalog.providers,
      connected: catalog.connected,
    })
  })()

  modelListCache.set(cacheKey, { status: 'pending', promise })
  const result = await promise
  const current = modelListCache.get(cacheKey)
  const ownsCacheEntry = current?.status === 'pending' && current.promise === promise
  if (result instanceof Error) {
    if (ownsCacheEntry) modelListCache.delete(cacheKey)
    return result
  }
  if (ownsCacheEntry) modelListCache.set(cacheKey, { status: 'ready', value: result })
  return result
}

export function validateModelIdAgainstList({
  model,
  models,
}: {
  model: string
  models: ListedModel[]
}): { providerID: string; modelID: string } | InvalidModelError {
  const parsed = parseModelId(model)
  if (!parsed) {
    return new InvalidModelError({
      model,
      reason: 'expected provider/model, for example anthropic/claude-opus-4-6',
    })
  }

  const match = models.find((candidate) => {
    return (
      candidate.providerID === parsed.providerID &&
      candidate.modelID === parsed.modelID
    )
  })
  if (!match) {
    const siblings = models
      .filter((candidate) => candidate.providerID === parsed.providerID)
      .map((candidate) => `${candidate.providerID}/${candidate.modelID}`)
    if (siblings.length > 0) {
      return new InvalidModelError({
        model,
        reason: `unknown model. Similar: ${siblings.slice(0, 8).join(', ')}`,
      })
    }
    const connectedProviders = [
      ...new Set(
        models.filter((candidate) => candidate.connected).map((candidate) => {
          return candidate.providerID
        }),
      ),
    ]
    const connectedHint = connectedProviders.length
      ? ` Connected providers: ${connectedProviders.join(', ')}`
      : ''
    return new InvalidModelError({
      model,
      reason: `unknown provider ${parsed.providerID}.${connectedHint}`,
    })
  }
  if (!match.connected) {
    return new InvalidModelError({
      model,
      reason: `provider ${parsed.providerID} is not connected`,
    })
  }
  return parsed
}

export async function validateModelId({
  model,
  getClient,
  directory,
}: {
  model: string
  getClient: AgentCatalogGetter
  directory?: string
}): Promise<
  { providerID: string; modelID: string } | InvalidModelError | OpenCodeSdkError
> {
  const models = await listModels({ getClient, directory })
  if (models instanceof Error) return models
  return validateModelIdAgainstList({ model, models })
}

export async function validateCliModelOption({
  model,
  directory,
}: {
  model: string | undefined
  directory?: string
}) {
  if (!model) return
  const parsed = parseModelId(model)
  if (!parsed) {
    return new InvalidModelError({
      model,
      reason: 'expected provider/model, for example anthropic/claude-opus-4-6',
    })
  }
  if (!directory) return parsed

  const getClient = await getAgentBackendProvider().initializeForDirectory(directory)
  if (getClient instanceof Error) return getClient
  return validateModelId({ model, getClient, directory })
}

/**
 * Get the default model from OpenCode when no user preference is set.
 * Priority (matches OpenCode TUI behavior):
 * 1. OpenCode config.model setting
 * 2. User's recent models from TUI state (~/.local/state/opencode/model.json)
 * 3. First connected provider's default model from API
 * Returns the model and its source.
 */
export async function getDefaultModel({
  getClient,
  directory,
}: {
  getClient: Error | AgentCatalogGetter
  directory?: string
}): Promise<
  | { providerID: string; modelID: string; source: DefaultModelSource }
  | undefined
> {
  if (getClient instanceof Error) return undefined

  const configModel = getModelFromProjectConfig({ directory })
  if (configModel) {
    sessionLogger.log(
      `[MODEL] Using project config model: ${configModel.providerID}/${configModel.modelID}`,
    )
    return { ...configModel, source: 'opencode-config' }
  }

  // Fetch connected providers to validate any model we return
  const catalog = await getClient().catalog.providers({ directory })
  if (catalog instanceof Error) {
    sessionLogger.log(
      `[MODEL] Failed to fetch providers for default model:`,
      catalog.message,
    )
    return undefined
  }

  const { connected, defaults, providers } = catalog
  if (connected.length === 0) {
    sessionLogger.log(`[MODEL] No connected providers found`)
    return undefined
  }

  // 1. Check OpenCode config.model setting (highest priority after user preference)
  const configResponse = await getClient().catalog.config({ directory })
  if (!(configResponse instanceof Error) && configResponse.model) {
    const configModel = parseModelId(configResponse.model)
    if (configModel && isModelValid(configModel, connected, providers)) {
      sessionLogger.log(
        `[MODEL] Using config model: ${configModel.providerID}/${configModel.modelID}`,
      )
      return { ...configModel, source: 'opencode-config' }
    }
    if (configModel) {
      sessionLogger.log(
        `[MODEL] Config model ${configResponse.model} not available, checking recent`,
      )
    }
  }

  // 2. Try to use user's recent models from TUI state (iterate until finding valid one)
  const recentModels = getRecentModelsFromTuiState()
  for (const recentModel of recentModels) {
    if (isModelValid(recentModel, connected, providers)) {
      sessionLogger.log(
        `[MODEL] Using recent TUI model: ${recentModel.providerID}/${recentModel.modelID}`,
      )
      return { ...recentModel, source: 'opencode-recent' }
    }
  }
  if (recentModels.length > 0) {
    sessionLogger.log(`[MODEL] No valid recent TUI models found`)
  }

  // 3. Fall back to first connected provider's default model
  const firstConnected = connected[0]
  if (!firstConnected) {
    return undefined
  }
  const defaultModelId = defaults[firstConnected]
  if (!defaultModelId) {
    sessionLogger.log(`[MODEL] No default model for provider ${firstConnected}`)
    return undefined
  }

  sessionLogger.log(
    `[MODEL] Using provider default: ${firstConnected}/${defaultModelId}`,
  )
  return {
    providerID: firstConnected,
    modelID: defaultModelId,
    source: 'opencode-provider-default',
  }
}
