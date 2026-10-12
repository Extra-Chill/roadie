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

/** Extra `pi` arguments adding OpenCode-format commands and skills for a session directory. */
export function openCodeResourceArgs({ directory, cacheDir, home = os.homedir() }: { directory: string; cacheDir: string; home?: string }): string[] {
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
  return [...templates.flatMap((dir) => ['--prompt-template', dir]), ...skills.flatMap((dir) => ['--skill', dir])]
}
