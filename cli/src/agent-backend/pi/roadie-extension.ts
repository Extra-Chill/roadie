// Pi extension loaded into every Roadie-managed Pi process (`pi -e <this file>`).
// Runs inside Pi, not Roadie: no Roadie imports.
//
// - Appends Roadie's per-session system prompt, read from ROADIE_PI_SYSTEM_FILE
//   before each agent run (Roadie rewrites the file before each prompt).
// - Asks Roadie about every tool call through a `confirm` UI request whose
//   title is ROADIE_PERMISSION_TITLE. Roadie evaluates its own permission policy
//   and answers, or forwards the question to the person. A refusal blocks the call.
// - Registers Roadie's own tools (roadie_file_upload, roadie_action_buttons,
//   roadie_sleep) from the schemas in ROADIE_PI_TOOLS_FILE. Each call is sent to
//   Roadie as an `input` UI request titled ROADIE_TOOL_TITLE; Roadie runs the
//   tool in the bot process and answers with the JSON result.

import fs from 'node:fs'

export const ROADIE_PERMISSION_TITLE = 'roadie:permission'
export const ROADIE_TOOL_TITLE = 'roadie:tool'

type ToolCallEvent = { toolName: string; toolCallId: string; input: Record<string, unknown> }
type Context = {
  cwd: string
  ui: {
    confirm(title: string, message: string): Promise<boolean>
    input(title: string, placeholder?: string): Promise<string | undefined>
  }
}
type ToolSchema = { name: string; description: string; parameters: Record<string, unknown> }
type ToolOutput = { content: Array<{ type: 'text'; text: string }>; details: { title?: string } }
type ExtensionApi = {
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    execute(callId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Context): Promise<ToolOutput>
  }): void
  on(event: 'before_agent_start', handler: (event: { systemPrompt: string }) => Promise<{ systemPrompt?: string } | undefined>): void
  on(event: 'tool_call', handler: (event: ToolCallEvent, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void
}

function readToolSchemas(): ToolSchema[] {
  const file = process.env['ROADIE_PI_TOOLS_FILE']
  if (!file) return []
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ToolSchema[]
  } catch {
    return []
  }
}

export default function roadieExtension(pi: ExtensionApi) {
  for (const schema of readToolSchemas()) {
    pi.registerTool({
      name: schema.name,
      label: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      async execute(callId, params, _signal, _onUpdate, ctx) {
        const answer = await ctx.ui.input(ROADIE_TOOL_TITLE, JSON.stringify({ tool: schema.name, callId, args: params }))
        if (answer === undefined) throw new Error(`${schema.name} was cancelled`)
        const result = JSON.parse(answer) as { output?: string; title?: string; error?: string }
        if (result.error) throw new Error(result.error)
        return { content: [{ type: 'text', text: result.output ?? '' }], details: { ...(result.title && { title: result.title }) } }
      },
    })
  }

  pi.on('before_agent_start', async (event) => {
    const file = process.env['ROADIE_PI_SYSTEM_FILE']
    if (!file) return undefined
    let roadie = ''
    try {
      roadie = fs.readFileSync(file, 'utf8').trim()
    } catch {
      return undefined
    }
    return roadie ? { systemPrompt: `${event.systemPrompt}\n\n${roadie}` } : undefined
  })

  pi.on('tool_call', async (event, ctx) => {
    const allowed = await ctx.ui.confirm(
      ROADIE_PERMISSION_TITLE,
      JSON.stringify({ tool: event.toolName, callId: event.toolCallId, input: event.input, cwd: ctx.cwd }),
    )
    return allowed ? undefined : { block: true, reason: 'Permission denied by Roadie' }
  })
}
