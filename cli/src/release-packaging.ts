// Pure helpers for building the release tarball (cli/scripts/pack-release.ts).
// Kept in src so they are typechecked and unit tested with the rest of the CLI.

export type PackageJson = {
  name: string
  version: string
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

/** The CLI package.json as shipped: dev-only fields dropped, installable from npm alone. */
export function releasePackageJson(cli: PackageJson): PackageJson {
  const local = Object.entries(cli.dependencies ?? {}).filter(([, spec]) => /^(workspace|link|file):/.test(spec))
  if (local.length > 0) {
    throw new Error(`Runtime dependencies must come from npm: ${local.map(([name]) => name).join(', ')}`)
  }
  const { devDependencies: _dev, scripts: _scripts, ...rest } = cli
  return rest
}
