// Applies roadie's --enable-skill / --disable-skill CLI flags to skill names.
//
// cli.ts validates mutual exclusion of the two flags at startup, so this
// helper assumes at most one of the two arrays is non-empty.

// Checks whether a skill name is allowed by the current whitelist/blacklist.
// The Pi backend loads only allowed skills, and registerCommands() filters
// skill-sourced slash commands so disabled ones don't count toward Discord's
// 100-command limit.
export function isSkillAllowed({
  name,
  enabledSkills,
  disabledSkills,
}: {
  name: string
  enabledSkills: string[]
  disabledSkills: string[]
}): boolean {
  if (enabledSkills.length > 0) {
    return enabledSkills.includes(name)
  }
  if (disabledSkills.length > 0) {
    return !disabledSkills.includes(name)
  }
  return true
}
