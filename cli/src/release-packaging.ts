// Pure helpers for building the release tarball (cli/scripts/pack-release.ts).
// Kept in src so they are typechecked and unit tested with the rest of the CLI.

import path from 'node:path'

export const VENDORED_PACKAGES = ['errore', 'libsqlproxy', 'opencode-injection-guard']

export type PackageJson = {
  name: string
  version: string
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  main?: string
  exports?: unknown
  [key: string]: unknown
}

/** The CLI package.json as shipped: vendored deps removed, dev-only fields dropped. */
export function releasePackageJson(cli: PackageJson, vendored: string[]): PackageJson {
  const dependencies = { ...cli.dependencies }
  for (const name of vendored) {
    if (!dependencies[name]) throw new Error(`${name} is not a runtime dependency of ${cli.name}`)
    delete dependencies[name]
  }
  const leftover = Object.entries(dependencies).filter(([, spec]) => spec.startsWith('workspace:'))
  if (leftover.length > 0) {
    throw new Error(`Unvendored workspace dependencies: ${leftover.map(([name]) => name).join(', ')}`)
  }
  const { devDependencies: _dev, scripts: _scripts, ...rest } = cli
  return { ...rest, dependencies, files: [...(cli.files ?? []), 'vendor'] }
}

/** Runtime entry file of a package, from `exports['.']` or `main`. */
export function entryOf(pkg: PackageJson): string {
  const root = (pkg.exports as Record<string, unknown> | undefined)?.['.']
  const entry = typeof root === 'string'
    ? root
    : (root as Record<string, string> | undefined)?.import ?? (root as Record<string, string> | undefined)?.default ?? pkg.main
  if (!entry) throw new Error(`${pkg.name} has no runtime entry`)
  return entry
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g

/**
 * Rewrite bare imports of vendored packages in one JS file to relative paths.
 * `entries` maps a package name to its absolute entry file in the stage.
 */
export function rewriteVendoredImports(code: string, fileDir: string, entries: Record<string, string>): string {
  return code.replace(SPECIFIER, (match, lead: string, quote: string, specifier: string) => {
    const name = Object.keys(entries).find((n) => specifier === n || specifier.startsWith(`${n}/`))
    if (!name) return match
    if (specifier !== name) throw new Error(`Subpath import ${specifier} of a vendored package is not supported`)
    let relative = path.relative(fileDir, entries[name]!).split(path.sep).join('/')
    if (!relative.startsWith('.')) relative = `./${relative}`
    return `${lead}${quote}${relative}${quote}`
  })
}
