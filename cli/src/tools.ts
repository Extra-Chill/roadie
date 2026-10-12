// Voice assistant tool definitions for the GenAI worker.
// Provides tools for managing OpenCode sessions (create, submit, abort),
// listing chats, searching files, and reading session messages.

import { tool } from './ai-tool.js'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import {
  type OpencodeClient,
  type AssistantMessage,
  type Provider,
} from '@opencode-ai/sdk/v2'
import { createLogger, LogPrefix } from './logger.js'
import * as errore from 'errore'

const toolsLogger = createLogger(LogPrefix.TOOLS)

import { ShareMarkdown } from './markdown.js'
import { formatDistanceToNow } from './utils.js'
import { getAgentBackendProvider } from './agent-backend/registry.js'
import { AgentRequestError, type AgentModelSelection } from './agent-backend/types.js'

/** The SDK used to throw on transport failure and hand back no data on a rejection. */
function throwUnlessRejected<T>(result: T | Error): T | undefined {
  if (result instanceof AgentRequestError) return undefined
  if (result instanceof Error) throw result
  return result
}
import pc from 'picocolors'
import {
  initializeOpencodeForDirectory,
  getOpencodeSystemMessage,
} from './discord-bot.js'

export async function getTools({
  onMessageCompleted,
  directory,
}: {
  directory: string
  onMessageCompleted?: (params: {
    sessionId: string
    messageId: string
    data?: { info: AssistantMessage }
    error?: unknown
    markdown?: string
  }) => void
}) {
  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) {
    throw new Error(getClient.message)
  }
  const client = getClient()
  const backend = getAgentBackendProvider().getBackend(directory)
  if (!backend) {
    throw new Error('Agent backend is unavailable')
  }

  const markdownRenderer = new ShareMarkdown(backend)

  const providersResponse = await client.config.providers()
  const providers: Provider[] = providersResponse.data?.providers || []

  // Helper: get last assistant model for a session (non-summary)
  const getSessionModel = async (
    sessionId: string,
  ): Promise<AgentModelSelection | undefined> => {
    const data = throwUnlessRejected(await backend.sessions.messages({ sessionId, directory }))
    if (!data || data.length === 0) return undefined
    for (let i = data.length - 1; i >= 0; i--) {
      const info = data[i]?.message
      if (info?.role === 'assistant') {
        if (!info.summary && info.model?.providerId && info.model.modelId) {
          return { providerId: info.model.providerId, modelId: info.model.modelId }
        }
      }
    }
    return undefined
  }

  // Fire-and-forget prompt. As before, a rejected prompt still renders the
  // reply (there is none yet); only a transport failure reports an error.
  const promptThenReport = (sessionId: string, prompt: Promise<void | Error>) => {
    prompt
      .then(async (result) => {
        if (result instanceof Error && !(result instanceof AgentRequestError)) throw result
        const markdownResult = await markdownRenderer.generate({
          sessionID: sessionId,
          lastAssistantOnly: true,
        })
        onMessageCompleted?.({
          sessionId,
          messageId: '',
          markdown: errore.unwrapOr(markdownResult, ''),
        })
      })
      .catch((error) => {
        onMessageCompleted?.({
          sessionId,
          messageId: '',
          error,
        })
      })
  }

  const tools = {
    submitMessage: tool({
      description:
        'Submit a message to an existing chat session. Does not wait for the message to complete',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to send message to'),
        message: z.string().describe('The message text to send'),
      }),
      execute: async ({ sessionId, message }) => {
        const sessionModel = await getSessionModel(sessionId)

        // do not await
        promptThenReport(sessionId, backend.sessions.prompt({
          sessionId,
          directory,
          parts: [{ kind: 'text', text: message }],
          ...(sessionModel && { model: sessionModel }),
          system: getOpencodeSystemMessage({ sessionId }),
        }))
        return {
          success: true,
          sessionId,
          directive: 'Tell user that message has been sent successfully',
        }
      },
    }),

    createNewChat: tool({
      description:
        'Start a new chat session with an initial message. Does not wait for the message to complete',
      inputSchema: z.object({
        message: z
          .string()
          .describe('The initial message to start the chat with'),
        title: z.string().optional().describe('Optional title for the session'),
        model: z
          .object({
            providerId: z
              .string()
              .describe('The provider ID (e.g., "anthropic", "openai")'),
            modelId: z
              .string()
              .describe(
                'The model ID (e.g., "claude-opus-4-20250514", "gpt-5")',
              ),
          })
          .optional()
          .describe('Optional model to use for this session'),
      }),
      execute: async ({ message, title }) => {
        if (!message.trim()) {
          throw new Error(`message must be a non empty string`)
        }

        try {
          const session = await backend.sessions.create({
            directory,
            ...(title ? { title } : {}),
          })

          if (session instanceof AgentRequestError) {
            throw new Error('Failed to create session')
          }
          if (session instanceof Error) throw session

          // do not await
          promptThenReport(session.id, backend.sessions.prompt({
            sessionId: session.id,
            directory,
            parts: [{ kind: 'text', text: message }],
            system: getOpencodeSystemMessage({ sessionId: session.id }),
          }))

          return {
            success: true,
            sessionId: session.id,
            title: session.title,
          }
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to create chat session',
          }
        }
      },
    }),

    listChats: tool({
      description:
        'Get a list of available chat sessions sorted by most recent',
      inputSchema: z.object({}),
      execute: async () => {
        toolsLogger.log(`Listing opencode sessions`)
        const sessions = await backend.sessions.list({})

        if (sessions instanceof Error) {
          return { success: false, error: 'No sessions found' }
        }

        const sortedSessions = [...sessions]
          .sort((a, b) => {
            return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
          })
          .slice(0, 20)

        const sessionList = sortedSessions.map(async (session) => {
          const finishedAt = session.updatedAt ?? 0
          const status = await (async () => {
            if (session.reverted) return 'error'
            const messages = await backend.sessions.messages({
              sessionId: session.id,
              directory,
            })
            const lastMessage = messages instanceof Error ? undefined : messages[messages.length - 1]
            if (
              lastMessage?.message.role === 'assistant' &&
              !lastMessage.message.completedAt
            ) {
              return 'in_progress'
            }
            return 'finished'
          })()

          return {
            id: session.id,
            folder: session.directory,
            status,
            finishedAt: formatDistanceToNow(new Date(finishedAt)),
            title: session.title,
            prompt: session.title,
          }
        })

        const resolvedList = await Promise.all(sessionList)

        return {
          success: true,
          sessions: resolvedList,
        }
      },
    }),

    searchFiles: tool({
      description: 'Search for files in a folder',
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe(
            'The folder path to search in, optional. only use if user specifically asks for it',
          ),
        query: z.string().describe('The search query for files'),
      }),
      execute: async ({ folder, query }) => {
        const results = await getClient().find.files({
          query,
          directory: folder,
        })

        return {
          success: true,
          files: results.data || [],
        }
      },
    }),

    readSessionMessages: tool({
      description: 'Read messages from a chat session',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to read messages from'),
        lastAssistantOnly: z
          .boolean()
          .optional()
          .describe('Only read the last assistant message'),
      }),
      execute: async ({ sessionId, lastAssistantOnly = false }) => {
        if (lastAssistantOnly) {
          const messages = throwUnlessRejected(await backend.sessions.messages({
            sessionId,
            directory,
          }))

          if (!messages) {
            return { success: false, error: 'No messages found' }
          }

          const assistantMessages = messages.filter(
            (m) => m.message.role === 'assistant',
          )

          if (assistantMessages.length === 0) {
            return {
              success: false,
              error: 'No assistant messages found',
            }
          }

          const lastMessage = assistantMessages[assistantMessages.length - 1]
          const status = lastMessage!.message.completedAt
            ? 'completed'
            : 'in_progress'

          const markdownResult = await markdownRenderer.generate({
            sessionID: sessionId,
            lastAssistantOnly: true,
          })
          if (markdownResult instanceof Error) {
            throw new Error(markdownResult.message)
          }

          return {
            success: true,
            markdown: markdownResult,
            status,
          }
        } else {
          const markdownResult = await markdownRenderer.generate({
            sessionID: sessionId,
          })
          if (markdownResult instanceof Error) {
            throw new Error(markdownResult.message)
          }

          const messages = throwUnlessRejected(await backend.sessions.messages({
            sessionId,
            directory,
          }))
          const lastMessage = messages?.[messages.length - 1]
          const status =
            lastMessage?.message.role === 'assistant' &&
            !lastMessage.message.completedAt
              ? 'in_progress'
              : 'completed'

          return {
            success: true,
            markdown: markdownResult,
            status,
          }
        }
      },
    }),

    abortChat: tool({
      description: 'Abort/stop an in-progress chat session',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to abort'),
      }),
      execute: async ({ sessionId }) => {
        try {
          toolsLogger.log(
            `[ABORT] reason=voice-tool sessionId=${sessionId} - user requested abort via voice assistant tool`,
          )
          const result = await backend.sessions.abort({ sessionId })
          if (result instanceof Error && !(result instanceof AgentRequestError)) throw result

          if (result instanceof Error) {
            return {
              success: false,
              error: 'Failed to abort session',
            }
          }

          return {
            success: true,
            sessionId,
            message: 'Session aborted successfully',
          }
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : 'Unknown error occurred',
          }
        }
      },
    }),

    getModels: tool({
      description: 'Get all available AI models from all providers',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const providersResponse = await getClient().config.providers()
          const providers: Provider[] = providersResponse.data?.providers || []

          const models: Array<{ providerId: string; modelId: string }> = []

          providers.forEach((provider) => {
            if (provider.models && typeof provider.models === 'object') {
              Object.entries(provider.models).forEach(([modelId, model]) => {
                models.push({
                  providerId: provider.id,
                  modelId: modelId,
                })
              })
            }
          })

          return {
            success: true,
            models,
            totalCount: models.length,
          }
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : 'Failed to fetch models',
            models: [],
          }
        }
      },
    }),
  }

  return {
    tools,
    providers,
  }
}
