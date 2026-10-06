// The session runtime resolves its agent backend through the registry, so an
// injected provider receives the calls instead of OpenCode.

import { afterEach, describe, expect, test } from 'vitest'
import { getAgentBackendProvider, setAgentBackendProvider } from './registry.js'
import { openCodeBackendProvider } from './opencode.js'
import type { AgentBackendProvider } from './types.js'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { toOpenCodeBackend } from './opencode-sessions.js'
import {
  clearModelListCache,
  validateCliModelOption,
} from '../session-handler/model-utils.js'

function fakeProvider(calls: string[]): AgentBackendProvider {
  const backend = toOpenCodeBackend({
    config: {
      providers: async ({ directory }: { directory?: string }) => {
        calls.push(`config.providers:${directory}`)
        return {
          data: {
            providers: [
              {
                id: 'fake',
                name: 'Fake',
                models: { 'model-1': { id: 'model-1', name: 'Model 1' } },
              },
            ],
            default: {},
          },
        }
      },
    },
  } as unknown as OpencodeClient)
  return {
    id: 'fake',
    getBackend: () => backend,
    initializeForDirectory: async (directory) => {
      calls.push(`initialize:${directory}`)
      return () => backend
    },
    subscribeEvents: () => null,
    onStarted: () => {},
  }
}

describe('agent backend registry', () => {
  let restore: (() => void) | undefined

  afterEach(() => {
    restore?.()
    restore = undefined
    clearModelListCache()
  })

  test('defaults to the OpenCode provider', () => {
    expect(getAgentBackendProvider().id).toBe(openCodeBackendProvider.id)
  })

  test('session runtime model validation goes through the injected backend', async () => {
    const calls: string[] = []
    restore = setAgentBackendProvider(fakeProvider(calls))

    const result = await validateCliModelOption({
      model: 'fake/model-1',
      directory: '/tmp/roadie-backend-seam',
    })

    expect(result).toEqual({ providerID: 'fake', modelID: 'model-1' })
    expect(calls).toEqual([
      'initialize:/tmp/roadie-backend-seam',
      'config.providers:/tmp/roadie-backend-seam',
    ])
  })

  test('restore function reinstates the previous provider', () => {
    const undo = setAgentBackendProvider(fakeProvider([]))
    expect(getAgentBackendProvider().id).toBe('fake')
    undo()
    expect(getAgentBackendProvider().id).toBe(openCodeBackendProvider.id)
  })
})
