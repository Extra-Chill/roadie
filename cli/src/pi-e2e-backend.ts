// Pi as the agent backend for an e2e suite: real Pi processes calling the
// scripted fake model server, installed as the default backend over a stub
// OpenCode that records anything reaching it. Callers skip their suite when
// findPi() finds no binary, and start IPC polling themselves once the bot
// client exists (Pi's Roadie tools go through it).

import fs from 'node:fs'
import path from 'node:path'
import { setAgentBackendProvider } from './agent-backend/registry.js'
import type { AgentBackendProvider } from './agent-backend/types.js'
import { PiBackendProvider } from './agent-backend/pi/backend.js'
import { withPiDefault } from './agent-backend/pi/router.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { fakeModelsJson, startFakeModelServer, type FakeMatcher, type FakeModel } from './agent-backend/pi/fake-model-server.js'
import { restartGlobalEventListener } from './session-handler/global-event-listener.js'
import { disposeRuntimesForDirectory } from './session-handler/thread-session-runtime.js'

/**
 * OpenCode stand-in for Pi suites. Pi is the default backend; anything that
 * reaches the old backend is a bug, so it records the call and refuses.
 */
export function untouchableOpencodeFallback(touched: string[] = []): AgentBackendProvider {
  return {
    id: 'opencode',
    getBackend: () => null,
    async initializeForDirectory(directory) {
      touched.push(`initializeForDirectory ${directory}`)
      return new Error('the retired OpenCode backend was started')
    },
    subscribeEvents: async () => new Error('the retired OpenCode backend has no events'),
    onStarted: () => {},
  }
}

export type PiE2eBackend = {
  /** The current provider; replaced by restart(). */
  readonly pi: PiBackendProvider
  modelServer: Awaited<ReturnType<typeof startFakeModelServer>>
  /** Calls that reached the stub OpenCode. A Pi suite expects none. */
  opencodeTouched: string[]
  /**
   * A Roadie restart as the backend sees it: every Pi process is killed and a
   * fresh provider takes over the same session files.
   */
  restart(): Promise<void>
  /**
   * Dispose the project's thread runtimes, restore the previous provider, stop
   * Pi (waiting for it) and close the server.
   */
  stop(): Promise<void>
}

export async function startPiE2eBackend({ root, dataDir, projectDirectory, matchers, models, model = 'fake/fake-1' }: {
  /** Holds the Pi agent dir (models.json). */
  root: string
  /** Holds Pi's session files and the file-edit log. */
  dataDir: string
  /** The suite's project; its thread runtimes are disposed by stop(). */
  projectDirectory: string
  matchers: FakeMatcher[]
  /** The fake provider's models; fake-1 and fake-2 by default. */
  models?: FakeModel[]
  /** Default model, `provider/id`. */
  model?: string
}): Promise<PiE2eBackend> {
  const modelServer = await startFakeModelServer({ matchers })
  const agentDir = path.join(root, 'pi-agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), fakeModelsJson(modelServer.baseUrl, { ...(models && { models }) }))
  const options = {
    bin: findPi()!,
    sessionDir: path.join(dataDir, 'pi-sessions'),
    fileEditLogDir: dataDir,
    model,
    env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' },
  }
  const opencodeTouched: string[] = []
  let pi = new PiBackendProvider(options)
  const install = () => {
    const restore = setAgentBackendProvider(withPiDefault({ fallback: untouchableOpencodeFallback(opencodeTouched), pi }))
    restartGlobalEventListener()
    return restore
  }
  // A restart replaces the provider; this first restore still puts back
  // whatever was installed before the suite.
  const restore = install()
  return {
    get pi() {
      return pi
    },
    modelServer,
    opencodeTouched,
    async restart() {
      await pi.dispose()
      pi = new PiBackendProvider(options)
      install()
    },
    async stop() {
      // A prompt a test left queued would otherwise dispatch after Pi let go
      // of its sessions, and the router would hand it to the stub OpenCode.
      disposeRuntimesForDirectory({ directory: projectDirectory })
      restore()
      // Pi writes its session file until it exits; callers remove dataDir next.
      await pi.dispose()
      await modelServer.close()
    },
  }
}
