// Locate a runnable `pi` for the e2e suites that drive real Pi processes.
//
// Locally the suites skip when no Pi is installed. CI sets ROADIE_REQUIRE_PI=1
// and installs a pinned Pi, so a missing or broken binary fails the run
// instead of silently skipping the only coverage of the default backend.

import { execFileSync } from 'node:child_process'

export function findPi(): string | undefined {
  const candidates = [process.env['ROADIE_PI_BIN'], 'pi'].filter(Boolean) as string[]
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' })
      return bin
    } catch {}
  }
  if (process.env['ROADIE_REQUIRE_PI'] === '1') {
    throw new Error(`ROADIE_REQUIRE_PI=1 but no runnable pi (tried ${candidates.join(', ')})`)
  }
  return undefined
}
