// OpenCode plugin exposing Roadie's own tools (./roadie-tools.ts):
// roadie_file_upload, roadie_action_buttons, roadie_sleep. Runs inside the
// OpenCode server process, not the bot.
//
// Exported from roadie-opencode-plugin.ts — each export is treated as a separate
// plugin by OpenCode's plugin loader.

import type { Plugin } from '@opencode-ai/plugin'
import type { ToolContext, ToolResult } from '@opencode-ai/plugin/tool'
import { z } from 'zod'
import { setDataDir } from './config.js'
import { setPluginLogFilePath } from './plugin-logger.js'
import { initSentry } from './sentry.js'
import { ROADIE_TOOLS } from './roadie-tools.js'

// Inlined from '@opencode-ai/plugin/tool' because the subpath value import
// fails at runtime in global npm installs (#35). Opencode loads this plugin
// file in its own process and resolves modules from roadie's install dir,
// but the '/tool' subpath export isn't found by opencode's module resolver.
// The type-only imports above are fine (erased at compile time).
//
// NOTE: @opencode-ai/plugin bundles its own zod 4.1.x as a hard dependency
// while goke (used by cli.ts) requires zod 4.3.x. This version skew makes
// the Plugin return type structurally incompatible with our local tool()
// even though runtime behavior is identical. ipcToolsPlugin is cast to
// Plugin via unknown to bypass this purely type-level incompatibility.
function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext,
  ): Promise<ToolResult>
}) {
  return input
}

// @opencode-ai/plugin bundles zod 4.1.x as a hard dep; our code uses 4.3.x
// (required by goke for ~standard.jsonSchema). The Plugin return type is
// structurally incompatible due to _zod.version.minor skew even though
// runtime behavior is identical. `any` bypasses the type-level mismatch —
// opencode's plugin loader doesn't care about the zod version at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ipcToolsPlugin: any = async () => {
  initSentry()

  const dataDir = process.env.ROADIE_DATA_DIR
  if (dataDir) {
    setDataDir(dataDir)
    setPluginLogFilePath(dataDir)
  }

  return {
    tool: Object.fromEntries(ROADIE_TOOLS.map((roadieTool) => [roadieTool.name, tool({
      description: roadieTool.description,
      args: roadieTool.args,
      execute: (args, context) => roadieTool.execute(args, { sessionId: context.sessionID, directory: context.directory }),
    })])),
  }
}

export { ipcToolsPlugin }
