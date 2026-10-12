// Pi extension loaded into every Roadie-managed Pi process (`pi -e <this file>`).
// Runs inside Pi, not Roadie: no Roadie imports.
//
// - Appends Roadie's per-session system prompt, read from ROADIE_PI_SYSTEM_FILE
//   before each agent run (Roadie rewrites the file before each prompt).
// - Asks Roadie about every tool call through a `confirm` UI request whose
//   title is ROADIE_PERMISSION_TITLE. Roadie evaluates its own permission policy
//   and answers, or forwards the question to the person. A refusal blocks the call.

import fs from 'node:fs'

export const ROADIE_PERMISSION_TITLE = 'roadie:permission'

type ToolCallEvent = { toolName: string; toolCallId: string; input: Record<string, unknown> }
type Context = { cwd: string; ui: { confirm(title: string, message: string): Promise<boolean> } }
type ExtensionApi = {
  on(event: 'before_agent_start', handler: (event: { systemPrompt: string }) => Promise<{ systemPrompt?: string } | undefined>): void
  on(event: 'tool_call', handler: (event: ToolCallEvent, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void
}

export default function roadieExtension(pi: ExtensionApi) {
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
