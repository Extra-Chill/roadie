import { test, expect, describe } from 'vitest'
import { sanitizeTaskArguments } from './task-id-plugin.js'

describe('sanitizeTaskArguments', () => {
  test('removes a model-invented UUID task_id', () => {
    const args = {
      description: 'inspect repository',
      prompt: 'Find the implementation',
      subagent_type: 'explore',
      task_id: 'ff120f9f-a28d-4d29-b691-b3a5f770759b',
    }

    sanitizeTaskArguments(args)

    expect(args).toMatchInlineSnapshot(`
      {
        "description": "inspect repository",
        "prompt": "Find the implementation",
        "subagent_type": "explore",
      }
    `)
  })

  test('keeps an OpenCode session task_id for resume', () => {
    const args = { task_id: 'ses_child' }

    sanitizeTaskArguments(args)

    expect(args).toMatchInlineSnapshot(`
      {
        "task_id": "ses_child",
      }
    `)
  })
})
