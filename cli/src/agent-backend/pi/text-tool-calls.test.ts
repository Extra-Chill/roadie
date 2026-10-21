import { expect, test, vi } from 'vitest'
import { cleanMessageToolCalls, cleanTextToolCalls } from './text-tool-calls.js'
import extension from './roadie-extension.js'

const markup = '<invoke name="roadie_action_buttons"><parameter name="buttons">[]</parameter></invoke>'

test.each(['tool_use', 'end_turn'])('cleans text-only %s replies without mutating history', (rawStopReason) => {
  const message = { role: 'assistant', rawStopReason, content: [{ type: 'text', text: `Ready. ${markup}` }] }
  expect(cleanMessageToolCalls(message, ['roadie_action_buttons']).message.content[0]!.text).toBe('Ready. ')
  expect(message.content[0]!.text).toContain('<invoke')
})

test('wrapped, namespaced, multiple calls, unknown tools, prose and real calls', () => {
  expect(cleanTextToolCalls(`Before <ant:function_calls><ant:invoke name="bash">args</ant:invoke>${markup}</ant:function_calls> after`, ['bash', 'roadie_action_buttons']))
    .toEqual({ text: 'Before  after', toolNames: ['bash', 'roadie_action_buttons'] })
  expect(cleanTextToolCalls('Use bash now', ['bash']).text).toBe('Use bash now')
  expect(cleanTextToolCalls(markup, ['bash']).text).toBe(markup)
  expect(cleanTextToolCalls(markup, ['roadie_action_buttons'], true).text).toBe(markup)
  const message = { role: 'assistant', content: [{ type: 'text', text: markup }, { type: 'toolCall', name: 'bash' }] }
  expect(cleanMessageToolCalls(message, ['roadie_action_buttons']).message).toBe(message)
})

test('extension cleans context and queues one correction per assistant message at turn end', async () => {
  const handlers = new Map<string, (event: any) => Promise<any>>()
  const sendUserMessage = vi.fn()
  extension({ on: (name: string, handler: any) => handlers.set(name, handler), registerTool: vi.fn(), getAllTools: () => [{ name: 'roadie_action_buttons' }], sendUserMessage } as any)
  const message = { role: 'assistant', timestamp: 123, content: [{ type: 'text', text: `Ready. ${markup}` }] }
  const ended = await handlers.get('message_end')!({ message })
  expect(ended.message.content[0].text).toBe('Ready. ')
  expect(sendUserMessage).not.toHaveBeenCalled()
  await handlers.get('turn_end')!({ message: ended.message, outcome: 'completed' })
  await handlers.get('message_end')!({ message })
  await handlers.get('turn_end')!({ message, outcome: 'completed' })
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('roadie_action_buttons'), { deliverAs: 'followUp' })
  const context = await handlers.get('context')!({ messages: [message, { role: 'user', content: markup }] })
  expect(context.messages[0].content[0].text).toBe('Ready. ')
  expect(context.messages[1].content).toBe(markup)
  expect(message.content[0]!.text).toContain('<invoke')
})
