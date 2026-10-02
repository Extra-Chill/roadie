// Vitest global setup: isolate subrouter state for every test run.
//
// OpenCode servers spawned by e2e tests load the @subrouter/opencode plugin and
// inherit VITEST from this process. Subrouter refuses to run under vitest with
// its default home (~/.subrouter) so tests never touch real accounts, and its
// config hook throws "SUBROUTER_HOME must be a temp directory in tests". That
// left the OpenCode server never ready (ServerNotReadyError), so e2e turns
// posted the model banner and then nothing.
//
// Give the whole run one throwaway SUBROUTER_HOME unless the caller set one.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export default function setup() {
  if (process.env.SUBROUTER_HOME) return undefined
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-vitest-subrouter-'))
  process.env.SUBROUTER_HOME = home
  return () => {
    fs.rmSync(home, { recursive: true, force: true })
  }
}
