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
//
// It also runs the suite under a clean Roadie environment (#156). An agent
// tool shell exports the live session's ROADIE_*, OPENCODE_* and Pi PI_*
// variables. Code under test reads them as its defaults, so a suite run from
// that shell tested the live session instead of its fixtures. They are removed
// here, before the worker forks inherit this process's environment. The test
// inputs below are kept: an operator sets them on purpose.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearAmbientRoadieEnv } from './src/test-env.js'

export default function setup() {
  clearAmbientRoadieEnv()
  if (process.env.SUBROUTER_HOME) return undefined
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-vitest-subrouter-'))
  process.env.SUBROUTER_HOME = home
  return () => {
    fs.rmSync(home, { recursive: true, force: true })
  }
}
