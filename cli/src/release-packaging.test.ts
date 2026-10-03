import { describe, expect, test } from 'vitest'
import { releasePackageJson } from './release-packaging.js'
import { githubRepoSlug, selectReleaseAsset } from './upgrade.js'

describe('release tarball', () => {
  test('shipped package.json drops dev-only fields', () => {
    const shipped = releasePackageJson({
      name: '@extrachill/roadie',
      version: '1.2.3',
      files: ['dist', 'bin.js'],
      scripts: { build: 'tsc' },
      dependencies: { errore: '^0.14.1', zod: '^4' },
      devDependencies: { vitest: '^3' },
    })
    expect(shipped).toEqual({ name: '@extrachill/roadie', version: '1.2.3', files: ['dist', 'bin.js'], dependencies: { errore: '^0.14.1', zod: '^4' } })
  })

  test('a local (workspace, link, file) runtime dependency fails the release', () => {
    for (const spec of ['workspace:^', 'link:../x', 'file:../x']) {
      expect(() => releasePackageJson({ name: 'x', version: '1', dependencies: { local: spec } })).toThrow(/must come from npm: local/)
    }
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
