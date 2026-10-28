// Root gate invocations need the CLI's environment isolation and bounded workers,
// while still discovering tests in every workspace package.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import cliConfig from './cli/vitest.config.js'

export default defineConfig({
  ...cliConfig,
  test: {
    ...cliConfig.test,
    globalSetup: [fileURLToPath(new URL('./cli/vitest.global-setup.ts', import.meta.url))],
  },
})
