// OpenCode plugin entry point for Roadie Discord bot.
// Each export is treated as a separate plugin by OpenCode's plugin loader.
// CRITICAL: never export utility functions from this file — only plugin
// initializer functions. OpenCode calls every export as a plugin.
//
// Plugins are split into focused modules:
// - ipc-tools-plugin: file upload, action buttons, and session sleep
// - context-awareness-plugin: branch and pwd changes
// - kitty-graphics-plugin: extract Kitty Graphics Protocol images from bash output
// - file-edit-log: record edit/write/apply_patch files per session
// - bash-tool-schema-plugin: add description and hasSideEffect to bash
// - task-id-plugin: drop invalid model-generated task resume IDs
//
// Pi parity (issue #177): the plugins below have Pi equivalents in the Roadie
// Pi extension (src/agent-backend/pi/roadie-extension.ts) or need none:
// - injection guard: ported to the extension's tool_result hook (security
//   feature — `send --injection-guard` patterns must scan on Pi too), with a
//   tool-less judge model call through Pi's own registry.
// - kitty graphics: ported to the extension's tool_result hook (extract images
//   from bash output, strip the escapes); AGENT_GRAPHICS is exported to bash.
// - image optimizer: no port. Pi resizes oversized tool-result images itself
//   (images.autoResize), so there is nothing for Roadie to optimize.
// The two OpenCode-only plugins and why they stay OpenCode-only:
// - cache-drift: watches OpenCode's `experimental.chat.system.transform` hook,
//   which exists because OpenCode caches one system prompt across turns and
//   any plugin mutation silently discards the prompt cache. Pi builds its
//   prompt per run and has no plugin-mutated cached prompt; Roadie's own
//   per-turn system file on Pi changes intentionally (agent prompts, per-turn
//   context), so a drift detector would only flag Roadie's designed behavior.
// - task-id: works around OpenCode's task tool crashing on model-generated
//   invalid resume IDs (anomalyco/opencode#49599). Pi's `task` tool is
//   Roadie's own (registered by the extension) and has no resume-id path at
//   all — unknown extra arguments are never read — so the bug cannot occur.

export { ipcToolsPlugin } from './ipc-tools-plugin.js'
export { contextAwarenessPlugin } from './context-awareness-plugin.js'
export { imageOptimizerPlugin } from './image-optimizer-plugin.js'
export { cacheDriftPlugin } from './cache-drift-plugin.js'
export { kittyGraphicsPlugin } from 'kitty-graphics-agent'
export { injectionGuardInternal as injectionGuard } from 'opencode-injection-guard'
export { fileEditTrackerPlugin } from './file-edit-log.js'
export { bashToolSchemaPlugin } from './bash-tool-schema-plugin.js'
export { taskIdPlugin } from './task-id-plugin.js'
export { titleRequestPlugin } from './title-request-plugin.js'
export { credentialPoolsPlugin } from './credential-pools-plugin.js'
