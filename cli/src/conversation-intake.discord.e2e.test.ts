import { test } from 'vitest'
import { setupConversationIntakeSuite } from './conversation-intake-e2e-setup.js'
const scenario = setupConversationIntakeSuite('discord')
test(
  'Discord: mention, starter follow-up, context-only, second-person admission, context switch and restart',
  scenario,
  40_000,
)
