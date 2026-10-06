// Anthropic-wire pool provider for the credential-pools spike. Same account
// choice as pool-provider.mjs, different wire format, so one session can hand
// off between providers and the spike can check the history survives.

import { loadSdk, poolFetch } from './pool-fetch.mjs'

const { createAnthropic } = await loadSdk('@ai-sdk/anthropic')

export function createRoadiePoolAnthropic(options = {}) {
  return createAnthropic({
    ...options,
    // poolFetch replaces auth per account; the SDK only needs a placeholder.
    apiKey: 'pool-managed',
    baseURL: options.baseURL,
    fetch: poolFetch,
  })
}
