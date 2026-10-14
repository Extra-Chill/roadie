import { test } from 'vitest'
import { findPi } from './agent-backend/pi/find-pi.js'
import { setupConversationIntakeSuite } from './conversation-intake-e2e-setup.js'
const scenario = setupConversationIntakeSuite('slack')
test.skipIf(!findPi())(
  'Slack: mention, starter follow-up, context-only, second-person admission, context switch and restart',
  scenario,
  40_000,
)
