// /context-usage command - Show token usage and context window percentage for the current session.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { AgentUsage } from '../agent-backend/events.js'
import { getAgentBackendProvider } from '../agent-backend/registry.js'
import { AgentRequestError, type AgentSessionMessage } from '../agent-backend/types.js'
import type { CommandContext } from './types.js'
import { OpenCodeSdkError } from '../errors.js'
import { getThreadSession } from '../database.js'
import { getOpencodeClient } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'


const logger = createLogger(LogPrefix.SESSION)

export function formatContextBreakdown({
  messages,
  lastAssistantId,
  inputTokens,
}: {
  messages: AgentSessionMessage[]
  lastAssistantId: string
  inputTokens: number
}): string | undefined {
  if (inputTokens <= 0) return undefined
  const lastIndex = messages.findIndex(({ message }) => message.id === lastAssistantId)
  if (lastIndex < 0) return undefined
  const history = messages.slice(0, lastIndex)
  const compactIndex = history.findLastIndex(({ parts }) =>
    parts.some((part) => part.kind === 'other' && part.type === 'compaction'),
  )
  const active = history.slice(compactIndex < 0 ? 0 : compactIndex + 1)
  const system = [...active].reverse().find(({ message }) =>
    message.role === 'user' && message.system,
  )
  const systemChars = system?.message.system?.length ?? 0
  const toolChars = new Map<string, number>()
  for (const { message, parts } of active) {
    if (message.role !== 'assistant') continue
    for (const part of parts) {
      if (part.kind !== 'tool') continue
      const output = part.status === 'completed' && part.compactedAt === undefined
        ? part.output ?? ''
        : part.status === 'error' ? part.error ?? '' : ''
      const chars = JSON.stringify(part.input).length + output.length
      toolChars.set(part.tool, (toolChars.get(part.tool) ?? 0) + chars)
    }
  }

  const estimates = [
    { name: 'system', tokens: Math.ceil(systemChars / 4) },
    ...[...toolChars].map(([name, chars]) => ({ name: `tool ${name}`, tokens: Math.ceil(chars / 4) })),
  ].sort((a, b) => b.tokens - a.tokens)
  const estimated = estimates.reduce((total, entry) => total + entry.tokens, 0)
  const scale = estimated > inputTokens ? inputTokens / estimated : 1
  const visible = estimates.slice(0, 5).map((entry) => ({
    name: entry.name,
    tokens: Math.floor(entry.tokens * scale),
  }))
  const other = inputTokens - visible.reduce((total, entry) => total + entry.tokens, 0)
  const format = ({ name, tokens }: { name: string; tokens: number }) =>
    `${name} ${(tokens / inputTokens * 100).toFixed(1)}% (${tokens.toLocaleString('en-US')})`
  return `**Estimated input mix:** ${[...visible.filter((entry) => entry.tokens > 0), { name: 'other', tokens: other }].map(format).join(' · ')} tokens (other includes messages and unexposed prompts)`
}

function getTokenTotal(usage: AgentUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

export async function handleContextUsageCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const serverResult = await getAgentBackendProvider().initializeForDirectory(projectDirectory)
  if (serverResult instanceof Error) {
    await command.reply({
      content: `Failed to get context usage: ${serverResult.message}`,
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const backend = getAgentBackendProvider().getBackend(workingDirectory)
  const client = getOpencodeClient(workingDirectory)
  if (!backend || !client) {
    await command.reply({
      content: 'Failed to get OpenCode client',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    const messagesResult = await backend.sessions.messages({
      sessionId,
      directory: workingDirectory,
    })
    // A rejection read as an empty session before; a transport failure threw.
    if (messagesResult instanceof Error && !(messagesResult instanceof AgentRequestError)) throw messagesResult
    const messages = messagesResult instanceof Error ? [] : messagesResult
    const assistantMessages = messages.filter(
      (m) => m.message.role === 'assistant',
    )

    if (assistantMessages.length === 0) {
      await command.editReply({
        content: 'No assistant messages in this session yet',
      })
      return
    }

    const lastAssistant = [...assistantMessages].reverse().find((m) => {
      return m.message.usage !== undefined && getTokenTotal(m.message.usage) > 0
    })

    if (!lastAssistant?.message.usage) {
      await command.editReply({
        content: 'Token usage not available for this session yet',
      })
      return
    }

    const tokens = lastAssistant.message.usage
    const modelID = lastAssistant.message.model?.modelId ?? ''
    const providerID = lastAssistant.message.model?.providerId
    const totalTokens = getTokenTotal(tokens)
    const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite

    // Sum cost across all assistant messages for accurate session total
    // (AssistantMessage.cost is per-message, not cumulative)
    const totalCost = assistantMessages.reduce((sum, m) => sum + (m.message.cost || 0), 0)

    // Fetch model context limit from provider API
    let contextLimit: number | undefined
    const providersResult = await client.provider.list({ directory: workingDirectory })
      .catch((e) => new OpenCodeSdkError({ operation: 'provider.list', cause: e }))
    if (providersResult instanceof Error) {
      logger.error(
        '[CONTEXT-USAGE] Failed to fetch provider info:',
        providersResult,
      )
    } else {
      const provider = providersResult.data?.all?.find(
        (p) => p.id === providerID,
      )
      const model = provider?.models?.[modelID]
      if (model?.limit?.context) {
        contextLimit = model.limit.context
      }
    }

    const formattedTokens = totalTokens.toLocaleString('en-US')
    const formattedCost = totalCost > 0 ? `$${totalCost.toFixed(4)}` : '$0.00'

    const lines: string[] = []

    if (contextLimit) {
      const percentage = Math.round((totalTokens / contextLimit) * 100)
      const formattedLimit = contextLimit.toLocaleString('en-US')
      lines.push(
        `**Context usage:** ${percentage}%, ${formattedTokens} / ${formattedLimit} tokens`,
      )
    } else {
      lines.push(
        `**Context usage:** ${formattedTokens} tokens (context limit unavailable)`,
      )
    }

    const breakdown = formatContextBreakdown({
      messages,
      lastAssistantId: lastAssistant.message.id,
      inputTokens,
    })
    if (breakdown) lines.push(breakdown)

    if (modelID) {
      lines.push(`**Model:** ${modelID}`)
    }
    if (totalCost > 0) {
      lines.push(`**Session cost:** ${formattedCost}`)
    }

    await command.editReply({ content: lines.join('\n') })
    logger.log(
      `Context usage shown for session ${sessionId}: ${totalTokens} tokens`,
    )
  } catch (error) {
    logger.error('[CONTEXT-USAGE] Error:', error)
    await command.editReply({
      content: `Failed to get context usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
