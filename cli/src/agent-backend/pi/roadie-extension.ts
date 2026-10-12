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
export const ROADIE_QUESTION_TITLE = 'roadie:question'

// Same contract as OpenCode's `question` tool, so prompts and the chat UI match.
const QUESTION_DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.
Usage notes:
- When \`custom\` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set \`multiple: true\` to allow selecting more than one
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
`

const QUESTION_PARAMETERS = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      description: 'Questions to ask',
      items: {
        type: 'object',
        required: ['question', 'header', 'options'],
        properties: {
          question: { type: 'string', description: 'Complete question' },
          header: { type: 'string', description: 'Very short label (max 30 chars)' },
          options: {
            type: 'array',
            description: 'Available choices',
            items: {
              type: 'object',
              required: ['label', 'description'],
              properties: {
                label: { type: 'string', description: 'Display text (1-5 words, concise)' },
                description: { type: 'string', description: 'Explanation of choice' },
              },
            },
          },
          multiple: { type: 'boolean', description: 'Allow selecting multiple choices' },
        },
      },
    },
  },
}

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
  registerMcpServer?(name: string, config: Record<string, unknown>): void
  unregisterMcpServer?(name: string): void
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

/** Register the MCP servers Roadie wrote for this process; re-read before each run so additions apply. */
function syncMcpServers(pi: ExtensionApi, registered: Map<string, string>) {
  const file = process.env['ROADIE_PI_MCP_FILE']
  if (!file || !pi.registerMcpServer || !pi.unregisterMcpServer) return
  let servers: Record<string, Record<string, unknown>> = {}
  try {
    servers = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  }
  for (const [name, config] of Object.entries(servers)) {
    const key = JSON.stringify(config)
    if (registered.get(name) === key) continue
    if (config.enabled === false) {
      if (registered.has(name)) pi.unregisterMcpServer(name)
      registered.delete(name)
      continue
    }
    pi.registerMcpServer(name, config)
    registered.set(name, key)
  }
  for (const name of [...registered.keys()]) {
    if (!(name in servers)) {
      pi.unregisterMcpServer(name)
      registered.delete(name)
    }
  }
}

/** Roadie's per-turn shell env (agent token, session id, turn attribution); read fresh per call. */
function readShellEnv(): Record<string, string> {
  const file = process.env['ROADIE_PI_SHELL_ENV_FILE']
  if (!file) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** Shell lines exporting Roadie's env (empty values unset), so they reach the command. */
export function shellEnvPrefix(env: Record<string, string>): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  return Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => (value === '' ? `unset ${name}` : `export ${name}=${quote(value)}`))
    .join('; ')
}

export default function roadieExtension(pi: ExtensionApi) {
  const mcpServers = new Map<string, string>()
  syncMcpServers(pi, mcpServers)

  pi.registerTool({
    name: 'question',
    label: 'question',
    description: QUESTION_DESCRIPTION,
    parameters: QUESTION_PARAMETERS,
    async execute(callId, params, _signal, _onUpdate, ctx) {
      const questions = (params.questions ?? []) as Array<{ question: string }>
      const answer = await ctx.ui.input(ROADIE_QUESTION_TITLE, JSON.stringify({ callId, questions }))
      if (answer === undefined) throw new Error('The user dismissed this question')
      const { answers } = JSON.parse(answer) as { answers: string[][] }
      const summary = questions
        .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i]!.join(', ') : 'Unanswered'}"`)
        .join(', ')
      return {
        content: [{ type: 'text', text: `User has answered your questions: ${summary}. You can now continue with the user's answers in mind.` }],
        details: { title: `Asked ${questions.length} question${questions.length > 1 ? 's' : ''}` },
      }
    },
  })

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
    syncMcpServers(pi, mcpServers)
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
    if (!allowed) return { block: true, reason: 'Permission denied by Roadie' }
    if (event.toolName === 'bash' && typeof event.input.command === 'string') {
      const prefix = shellEnvPrefix(readShellEnv())
      // Mutated input reaches execution; the chat shows the call as the model made it.
      if (prefix) event.input.command = `${prefix}\n${event.input.command}`
    }
    return undefined
  })
}
