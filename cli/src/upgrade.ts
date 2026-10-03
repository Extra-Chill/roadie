// Roadie self-upgrade utilities.
// Detects the package manager used to install roadie, checks GitHub releases for newer versions,
// and runs the global upgrade command. Used by both CLI `roadie upgrade` and
// the Discord `/upgrade-and-restart` command, plus background auto-upgrade on startup.
// The package name comes from package.json, so the running package is what gets upgraded.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createLogger, LogPrefix } from './logger.js'
import { execAsync } from './git-utils.js'

const logger = createLogger(LogPrefix.CLI)

type Pm = 'bun' | 'pnpm' | 'npm'

// Detects which package manager globally installed roadie, used to run the
// correct `<pm> i -g <package>@latest` upgrade command.
//
// Detection order:
// 1. npm_config_user_agent — set by npx/bunx/pnpm dlx, reliable for those cases
// 2. Realpath of the running script — resolve symlinks and check if the path
//    lives under a known PM global directory (e.g. ~/.bun, ~/Library/pnpm,
//    /usr/local/lib/node_modules). Inspired by sindresorhus/global-directory.
// 3. process.versions.bun — if the runtime itself is Bun, likely bun ecosystem
// 4. Default to npm — safest fallback since npm is the most common global installer
export function detectPm(): Pm {
  const ua = process.env.npm_config_user_agent
  if (ua?.startsWith('bun/')) {
    return 'bun'
  }
  if (ua?.startsWith('pnpm/')) {
    return 'pnpm'
  }
  if (ua?.startsWith('npm/')) {
    return 'npm'
  }

  const scriptPath = resolveScriptRealpath()
  if (scriptPath) {
    const p = scriptPath.toLowerCase()
    // bun global installs live under ~/.bun or $BUN_INSTALL
    if (p.includes('.bun/') || p.includes('/bun/install/')) {
      return 'bun'
    }
    // pnpm global installs live under ~/Library/pnpm, ~/.local/share/pnpm, or $PNPM_HOME
    if (p.includes('/pnpm/')) {
      return 'pnpm'
    }
    // npm global installs typically live under lib/node_modules/<package> without
    // any pnpm or bun path segments, so if we reach here it's likely npm
  }

  if (process.versions.bun) {
    return 'bun'
  }

  return 'npm'
}

function resolveScriptRealpath(): string | null {
  try {
    const script = process.argv[1]
    if (!script) {
      return null
    }
    return fs.realpathSync(script)
  } catch {
    return null
  }
}

type PackageJson = { name: string; version: string; repository?: string | { url?: string } }

function readPackageJson(): PackageJson {
  const require = createRequire(import.meta.url)
  return require('../package.json') as PackageJson
}

export function getPackageName(): string {
  return readPackageJson().name
}

export function getCurrentVersion(): string {
  return readPackageJson().version
}

/** `owner/repo` of the GitHub repository in package.json `repository`. */
export function githubRepoSlug(repository: PackageJson['repository']): string | null {
  const url = typeof repository === 'string' ? repository : repository?.url
  const match = url?.match(/github\.com[/:]([^/]+\/[^/.#]+)/)
  return match?.[1] ?? null
}

export type ReleaseAsset = { version: string; url: string }
type GithubRelease = { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> }

/**
 * Pick the installable tarball from a GitHub release. Releases also carry a
 * small workspace tarball, so match the CLI package's own pack name.
 */
export function selectReleaseAsset(
  release: GithubRelease,
  packageName: string,
): ReleaseAsset | null {
  const version = release.tag_name?.replace(/^v/, '')
  if (!version) return null
  const packName = `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
  const asset = release.assets?.find((candidate) => candidate.name === packName)
  return asset ? { version, url: asset.browser_download_url } : null
}

/** Latest release tarball on GitHub, or null when it cannot be determined. */
export async function getLatestRelease(): Promise<ReleaseAsset | null> {
  try {
    const pkg = readPackageJson()
    const slug = githubRepoSlug(pkg.repository)
    if (!slug) return null
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    return selectReleaseAsset((await res.json()) as GithubRelease, pkg.name)
  } catch {
    return null
  }
}

async function installRelease(asset: ReleaseAsset): Promise<void> {
  await execAsync(`${detectPm()} i -g ${asset.url}`, { timeout: 180_000 })
}

// Returns the new version string if upgraded, null if already up to date.
export async function upgrade(): Promise<string | null> {
  const current = getCurrentVersion()
  const latest = await getLatestRelease()
  if (!latest) {
    throw new Error('Failed to find the latest Roadie release on GitHub')
  }
  if (current === latest.version) {
    return null
  }
  logger.log(`Upgrading ${getPackageName()} from v${current} to v${latest.version}...`)
  await installRelease(latest)
  return latest.version
}

// Fire-and-forget background upgrade check on bot startup.
// Only upgrades if a newer version is available. Errors are silently ignored.
export async function backgroundUpgradeRoadie(): Promise<void> {
  try {
    const current = getCurrentVersion()
    const latest = await getLatestRelease()
    if (!latest || current === latest.version) {
      return
    }
    logger.debug(`Background ${getPackageName()} upgrade started: v${current} -> v${latest.version}`)
    await installRelease(latest)
    logger.debug(`Background ${getPackageName()} upgrade completed: v${latest.version}`)
  } catch {
    // silently ignored, non-critical
  }
}
