// OpenAI-wire pool provider for the credential-pools spike.
//
// OpenCode loads this through `provider.<id>.npm` (file:// URL) and calls the
// first export whose name starts with `create`. Account choice happens in
// poolFetch (pool-fetch.mjs).

import { loadSdk, poolFetch } from './pool-fetch.mjs'

const { createOpenAICompatible } = await loadSdk('@ai-sdk/openai-compatible')

export function createRoadiePool(options = {}) {
  return createOpenAICompatible({
    ...options,
    name: options.name || 'roadie-pool',
    baseURL: options.baseURL,
    fetch: poolFetch,
  })
}
