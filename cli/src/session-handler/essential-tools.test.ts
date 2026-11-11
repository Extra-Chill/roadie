import { expect, test } from 'vitest'
import { isEssentialToolPart } from './essential-tools.js'
import type { AgentPart } from '../agent-backend/events.js'

test.each(['bash', 'read', 'custom_tool'])('visibility of %s depends on the tool name', (tool) => {
  const part: AgentPart = {
    id: 'part', sessionId: 'session', messageId: 'message', kind: 'tool',
    callId: 'call', tool, status: 'completed', input: { command: 'pwd' },
  }
  expect(isEssentialToolPart(part)).toBe(tool !== 'read')
})
