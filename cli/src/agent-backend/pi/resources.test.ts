// The --enable-skill / --disable-skill filter (skill-filter.ts) applied to the
// Pi backend: openCodeResourceArgs stops passing disabled skill directories to
// pi, and sessions.command refuses /skill:name for them (backend.ts).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { openCodeResourceArgs } from './resources.js'
import { disabledSkillCommandRefusal } from './backend.js'
import { AgentRequestError } from '../types.js'

const TMP = process.env['TMPDIR'] || os.tmpdir()

/**
 * A project dir (with `.claude/skills`) and a distinct home dir, mirroring how
 * Roadie passes them; `args()` runs openCodeResourceArgs against the project.
 */
function skillProject(): {
  project: string
  writeSkill: (dirName: string, skillName?: string) => string
  args: (flags: { enabledSkills?: string[]; disabledSkills?: string[] }) => string[]
} {
  const root = fs.mkdtempSync(path.join(TMP, 'pi-skills-'))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  const writeSkill = (dirName: string, skillName = dirName): string => {
    const dir = path.join(project, '.claude', 'skills', dirName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: ${skillName}\n---\nRun the ${skillName} workflow.\n`,
    )
    return dir
  }
  return {
    project,
    writeSkill,
    args: (flags) =>
      openCodeResourceArgs({
        directory: project,
        cacheDir: root,
        home: path.join(root, 'home'),
        ...flags,
      }),
  }
}

describe('openCodeResourceArgs skill filtering', () => {
  test('without the flags, skill directories pass through to pi unchanged', () => {
    const { project, writeSkill, args } = skillProject()
    writeSkill('alpha')
    writeSkill('beta')
    expect(args({})).toEqual(['--skill', path.join(project, '.claude', 'skills')])
  })

  test('--disable-skill X: X is not passed to pi; other skills still are', () => {
    const { writeSkill, args } = skillProject()
    const alpha = writeSkill('alpha')
    const beta = writeSkill('beta')
    expect(args({ disabledSkills: ['alpha'] })).toEqual(['--skill', beta])
    expect(args({ disabledSkills: ['alpha'] })).not.toContain(alpha)
  })

  test('--enable-skill Y: only Y is passed to pi', () => {
    const { writeSkill, args } = skillProject()
    const alpha = writeSkill('alpha')
    const beta = writeSkill('beta')
    expect(args({ enabledSkills: ['beta'] })).toEqual(['--skill', beta])
    expect(args({ enabledSkills: ['beta'] })).not.toContain(alpha)
  })

  test('skill names come from the SKILL.md frontmatter, not the directory name', () => {
    const { writeSkill, args } = skillProject()
    const renamed = writeSkill('dir-name', 'deploy-notes')
    expect(args({ disabledSkills: ['deploy-notes'] })).not.toContain(renamed)
    expect(args({ enabledSkills: ['deploy-notes'] })).toContain(renamed)
  })
})

describe('disabledSkillCommandRefusal', () => {
  test('refuses skill:name for a disabled skill, before and after resolution', () => {
    const disabled = { disabledSkills: ['alpha'] }
    const direct = disabledSkillCommandRefusal({ command: 'skill:alpha', ...disabled })
    expect(direct).toBeInstanceOf(AgentRequestError)
    expect(direct?.message).toContain('alpha')
    expect(
      disabledSkillCommandRefusal({ command: 'alpha', piName: 'skill:alpha', ...disabled }),
    ).toBeInstanceOf(AgentRequestError)
  })

  test('refuses skills outside an --enable-skill whitelist', () => {
    expect(
      disabledSkillCommandRefusal({ command: 'skill:alpha', enabledSkills: ['beta'] }),
    ).toBeInstanceOf(AgentRequestError)
    expect(
      disabledSkillCommandRefusal({ command: 'skill:beta', enabledSkills: ['beta'] }),
    ).toBeUndefined()
  })

  test('allows unfiltered skills, enabled ones, and non-skill commands', () => {
    expect(disabledSkillCommandRefusal({ command: 'skill:alpha' })).toBeUndefined()
    expect(
      disabledSkillCommandRefusal({ command: 'skill:beta', disabledSkills: ['alpha'] }),
    ).toBeUndefined()
    // A bare name that resolves to a non-skill pi command is never refused.
    expect(
      disabledSkillCommandRefusal({ command: 'shout', piName: 'shout', disabledSkills: ['shout'] }),
    ).toBeUndefined()
  })
})
