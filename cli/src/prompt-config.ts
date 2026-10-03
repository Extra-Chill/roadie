// Host configuration for Roadie's system prompt.
//
// Roadie's built-in guidance is a list of named sections (see
// getOpencodeSystemMessage). A host can trim, replace or extend it with a
// file (ROADIE_PROMPT_CONFIG or --prompt-config), YAML or JSON:
//
//   disable: [permissions, upgrading]        # drop built-in sections by id
//   replace:                                  # swap a section's text
//     debugging: |
//       ## debugging
//       Report issues to the platform team.
//   append:                                   # add host sections at the end
//     - id: house-rules
//       content: |
//         ## house rules
//         Never deploy on Fridays.
//       file: /etc/roadie/extra.md            # or read content from a file
//
// Section ids are stable: discord-output, bash-tool, permissions, upgrading,
// debugging, file-upload, file-request, sleep, archive, abort, title,
// mentions, send, scheduled-sends, cwd, reading-sessions, cross-project,
// waiting, submodules, markdown, callouts, urls, diagrams, questions,
// channel-topic. The scheduled-task section is part of `sleep`'s text when
// present. Unknown ids in disable/replace are reported and ignored.
//
// The file is re-read when its mtime changes. An invalid file is reported and
// the built-in prompt is used unchanged.

import fs from 'node:fs'
import YAML from 'yaml'
import { z } from 'zod'
import { getRoadieEnv } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.OPENCODE)

export const BUILTIN_PROMPT_SECTION_IDS = [
  'discord-output',
  'bash-tool',
  'permissions',
  'upgrading',
  'debugging',
  'file-upload',
  'file-request',
  'sleep',
  'archive',
  'abort',
  'title',
  'mentions',
  'send',
  'scheduled-sends',
  'cwd',
  'reading-sessions',
  'cross-project',
  'waiting',
  'submodules',
  'markdown',
  'callouts',
  'urls',
  'diagrams',
  'questions',
  'channel-topic',
] as const

const appendSchema = z
  .object({
    id: z.string().min(1).max(100),
    content: z.string().optional(),
    file: z.string().min(1).optional(),
  })
  .strict()
  .refine((a) => Boolean(a.content) !== Boolean(a.file), {
    message: 'set exactly one of content or file',
  })

const promptConfigSchema = z
  .object({
    disable: z.array(z.string().min(1)).optional(),
    replace: z.record(z.string().min(1), z.string()).optional(),
    append: z.array(appendSchema).optional(),
  })
  .strict()

export type PromptConfig = z.infer<typeof promptConfigSchema>
export type PromptSection = { id: string; text: string }

let configPathOverride: string | null | undefined
let cached: { path: string; mtimeMs: number; config: PromptConfig | null } | undefined

/** Set or clear the config path (CLI flag, tests). `undefined` = use env. */
export function setPromptConfigPath(path: string | null | undefined) {
  configPathOverride = path
  cached = undefined
}

export function getPromptConfigPath(): string | undefined {
  if (configPathOverride !== undefined) return configPathOverride ?? undefined
  return getRoadieEnv('ROADIE_PROMPT_CONFIG')?.trim() || undefined
}

export function parsePromptConfig(text: string): PromptConfig | Error {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (e) {
    return new Error(`invalid YAML/JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const parsed = promptConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return new Error(`${issue?.path.join('.') || 'config'}: ${issue?.message || 'invalid'}`)
  }
  const known = new Set<string>(BUILTIN_PROMPT_SECTION_IDS)
  for (const id of [...(parsed.data.disable ?? []), ...Object.keys(parsed.data.replace ?? {})]) {
    if (!known.has(id)) logger.warn(`[PROMPT CONFIG] unknown section id "${id}" ignored`)
  }
  return parsed.data
}

/** Current host prompt config, or null when none is configured or valid. */
export function getPromptConfig(): PromptConfig | null {
  const path = getPromptConfigPath()
  if (!path) return null
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(path).mtimeMs
  } catch {
    if (!cached || cached.path !== path) {
      logger.error(`[PROMPT CONFIG] cannot read ${path}; using the built-in prompt`)
      cached = { path, mtimeMs: -1, config: null }
    }
    return null
  }
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.config
  const result = parsePromptConfig(fs.readFileSync(path, 'utf8'))
  if (result instanceof Error) {
    logger.error(`[PROMPT CONFIG] ${path} is invalid (${result.message}); using the built-in prompt`)
    cached = { path, mtimeMs, config: null }
    return null
  }
  cached = { path, mtimeMs, config: result }
  return result
}

function readAppendContent(entry: NonNullable<PromptConfig['append']>[number]): string | null {
  if (entry.content !== undefined) return entry.content
  try {
    return fs.readFileSync(entry.file!, 'utf8')
  } catch {
    logger.warn(`[PROMPT CONFIG] cannot read ${entry.file} for section "${entry.id}"; skipped`)
    return null
  }
}

/**
 * Render the system prompt from its intro and sections, applying host
 * config. With no config the result is the concatenation of every section,
 * byte-for-byte the built-in prompt.
 */
export function applyPromptConfig({
  intro,
  sections,
  config,
}: {
  intro: string
  sections: PromptSection[]
  config: PromptConfig | null
}): string {
  if (!config) return intro + sections.map((s) => s.text).join('')
  const disabled = new Set(config.disable ?? [])
  const replace = config.replace ?? {}
  const rendered = sections
    .filter((section) => !disabled.has(section.id))
    .map((section) => {
      const replacement = replace[section.id]
      return replacement === undefined ? section.text : `\n${replacement.trim()}\n`
    })
  const appended = (config.append ?? [])
    .map((entry) => {
      const content = readAppendContent(entry)
      return content === null ? '' : `\n${content.trim()}\n`
    })
    .filter(Boolean)
  return intro + [...rendered, ...appended].join('')
}
