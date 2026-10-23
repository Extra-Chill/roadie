// Backend-neutral file search under a project directory.
//
// Replaces backend `find.files` autocomplete with a local walk, so file
// suggestions work the same on every agent backend (no backend client or
// server involved). Respects the project root's `.gitignore` for plain
// patterns: comments, `*`/`?`/`**` globs, directory-only (trailing `/`) and
// anchored (inner `/` or leading `/`) rules. Negation rules and nested
// `.gitignore` files are out of scope. `.git` and `node_modules` are always
// skipped, and the walk and result count are capped so huge trees stay cheap.

import fs from 'node:fs'
import path from 'node:path'

/** Directories never useful as file suggestions, even without a .gitignore. */
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules'])

/** Upper bound on entries visited, so degenerate trees cannot stall autocomplete. */
const MAX_VISITED_ENTRIES = 20_000

type IgnoreRule = {
  regex: RegExp
  /** Rules ending in `/` only match directories (gitignore semantics). */
  dirOnly: boolean
}

function globToRegExp(pattern: string): RegExp {
  let source = ''
  let index = 0
  while (index < pattern.length) {
    if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?'
      index += 3
      continue
    }
    if (pattern.startsWith('**', index)) {
      source += '.*'
      index += 2
      continue
    }
    const char = pattern[index]!
    if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    index += 1
  }
  return new RegExp(`^${source}$`)
}

function compileIgnoreLine(rawLine: string): IgnoreRule | undefined {
  let line = rawLine.trimEnd()
  if (!line || line.startsWith('#')) return undefined
  // Negation rules are out of scope for the autocomplete walk.
  if (line.startsWith('!')) return undefined
  const dirOnly = line.endsWith('/')
  if (dirOnly) line = line.slice(0, -1)
  if (line.startsWith('/')) line = line.slice(1)
  if (!line) return undefined
  // A pattern without an inner slash matches the basename at any depth;
  // otherwise the pattern is anchored to the project root (gitignore rules).
  if (!line.includes('/')) line = `**/${line}`
  return { regex: globToRegExp(line), dirOnly }
}

function readIgnoreRules(directory: string): IgnoreRule[] {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(directory, '.gitignore'), 'utf8')
  } catch {
    return []
  }
  return raw
    .split(/\r?\n/)
    .flatMap((line) => {
      const rule = compileIgnoreLine(line)
      return rule ? [rule] : []
    })
}

function isIgnored(relativePath: string, isDirectory: boolean, ignoreRules: IgnoreRule[]): boolean {
  return ignoreRules.some((rule) => (rule.dirOnly && !isDirectory ? false : rule.regex.test(relativePath)))
}

/**
 * Files under `directory` as POSIX-style relative paths, newest-relevant
 * order undefined; directories matching the ignore rules are pruned.
 */
export function searchProjectFiles({
  directory,
  query,
  limit = 100,
}: {
  directory: string
  /** Substring matched case-insensitively against the relative path. */
  query?: string
  /** Maximum number of paths returned. */
  limit?: number
}): string[] {
  const normalizedQuery = (query ?? '').trim().toLowerCase()
  const ignoreRules = readIgnoreRules(directory)
  const results: string[] = []
  let visited = 0

  const walk = (absoluteDir: string, relativeDir: string): void => {
    if (results.length >= limit || visited >= MAX_VISITED_ENTRIES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (results.length >= limit || visited >= MAX_VISITED_ENTRIES) return
      visited += 1
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const isDirectory = entry.isDirectory()
      if (isIgnored(relativePath, isDirectory, ignoreRules)) continue
      if (isDirectory) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue
        walk(path.join(absoluteDir, entry.name), relativePath)
        continue
      }
      if (!entry.isFile()) continue
      if (normalizedQuery && !relativePath.toLowerCase().includes(normalizedQuery)) continue
      results.push(relativePath)
    }
  }

  walk(directory, '')
  return results
}
