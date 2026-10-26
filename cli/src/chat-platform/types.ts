// Chat platform seam for the session runtime.
//
// `ChatThread` lists the conversation operations the session runtime performs
// on the thread it answers in, derived from its call sites. Discord is the only
// implementation (`./discord.ts`); a second platform implements this interface
// instead of the runtime importing that platform's SDK.
//
// Keep this list in sync with real call sites. Add an operation only when the
// runtime starts using it. Interactive prompts (permissions, questions, action
// buttons, uploads) are not part of it yet.

/** A message the platform accepted. */
import type { AgentFormRequest, AgentPermissionRequest } from '../agent-backend/events.js'
import type { AskUserQuestionInput } from '../commands/ask-question.js'
import type { ActionButtonOption } from '../commands/action-buttons.js'

export type ChatInteractions = {
  permission(input: { permission: AgentPermissionRequest; directory: string; subtaskLabel?: string }): Promise<{ messageId: string; contextHash: string }>
  addPermissionRequest(input: { contextHash: string; requestId: string }): boolean
  clearPermission(contextHash: string): void
  question(input: { sessionId: string; directory: string; requestId: string; input: AskUserQuestionInput; silent?: boolean }): Promise<void>
  /**
   * An MCP form elicitation (form.asked): the server's message with Accept /
   * Decline / Cancel. Optional: a platform without it gets the form answered
   * cancel, so a server never runs on a form nobody could see.
   */
  form?(input: { sessionId: string; directory: string; requestId: string; request: AgentFormRequest; silent?: boolean }): Promise<void>
  actions(input: { sessionId: string; directory: string; buttons: ActionButtonOption[]; silent?: boolean }): Promise<void>
  upload(input: { sessionId: string; directory: string; prompt: string; maxFiles: number }): Promise<string[]>
  hasQuestion(): boolean
  hasPending(): boolean | Promise<boolean>
  cancelQuestion(): Promise<void>
  dispose(): void
}

export type ChatMessage = { id: string }

/** One message of a thread's history, as `ChatThread.readRecentMessages` reads it. */
export type ChatHistoryMessage = {
  id: string
  author: string
  /** Sent by this bot (agent output, notices) rather than a person. */
  fromBot: boolean
  text: string
}

export type ChatThread = {
  /** Optional native presentation of a backend session title. */
  syncTitle?(title: string): Promise<void | Error>
  /**
   * Conversations that share their container with other traffic (a channel
   * answered inline, without threads) anchor each turn's first reply to the
   * message that started it. The runtime passes that message when a turn
   * starts; the next `sendPart`/`sendMessage` replies to it once.
   */
  setReplyAnchor?(messageId: string | undefined): void
  readonly platform: string
  readonly interactions: ChatInteractions
  readonly capabilities: { rename: boolean; typing: boolean }
  footerMentionUserId(sessionUserId?: string): Promise<string | undefined>
  /** Platform id of the thread (or of the channel, for inline conversations). */
  readonly id: string
  /** Current thread title. */
  readonly name: string
  /** Channel that contains the thread, if any. */
  readonly parentId: string | null
  /** Server or workspace that contains the thread, if any. */
  readonly spaceId: string | null
  /** When the thread was created (epoch ms), if known. */
  readonly createdAt: number | null
  /** The bot's own user id on this platform, once connected. */
  readonly botUserId: string | undefined

  /**
   * Short status line, sent as one message exactly as given and never
   * notifying anyone. Optionally anchored as a reply to an earlier message.
   */
  sendNotice(content: string, options?: { replyTo?: string }): Promise<Error | ChatMessage>
  /** Formatted content (markdown, tables). Long content is split. Silent unless `notify`. */
  sendMessage(content: string, options?: { notify?: boolean }): Promise<ChatMessage>
  /** One rendered session part (assistant text, tool line). Silent unless `notify`. */
  sendPart(
    content: string,
    options?: { leadWithBlankLine?: boolean; notify?: boolean },
  ): Promise<ChatMessage>
  /** Current text of a message in this thread. */
  readMessageText(messageId: string): Promise<Error | string>
  /**
   * The thread's most recent messages, oldest first. Optional: platforms that
   * cannot read a thread's tail cheaply, and inline channel conversations
   * (whose container holds other traffic), omit it.
   */
  readRecentMessages?(limit: number): Promise<Error | ChatHistoryMessage[]>
  /** Replace the text of a message the bot sent in this thread. */
  editMessageText(messageId: string, content: string): Promise<Error | void>
  /**
   * Mark (`on`) or unmark a message in this thread as waiting for the agent's
   * next step boundary. The platform chooses the marker (Discord and Slack
   * use an hourglass reaction).
   */
  setPendingMarker(messageId: string, on: boolean): Promise<Error | void>
  /** Show a typing indicator. */
  sendTyping(): Promise<Error | void>
  /** Change the thread title. Rejects on failure; may be slow when rate limited. */
  rename(name: string): Promise<void>
  /** Topic of the channel holding this thread (`channelId` when the parent is not cached). */
  channelTopic(channelId?: string): Promise<string | undefined>
}
