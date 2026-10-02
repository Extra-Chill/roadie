// Discord channel and category management.
// Creates and manages Roadie project channels (text + voice pairs),
// extracts channel metadata from topic tags, and ensures category structure.

import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type TextChannel,
} from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  getChannelDirectory,
  setChannelDirectory,
  findChannelsByDirectory,
  listTrackedTextChannels,
  getGuildCategories,
  setGuildCategoryId,
} from './database.js'
import { getProjectsDir } from './config.js'
import { execAsync } from './worktrees.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.CHANNEL)

type CategoryKind = 'text' | 'audio'

function defaultCategoryName(kind: CategoryKind, botName?: string) {
  const isRoadieBot = botName?.toLowerCase() === 'roadie'
  if (kind === 'audio') {
    return botName && !isRoadieBot ? `Roadie Audio ${botName}` : 'Roadie Audio'
  }
  return botName && !isRoadieBot ? `Roadie ${botName}` : 'Roadie'
}

function defaultRoadieChannelName({ botName }: { botName?: string }) {
  if (!botName) return 'roadie'
  const sanitized = botName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!sanitized || sanitized === 'roadie') return 'roadie'
  return `roadie-${sanitized}`.slice(0, 100)
}

const categoryEnsures = new Map<string, Promise<CategoryChannel>>()

function ensureCategorySerialized({
  key,
  run,
}: {
  key: string
  run: () => Promise<CategoryChannel>
}) {
  const existing = categoryEnsures.get(key)
  if (existing) return existing
  const promise = run().finally(() => {
    if (categoryEnsures.get(key) === promise) {
      categoryEnsures.delete(key)
    }
  })
  categoryEnsures.set(key, promise)
  return promise
}

function isUnknownDiscordChannel(error: unknown) {
  const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
  const status = error instanceof Error ? Reflect.get(error, 'status') : undefined
  return code === 10003 || status === 404
}

function isCategoryChannel(
  channel: GuildBasedChannel | null | undefined,
): channel is CategoryChannel {
  return channel?.type === ChannelType.GuildCategory
}

async function fetchCategoryById(
  guild: Guild,
  categoryId: string,
): Promise<CategoryChannel | null> {
  const cached = guild.channels.cache.get(categoryId)
  if (isCategoryChannel(cached)) return cached
  try {
    const fetched = await guild.channels.fetch(categoryId)
    return isCategoryChannel(fetched) ? fetched : null
  } catch (error) {
    if (isUnknownDiscordChannel(error)) return null
    throw error
  }
}

async function adoptParentFromTrackedChannels({
  guild,
  channelType,
}: {
  guild: Guild
  channelType: 'text' | 'voice'
}): Promise<CategoryChannel | null> {
  const mappings = await findChannelsByDirectory({ channelType })
  const channels = await guild.channels.fetch()
  for (const row of mappings) {
    if (row.guild_id && row.guild_id !== guild.id) continue
    const channel = channels.get(row.channel_id)
    if (!channel?.parentId) continue
    const parent = await fetchCategoryById(guild, channel.parentId)
    if (parent) return parent
  }
  return null
}

async function resolveRoadieCategory({
  guild,
  kind,
  botName,
}: {
  guild: Guild
  kind: CategoryKind
  botName?: string
}) {
  const stored = await getGuildCategories(guild.id)
  const storedId = kind === 'audio' ? stored?.audio_category_id : stored?.category_id
  if (storedId) {
    const existing = await fetchCategoryById(guild, storedId)
    if (existing) return existing
  }

  const adopted = await adoptParentFromTrackedChannels({
    guild,
    channelType: kind === 'audio' ? 'voice' : 'text',
  })
  if (adopted) {
    await setGuildCategoryId({
      guildId: guild.id,
      kind,
      categoryId: adopted.id,
    })
    return adopted
  }

  const created = await guild.channels.create({
    name: defaultCategoryName(kind, botName),
    type: ChannelType.GuildCategory,
  })
  await setGuildCategoryId({
    guildId: guild.id,
    kind,
    categoryId: created.id,
  })
  return created
}

export function ensureRoadieCategory(guild: Guild, botName?: string) {
  return ensureCategorySerialized({
    key: `${guild.id}:text`,
    run: () => resolveRoadieCategory({ guild, kind: 'text', botName }),
  })
}

export function ensureRoadieAudioCategory(guild: Guild, botName?: string) {
  return ensureCategorySerialized({
    key: `${guild.id}:audio`,
    run: () => resolveRoadieCategory({ guild, kind: 'audio', botName }),
  })
}

export async function createProjectChannels({
  guild,
  projectDirectory,
  botName,
  enableVoiceChannels = false,
}: {
  guild: Guild
  projectDirectory: string
  botName?: string
  enableVoiceChannels?: boolean
}): Promise<{
  textChannelId: string
  voiceChannelId: string | null
  channelName: string
}> {
  const baseName = path.basename(projectDirectory)
  const channelName = `${baseName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 100)

  const roadieCategory = await ensureRoadieCategory(guild, botName)

  const textChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: roadieCategory,
    // Channel configuration is stored in SQLite, not in the topic
  })

  await setChannelDirectory({
    channelId: textChannel.id,
    directory: projectDirectory,
    channelType: 'text',
    guildId: guild.id,
  })

  let voiceChannelId: string | null = null

  if (enableVoiceChannels) {
    const roadieAudioCategory = await ensureRoadieAudioCategory(guild, botName)

    const voiceChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: roadieAudioCategory,
    })

    await setChannelDirectory({
      channelId: voiceChannel.id,
      directory: projectDirectory,
      channelType: 'voice',
      guildId: guild.id,
    })

    voiceChannelId = voiceChannel.id
  }

  return {
    textChannelId: textChannel.id,
    voiceChannelId,
    channelName,
  }
}

export type ChannelWithTags = {
  id: string
  name: string
  description: string | null
  roadieDirectory?: string
}

export async function getChannelsWithDescriptions(
  guild: Guild,
): Promise<ChannelWithTags[]> {
  const channels: ChannelWithTags[] = []

  const textChannels = guild.channels.cache.filter(
    (channel): channel is TextChannel => channel.type === ChannelType.GuildText,
  )

  for (const channel of textChannels.values()) {
    const description = channel.topic || null

    // Get channel config from database instead of parsing XML from topic
    const channelConfig = await getChannelDirectory(channel.id)

    channels.push({
      id: channel.id,
      name: channel.name,
      description,
      roadieDirectory: channelConfig?.directory,
    })
  }

  return channels
}

const DEFAULT_GITIGNORE = `node_modules/
dist/
.env
.env.*
!.env.example
.DS_Store
tmp/
*.log
__pycache__/
*.pyc
.venv/
*.egg-info/
`

/** Returns the absolute path to the default roadie project directory. */
export function getDefaultRoadieDirectory(): string {
  return path.join(getProjectsDir(), 'roadie')
}

const DEFAULT_CHANNEL_TOPIC =
  'General channel for misc tasks with Roadie. Not connected to a specific OpenCode project or repository.'

/**
 * Create (or find) the default "roadie" channel for general-purpose tasks.
 * Channel name is "roadie-{botName}" for self-hosted bots, "roadie" for gateway.
 * Directory is ~/.roadie/projects/roadie, git-initialized with a .gitignore.
 *
 * Idempotency: checks the database for an existing channel mapped to the
 * roadie projects directory. Also scans this machine's category for the
 * exact default channel name as a fallback for channels created before
 * DB mapping existed.
 */
export async function createDefaultRoadieChannel({
  guild,
  botName,
  appId,
}: {
  guild: Guild
  botName?: string
  appId: string
}): Promise<{
  textChannel: TextChannel
  textChannelId: string
  channelName: string
  projectDirectory: string
} | null> {
  const projectDirectory = getDefaultRoadieDirectory()

  // Ensure the default roadie project directory exists before any DB mapping
  // restoration or git setup. Custom data dirs may not have <dataDir>/projects
  // created yet, and later writes assume the full path is present.
  if (!fs.existsSync(projectDirectory)) {
    fs.mkdirSync(projectDirectory, { recursive: true })
    logger.log(`Created default roadie directory: ${projectDirectory}`)
  }

  // Hydrate guild channels from API so the cache scan is complete
  try {
    await guild.channels.fetch()
  } catch (error) {
    logger.warn(
      `Could not fetch guild channels for ${guild.name}: ${error instanceof Error ? error.stack : String(error)}`,
    )
  }

  // 1. Check database for existing channel mapped to this directory.
  // Check ALL mappings (not just the first) since the same directory could
  // have stale rows from deleted channels or other guilds.
  const existingMappings = await findChannelsByDirectory({
    directory: projectDirectory,
    channelType: 'text',
  })
  const mappedRow = existingMappings.find((row) => {
    const ch = guild.channels.cache.get(row.channel_id)
    return ch?.type === ChannelType.GuildText
  })
  if (mappedRow) {
    // Backfill guild_id for rows created before this column existed,
    // so the tombstone check works if the channel is deleted later.
    if (mappedRow.guild_id !== guild.id) {
      await setChannelDirectory({
        channelId: mappedRow.channel_id,
        directory: projectDirectory,
        channelType: 'text',
        guildId: guild.id,
      })
    }
    logger.log(`Default roadie channel already exists: ${mappedRow.channel_id}`)
    return null
  }

  // 1b. If a mapping exists for this guild but the channel is gone from Discord,
  // it was previously created and then deleted. Don't recreate it.
  const staleForThisGuild = existingMappings.find(
    (row) => row.guild_id === guild.id,
  )
  if (staleForThisGuild) {
    logger.log(
      `Default roadie channel was previously provisioned for guild ${guild.name} (${guild.id}) as ${staleForThisGuild.channel_id}, but no longer exists. Skipping recreation.`,
    )
    return null
  }

  // 2. Fallback: detect an existing default channel in THIS machine's group.
  // A #roadie channel in another machine's group is ignored.
  const channelName = defaultRoadieChannelName({ botName })
  const roadieCategory = await ensureRoadieCategory(guild, botName)
  const existingByName = guild.channels.cache.find((ch): ch is TextChannel => {
    if (ch.type !== ChannelType.GuildText) {
      return false
    }
    if (ch.parentId !== roadieCategory.id) {
      return false
    }
    return ch.name === channelName
  })
  if (existingByName) {
    logger.log(
      `Found existing default roadie channel by name: ${existingByName.id}. Skipping recreation.`,
    )
    return null
  }

  // Git init — gracefully skip if git is not installed
  const gitDir = path.join(projectDirectory, '.git')
  if (!fs.existsSync(gitDir)) {
    try {
      await execAsync('git init', { cwd: projectDirectory, timeout: 10_000 })
      logger.log(`Initialized git in: ${projectDirectory}`)
    } catch (error) {
      logger.warn(
        `Could not initialize git in ${projectDirectory}: ${error instanceof Error ? error.stack : String(error)}`,
      )
    }
  }

  // Write .gitignore if it doesn't exist
  const gitignorePath = path.join(projectDirectory, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE)
  }

  const textChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: roadieCategory,
    topic: DEFAULT_CHANNEL_TOPIC,
  })

  await setChannelDirectory({
    channelId: textChannel.id,
    directory: projectDirectory,
    channelType: 'text',
    guildId: guild.id,
  })

  logger.log(`Created default roadie channel: #${channelName} (${textChannel.id})`)

  return {
    textChannel,
    textChannelId: textChannel.id,
    channelName,
    projectDirectory,
  }
}
