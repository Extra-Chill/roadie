import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { releasePackageJson, rewriteVendoredImports, VENDORED_PACKAGES } from './release-packaging.js'
import { githubRepoSlug, selectReleaseAsset } from './upgrade.js'

describe('release tarball', () => {
  const stage = '/stage'
  const entries = {
    errore: path.join(stage, 'vendor/errore/dist/index.js'),
    libsqlproxy: path.join(stage, 'vendor/libsqlproxy/dist/index.js'),
  }

  test('vendored imports become relative paths from each file', () => {
    const code = [
      "import * as errore from 'errore'",
      "import { createLibsqlHandler } from \"libsqlproxy\"",
      "const lazy = await import('errore')",
      "import 'errore'",
      "import { z } from 'zod'",
      "import fs from 'node:fs'",
    ].join('\n')
    expect(rewriteVendoredImports(code, path.join(stage, 'dist/commands'), entries)).toBe([
      "import * as errore from '../../vendor/errore/dist/index.js'",
      "import { createLibsqlHandler } from \"../../vendor/libsqlproxy/dist/index.js\"",
      "const lazy = await import('../../vendor/errore/dist/index.js')",
      "import '../../vendor/errore/dist/index.js'",
      "import { z } from 'zod'",
      "import fs from 'node:fs'",
    ].join('\n'))
  })

  test('a self-import inside a vendored package stays inside it', () => {
    const out = rewriteVendoredImports("export * from 'errore'", path.join(stage, 'vendor/errore/dist'), entries)
    expect(out).toBe("export * from './index.js'")
  })

  test('similar names and subpaths are not silently mangled', () => {
    expect(rewriteVendoredImports("import x from 'errore-extra'", stage, entries)).toBe("import x from 'errore-extra'")
    expect(() => rewriteVendoredImports("import x from 'errore/core'", stage, entries)).toThrow(/Subpath/)
  })

  test('shipped package.json drops vendored and dev dependencies', () => {
    const shipped = releasePackageJson({
      name: '@extrachill/roadie',
      version: '1.2.3',
      files: ['dist', 'bin.js'],
      scripts: { build: 'tsc' },
      dependencies: { errore: 'workspace:^', libsqlproxy: 'workspace:^', 'opencode-injection-guard': 'workspace:^', zod: '^4' },
      devDependencies: { vitest: '^3' },
    }, VENDORED_PACKAGES)
    expect(shipped.dependencies).toEqual({ zod: '^4' })
    expect(shipped.files).toEqual(['dist', 'bin.js', 'vendor'])
    expect(shipped.devDependencies).toBeUndefined()
    expect(shipped.scripts).toBeUndefined()
  })

  test('an unvendored workspace dependency fails the release', () => {
    expect(() => releasePackageJson({ name: 'x', version: '1', dependencies: { errore: 'workspace:^', other: 'workspace:^' } }, ['errore']))
      .toThrow(/Unvendored workspace dependencies: other/)
  })
})

describe('upgrade from GitHub releases', () => {
  test('repository slug', () => {
    expect(githubRepoSlug('https://github.com/Extra-Chill/roadie')).toBe('Extra-Chill/roadie')
    expect(githubRepoSlug({ url: 'git+https://github.com/Extra-Chill/roadie.git' })).toBe('Extra-Chill/roadie')
    expect(githubRepoSlug('https://example.com/x')).toBeNull()
  })

  test('picks the CLI tarball, not the workspace one', () => {
    const release = {
      tag_name: 'v0.32.0',
      assets: [
        { name: 'roadie-workspace-0.32.0.tgz', browser_download_url: 'https://dl/workspace.tgz' },
        { name: 'extrachill-roadie-0.32.0.tgz', browser_download_url: 'https://dl/roadie.tgz' },
      ],
    }
    expect(selectReleaseAsset(release, '@extrachill/roadie')).toEqual({ version: '0.32.0', url: 'https://dl/roadie.tgz' })
    expect(selectReleaseAsset({ tag_name: 'v0.32.0', assets: [] }, '@extrachill/roadie')).toBeNull()
  })
})
