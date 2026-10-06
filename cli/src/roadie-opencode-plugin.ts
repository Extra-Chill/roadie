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
