/** Remove textual calls only for known tools; never interpret or execute their arguments. */
export function cleanTextToolCalls(text: string, registeredTools: Iterable<string>, hasToolCall = false): { text: string; toolNames: string[] } {
  if (hasToolCall) return { text, toolNames: [] }
  const registered = new Set(registeredTools)
  const detected = new Set<string>()
  const strip = (source: string) => source.replace(
    /<((?:[\w.-]+:)?invoke)\s+name\s*=\s*(["'])([^"']+)\2\s*>[\s\S]*?<\/\1\s*>/g,
    (markup: string, _tag: string, _quote: string, name: string) => {
      if (!registered.has(name)) return markup
      detected.add(name)
      return ''
    },
  )
  const cleaned = text.replace(/<((?:[\w.-]+:)?function_calls)\s*>([\s\S]*?)<\/\1\s*>/g,
    (wrapper: string, tag: string, body: string) => {
      const cleanedBody = strip(body)
      if (cleanedBody === body) return wrapper
      return cleanedBody.trim() ? `<${tag}>${cleanedBody}</${tag}>` : ''
    })
  return { text: strip(cleaned), toolNames: [...detected] }
}

type Message = { role: string; content?: unknown }
type Block = { type: string; text?: string }

/** Copy-on-write: request context can be cleaned without rewriting the session. */
export function cleanMessageToolCalls<T extends Message>(message: T, registeredTools: Iterable<string>): { message: T; toolNames: string[] } {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return { message, toolNames: [] }
  const content = message.content as Block[]
  if (content.some((part) => part.type === 'toolCall')) return { message, toolNames: [] }
  const names = new Set<string>()
  const tools = [...registeredTools]
  const cleaned = content.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') return part
    const result = cleanTextToolCalls(part.text, tools)
    for (const name of result.toolNames) names.add(name)
    return result.text === part.text ? part : { ...part, text: result.text }
  })
  return { message: names.size ? { ...message, content: cleaned } : message, toolNames: [...names] }
}
