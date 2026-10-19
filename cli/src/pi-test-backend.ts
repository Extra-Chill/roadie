// Pi backend for e2e suites: real `pi` processes driven by the scripted fake
// model server (agent-backend/pi/fake-model-server.ts), installed as the
// session runtime's agent backend. Suites skip when findPi() finds no binary;
// CI sets ROADIE_REQUIRE_PI=1 so a missing Pi fails instead.

import fs from 'node:fs'
import path from 'node:path'
import { setAgentBackendProvider } from './agent-backend/registry.js'
import { PiBackendProvider, type PiBackendOptions } from './agent-backend/pi/backend.js'
import { findPi } from './agent-backend/pi/find-pi.js'
import { fakeModelsJson, startFakeModelServer, type FakeMatcher, type FakeModel } from './agent-backend/pi/fake-model-server.js'
import { restartGlobalEventListener } from './session-handler/global-event-listener.js'
import { disposeRuntimesForDirectory } from './session-handler/runtime-registry.js'

export type PiTestBackend = {
  /** The installed Pi provider; replaced by `restart()`. */
  readonly pi: PiBackendProvider
  modelServer: Awaited<ReturnType<typeof startFakeModelServer>>
  /** Pi's agent dir (models.json for the fake provider). */
  agentDir: string
  /**
   * A Roadie restart as the backend sees it: kills every Pi process and
   * installs a fresh provider over the same session directory, so sessions
   * resume from their files.
   */
  restart(): Promise<void>
  /**
   * Disposes the project's thread runtimes (when given), restores the previous
   * provider, stops Pi and the model server.
   */
  dispose(): Promise<void>
}

/**
 * Starts the fake model server and installs a Pi provider using it (default
 * model `fake/fake-1`). Sessions live under `dataDir/pi-sessions`.
 */
export async function startPiTestBackend({
  root,
  dataDir,
  projectDirectory,
  matchers = [],
  models,
  model = 'fake/fake-1',
  options,
}: {
  /** Directory for Pi's agent dir. */
  root: string
  dataDir: string
  /** The suite's project; its thread runtimes are disposed by dispose(). */
  projectDirectory?: string
  matchers?: FakeMatcher[]
  /** The fake provider's models; fake-1 and fake-2 by default. */
  models?: FakeModel[]
  /** Default model, `provider/id`. */
  model?: string
  /** Extra Pi backend options (e.g. isolateShells). */
  options?: Partial<PiBackendOptions>
}): Promise<PiTestBackend> {
  const bin = findPi()
  if (!bin) throw new Error('startPiTestBackend needs a pi binary; skip the suite with findPi()')
  const modelServer = await startFakeModelServer({ matchers })
  const agentDir = path.join(root, 'pi-agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), fakeModelsJson(modelServer.baseUrl, { ...(models && { models }) }))
  const piOptions: PiBackendOptions = {
    bin,
    sessionDir: path.join(dataDir, 'pi-sessions'),
    fileEditLogDir: dataDir,
    model,
    ...options,
    env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', ...options?.env },
  }
  let pi = new PiBackendProvider(piOptions)
  const install = () => setAgentBackendProvider(pi)
  const restore = install()
  restartGlobalEventListener()
  return {
    get pi() {
      return pi
    },
    modelServer,
    agentDir,
    async restart() {
      await pi.dispose()
      pi = new PiBackendProvider(piOptions)
      // Replaces the provider; `dispose` still restores what was there before.
      install()
      restartGlobalEventListener()
    },
    async dispose() {
      // A prompt a test left queued would otherwise dispatch after Pi let go
      // of its sessions.
      if (projectDirectory) disposeRuntimesForDirectory({ directory: projectDirectory })
      restore()
      // Pi writes its session file until it exits; callers remove dirs next.
      await pi.dispose()
      await modelServer.close()
    },
  }
}
