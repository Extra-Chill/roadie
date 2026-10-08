// Third pool provider for the credential-pools spike: OpenAI-compatible with
// its own base URL (like a z.ai/groq/DeepSeek endpoint), so the spike proves a
// second OpenAI-compatible provider's requests are routed to *its* base URL
// and never to the first provider's.

import { loadSdk, poolFetch } from './pool-fetch.mjs'

const { createOpenAICompatible } = await loadSdk('@ai-sdk/openai-compatible')

export function createRoadiePoolZai(options = {}) {
  return createOpenAICompatible({
    ...options,
    name: options.name || 'roadie-pool-zai',
    baseURL: options.baseURL,
    fetch: poolFetch,
  })
}
