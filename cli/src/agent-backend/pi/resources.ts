// Project commands and skills for Pi sessions (#51).
//
// Pi discovers its own resources (`.pi/prompts`, `.pi/skills`, `.agents/skills`,
// and the user-level equivalents). Roadie adds the OpenCode-format ones so
// projects keep their commands when a channel moves to Pi:
// - command directories (`.opencode/command[s]`, ~/.config/opencode/command[s])
//   as prompt templates: same markdown, same `$ARGUMENTS`;
// - skill directories (`.opencode/skill[s]`, `.claude/skills`, and the
//   user-level ones) as skills;
// - `command` entries in the project's `opencode.json`, written out as templates.
// Not carried over: OpenCode's `!`cmd`` shell and `@file` expansions in templates.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSkillAllowed } from '../../skill-filter.js'

function existingDirs(dirs: string[]): string[] {
  return dirs.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

type OpenCodeConfigCommand = { template?: string; description?: string }

function configCommands(directory: string): Record<string, OpenCodeConfigCommand> {
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(directory, name)
    if (!fs.existsSync(file)) continue
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { command?: Record<string, OpenCodeConfigCommand> }
      return config.command ?? {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Write `opencode.json` commands as Pi templates under `cacheDir`; returns the directory, if any. */
function writeConfigCommands({ directory, cacheDir }: { directory: string; cacheDir: string }): string | undefined {
  const commands = Object.entries(configCommands(directory)).filter(([name, c]) => /^[\w-]+$/.test(name) && typeof c.template === 'string')
  if (commands.length === 0) return undefined
  const dir = path.join(cacheDir, `opencode-commands-${crypto.createHash('sha256').update(directory).digest('hex').slice(0, 12)}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, command] of commands) {
    const front = command.description ? `---\ndescription: ${JSON.stringify(command.description)}\n---\n` : ''
    fs.writeFileSync(path.join(dir, `${name}.md`), `${front}${command.template}\n`)
  }
  return dir
}

/** A skill's name as pi and the model see it: the SKILL.md frontmatter name, else the directory's. */
function skillName(dir: string): string {
  try {
    const frontmatter = /^---\r?\n(.*?)\r?\n---/s.exec(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))?.[1]
    const name = /^name:\s*(.+)$/m.exec(frontmatter ?? '')?.[1]?.trim()
    return name || path.basename(dir)
  } catch {
    return path.basename(dir)
  }
}

/**
 * The skill directories to pass to pi. Without --enable-skill / --disable-skill
 * they pass through unchanged. With the flags (skill-filter.ts), each directory
 * is expanded into its individual skills so a disabled skill is never passed:
 * pi loads only the survivors, and pi's own discovery of these OpenCode-format
 * locations is bypassed because the whole directory is replaced.
 */
function allowedSkillDirs(dirs: string[], enabledSkills: string[], disabledSkills: string[]): string[] {
  if (enabledSkills.length === 0 && disabledSkills.length === 0) return dirs
  return dirs.flatMap((dir) => {
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    return children
      .filter((child) => child.isDirectory())
      .flatMap((child) => {
        const skillDir = path.join(dir, child.name)
        return isSkillAllowed({ name: skillName(skillDir), enabledSkills, disabledSkills }) ? [skillDir] : []
      })
  })
}

/** Extra `pi` arguments adding OpenCode-format commands and skills for a session directory. */
export function openCodeResourceArgs({
  directory,
  cacheDir,
  home = os.homedir(),
  enabledSkills = [],
  disabledSkills = [],
}: {
  directory: string
  cacheDir: string
  home?: string
  /** --enable-skill whitelist (skill-filter.ts); empty means unfiltered. */
  enabledSkills?: string[]
  /** --disable-skill blacklist (skill-filter.ts); empty means unfiltered. */
  disabledSkills?: string[]
}): string[] {
  const templates = existingDirs([
    path.join(directory, '.opencode', 'command'),
    path.join(directory, '.opencode', 'commands'),
    path.join(home, '.config', 'opencode', 'command'),
    path.join(home, '.config', 'opencode', 'commands'),
  ])
  const generated = writeConfigCommands({ directory, cacheDir })
  if (generated) templates.push(generated)
  const skills = existingDirs([
    path.join(directory, '.opencode', 'skill'),
    path.join(directory, '.opencode', 'skills'),
    path.join(directory, '.claude', 'skills'),
    path.join(home, '.config', 'opencode', 'skill'),
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(home, '.claude', 'skills'),
  ])
  return [...templates.flatMap((dir) => ['--prompt-template', dir]), ...allowedSkillDirs(skills, enabledSkills, disabledSkills).flatMap((dir) => ['--skill', dir])]
}
