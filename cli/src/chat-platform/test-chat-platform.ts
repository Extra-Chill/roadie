// In-memory chat platform for tests (#297) and a reference for plugin-supplied
// platforms: a host system that is itself the chat surface implements exactly
// this shape. Ingress reuses the platform-neutral paths the native adapters
// use — conversation intake, the shared thread session runtime and its queue —
// instead of re-implementing them. Thread ids are namespaced
// (`<platform>:<space>:<channel>:<key>`) so shared state never collides with
// other platforms running in the same process.

import { EventEmitter } from 'node:events'
import {
  getChannelDirectory,
  getThreadSession,
  setChannelDirectory,
} from '../database.js'
import {
  applicationDirectory,
  resolveChannelPolicy,
  setChannelParentResolver,
} from '../channel-policy.js'
import {
  disposeRuntime,
  getOrCreateRuntime,
} from '../session-handler/runtime-registry.js'
import type { ThreadSessionRuntime } from '../session-handler/thread-session-runtime.js'
import {
  readConversationAdmission,
  recordConversationAdmission,
  resolveConversationIntake,
} from '../conversation-intake.js'
import { markChatPlatformReady } from '../hrana-server.js'
import type { ChatInteractions, ChatMessage, ChatThread } from './types.js'
import type { ChatPlatformDefinition } from './registry.js'

export type TestChatMessage = {
  id: string
  kind: 'notice' | 'message' | 'part'
  text: string
}

function stubInteractions(): ChatInteractions {
  return {
    permission: async () => ({ messageId: 'test-permission', contextHash: 'test-permission' }),
    addPermissionRequest: () => false,
    clearPermission: () => {},
    question: async () => {},
    actions: async () => {},
    upload: async () => [],
    hasQuestion: () => false,
    hasPending: () => false,
    cancelQuestion: async () => {},
    dispose: () => {},
  }
}

export class TestChatThread implements ChatThread {
  readonly platform: string
  readonly interactions = stubInteractions()
  readonly capabilities = { rename: true, typing: false }
  readonly id: string
  name: string
  readonly parentId: string
  readonly spaceId: string
  readonly createdAt = Date.now()
  readonly botUserId = 'test-bot'
  readonly messages: TestChatMessage[] = []
  readonly events = new EventEmitter()
  private nextMessageId = 1

  constructor(input: { platform: string; threadId: string; channelId: string; spaceId: string }) {
    this.platform = input.platform
    this.id = input.threadId
    this.name = input.threadId
    this.parentId = input.channelId
    this.spaceId = input.spaceId
  }

  private record(kind: TestChatMessage['kind'], text: string): ChatMessage {
    const message = { id: String(this.nextMessageId++), kind, text }
    this.messages.push(message)
    this.events.emit('message', message)
    return { id: message.id }
  }

  async footerMentionUserId(): Promise<string | undefined> {
    return undefined
  }
  async sendNotice(content: string): Promise<Error | ChatMessage> {
    return this.record('notice', content)
  }
  async sendMessage(content: string): Promise<ChatMessage> {
    return this.record('message', content)
  }
  async sendPart(content: string): Promise<ChatMessage> {
    return this.record('part', content)
  }
  async readMessageText(messageId: string): Promise<Error | string> {
    const found = this.messages.find((message) => message.id === messageId)
    return found ? found.text : new Error(`No message ${messageId} in ${this.id}`)
  }
  async editMessageText(messageId: string, content: string): Promise<Error | void> {
    const found = this.messages.find((message) => message.id === messageId)
    if (!found) return new Error(`No message ${messageId} in ${this.id}`)
    found.text = content
  }
  async setPendingMarker(): Promise<Error | void> {}
  async sendTyping(): Promise<Error | void> {}
  async rename(name: string): Promise<void> {
    this.name = name
  }
  async channelTopic(): Promise<string | undefined> {
    return undefined
  }

  /** The thread's messages so far plus new ones, until the predicate matches. */
  async waitForMessage({
    predicate,
    timeout = 10_000,
  }: {
    predicate: (message: TestChatMessage) => boolean
    timeout?: number
  }): Promise<TestChatMessage> {
    const existing = this.messages.find(predicate)
    if (existing) return existing
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.events.off('message', onMessage)
        reject(
          new Error(
            `Timed out waiting for a message in ${this.id}. Got: ${JSON.stringify(this.messages)}`,
          ),
        )
      }, timeout)
      const onMessage = (message: TestChatMessage) => {
        if (!predicate(message)) return
        clearTimeout(timer)
        this.events.off('message', onMessage)
        resolve(message)
      }
      this.events.on('message', onMessage)
    })
  }
}

export type TestChatPlatform = {
  definition: ChatPlatformDefinition
  threads: Map<string, TestChatThread>
  isRunning(): boolean
  /**
   * Platform ingress: a person sent a message. Goes through conversation
   * intake and the shared runtime queue exactly like the native adapters.
   */
  deliverMessage(input: {
    channelId: string
    /** Stable key of the conversation inside the channel. */
    threadKey: string
    text: string
    userId: string
    username?: string
  }): Promise<Error | { threadId: string; thread: TestChatThread; runtime: ThreadSessionRuntime }>
}

export function createTestChatPlatform({
  id = 'test-chat',
  spaceId = 'test-space',
}: { id?: string; spaceId?: string } = {}): TestChatPlatform {
  const threads = new Map<string, TestChatThread>()
  let running = false

  const prefix = `${id}:${spaceId}:`
  const parseThreadId = (threadId: string) =>
    threadId.startsWith(prefix) ? threadId.slice(prefix.length).split(':')[0] : undefined

  const definition: ChatPlatformDefinition = {
    id,
    start: async () => {
      running = true
      // Channel policy walks thread → channel through per-platform resolvers,
      // like the native adapters.
      setChannelParentResolver(parseThreadId, { key: id })
      markChatPlatformReady(id, true)
      return {
        stop: async () => {
          running = false
          markChatPlatformReady(id, false)
          for (const threadId of threads.keys()) disposeRuntime(threadId)
          threads.clear()
        },
      }
    },
  }

  return {
    definition,
    threads,
    isRunning: () => running,
    deliverMessage: async ({ channelId, threadKey, text, userId, username }) => {
      if (!running) return new Error(`Chat platform ${id} is not running`)
      const threadId = `${id}:${spaceId}:${channelId}:${threadKey}`
      const policy = resolveChannelPolicy(channelId)
      if (policy === null)
        return new Error(`Channel ${channelId} is not configured in ROADIE_CHANNELS_CONFIG`)
      const directory = policy?.directory ?? (await getChannelDirectory(channelId))?.directory
      if (!directory) return new Error(`Channel ${channelId} has no project directory`)
      await setChannelDirectory({ channelId, directory, channelType: 'text', guildId: spaceId })

      const actor = { platform: id, id: userId, name: username ?? userId }
      const scope = { platform: id, spaceId, threadId }
      const hasSession = Boolean(await getThreadSession(threadId))
      const admission = await readConversationAdmission(scope)
      const intake = await resolveConversationIntake({
        actor,
        spaceId,
        channelId,
        threadId,
        text,
        eligible: true,
        isNewConversation: !hasSession && !admission,
        createsThread: !hasSession,
        hasSession,
        mentionsBot: false,
        isCommand: false,
        legacyOutcome: 'respond',
      })
      if (intake.outcome === 'ignore') return new Error('Conversation intake ignored the message')
      await recordConversationAdmission({
        scope,
        actor,
        starter: !hasSession && !admission,
        decision: intake,
      })

      let thread = threads.get(threadId)
      if (!thread) {
        thread = new TestChatThread({ platform: id, threadId, channelId, spaceId })
        threads.set(threadId, thread)
      }
      const runtime = getOrCreateRuntime({
        threadId,
        chat: thread,
        projectDirectory: directory,
        sdkDirectory: applicationDirectory() ?? directory,
        channelId,
        sessionId: (await getThreadSession(threadId)) || undefined,
      })
      await runtime.enqueueIncoming({
        prompt: text,
        userId,
        username: username ?? userId,
        actorPlatform: id,
        sourceThreadId: threadId,
        sourceChannelId: channelId,
        mode: 'direct',
        noReply: intake.outcome === 'context',
        contextOnly: intake.outcome === 'context',
      })
      return { threadId, thread, runtime }
    },
  }
}
