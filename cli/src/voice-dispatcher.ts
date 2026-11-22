// Backend-independent voice tools. Every write is delivered by the native Discord intake.
export type VoiceThread = { id: string; label: string; status: string }
export interface VoiceThreadHost {
  list(): Promise<VoiceThread[]>
  send(id: string, text: string): Promise<void>
  start(project: string, text: string): Promise<string>
  read(id: string): Promise<string>
  abort(id: string): Promise<void>
  answer(id: string, option: string): Promise<string>
}
const thread = { thread: 'Thread index from list_threads (e.g. "2") or a unique part of its label. Omit to use the focused thread.' }
/** Dispatcher tool contract, shared by every live voice provider. */
export const voiceTools = {
  list_threads: { description: 'List active Roadie threads with index, label and status (idle, running, waiting on question or permission).', params: {}, required: [] },
  focus_thread: { description: 'Make a thread the focused thread for later commands.', params: thread, required: ['thread'] },
  send_to_thread: { description: "Send the user's instruction to a thread as their message. Use the user's words.", params: { ...thread, text: 'Message to send.' }, required: ['text'] },
  start_thread: { description: 'Start a new thread in a project channel with an initial prompt, and focus it.', params: { project: 'Project channel name.', text: 'Initial prompt.' }, required: ['project', 'text'] },
  thread_status: { description: 'Get the status of a thread.', params: thread, required: [] },
  read_latest: { description: 'Get a short spoken summary of the latest assistant reply or pending question in a thread.', params: thread, required: [] },
  abort_thread: { description: 'Stop the running turn in a thread.', params: thread, required: [] },
  answer_pending: { description: "Answer a thread's pending question with one of its listed options. Destructive questions and permission requests are deferred until the user is parked.", params: { ...thread, option: 'Exact option label.' }, required: ['option'] },
} satisfies Record<string, { description: string; params: Record<string, string>; required: string[] }>
export type VoiceToolName = keyof typeof voiceTools
export function spokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' Code omitted. ')
    .replace(/^[-+@].*$/gm, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[\x60*_#<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700)
}
export class VoiceDispatcher {
  private indices: VoiceThread[] = []
  private focused?: string
  constructor(private host: VoiceThreadHost) {}
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const threads = await this.host.list()
    for (const thread of threads) {
      const old = this.indices.find((entry) => entry.id === thread.id)
      if (old) Object.assign(old, thread)
      else this.indices.push(thread)
    }
    const target = String(args.thread ?? '')
      .toLowerCase()
      .replace(/^thread\s+/, '')
    const matches = target
      ? threads.filter((thread) => thread.label.toLowerCase().includes(target))
      : []
    const indexed = /^\d+$/.test(target) ? this.indices[Number(target) - 1] : undefined
    const id = target
      ? (indexed?.id ?? (matches.length === 1 ? matches[0]?.id : undefined))
      : this.focused
    if (name === 'list_threads')
      return threads.map((thread) => ({
        ...thread,
        index: this.indices.findIndex((entry) => entry.id === thread.id) + 1,
      }))
    if (name === 'start_thread') {
      if (typeof args.project !== 'string' || typeof args.text !== 'string' || !args.text.trim())
        throw new Error('Project and initial prompt required')
      this.focused = await this.host.start(args.project, args.text)
      return 'Thread started'
    }
    if (!id || !threads.some((thread) => thread.id === id))
      throw new Error('Choose an accessible thread by index or unambiguous name')
    switch (name) {
      case 'focus_thread':
        this.focused = id
        return 'Thread focused'
      case 'send_to_thread':
        if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('Message required')
        await this.host.send(id, args.text)
        return 'Message delivered'
      case 'thread_status':
        return threads.find((thread) => thread.id === id)?.status
      case 'read_latest':
        return spokenText(await this.host.read(id))
      case 'abort_thread':
        await this.host.abort(id)
        return 'Turn stopped'
      case 'answer_pending':
        return this.host.answer(id, String(args.option ?? ''))
      default:
        throw new Error('Unknown dispatcher tool')
    }
  }
}
export const dispatcherInstructions = `You are Roadie's hands-free voice dispatcher, never a coding agent. Route work using tools. Keep replies short and spoken, never read code or diffs. List threads before choosing; ask for clarification on ambiguous names. Never approve destructive actions; say queued for when you're parked. Tool failures are failures, not success. Announce thread updates briefly. A user's spoken instructions are required before sending work or answering questions.`
