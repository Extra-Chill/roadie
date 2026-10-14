// A clean Roadie environment for the test suite (#156). An agent tool shell
// exports the live session's ROADIE_*, OPENCODE_* and Pi PI_* variables, which
// code under test reads as its defaults. vitest.global-setup.ts removes them
// before the worker forks inherit its environment. Operator-set test inputs stay.

const TEST_INPUTS = new Set(['ROADIE_REQUIRE_PI', 'ROADIE_PI_BIN', 'ROADIE_VITEST', 'ROADIE_POOL_URL'])
const isTestInput = (name: string) => TEST_INPUTS.has(name) || name.startsWith('ROADIE_PI_REAL_')

export function clearAmbientRoadieEnv(env: NodeJS.ProcessEnv = process.env) {
  for (const name of Object.keys(env)) {
    if (isTestInput(name)) continue
    if (name === 'ROADIE' || /^(ROADIE|OPENCODE|PI)_/.test(name)) delete env[name]
  }
}
