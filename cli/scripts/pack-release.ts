// Build the installable release tarball.
//
//   pnpm --filter @extrachill/roadie run pack:release  [--out <dir>]
//
// Expects `pnpm build` to have run. Every dependency is a published npm
// package, so this is the CLI's own `npm pack` plus README and LICENSE, with
// dev-only fields stripped from the shipped package.json. Prints the tarball
// path on the last line of stdout.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { releasePackageJson, type PackageJson } from '../src/release-packaging.js'

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(cliDir, '..')

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function pack(sourceDir: string, dest: string): string {
  return path.join(dest, run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', dest, sourceDir], dest).split('\n').at(-1)!)
}

function main(): void {
  const outIndex = process.argv.indexOf('--out')
  const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1]! : path.join(cliDir, 'release'))
  if (!fs.existsSync(path.join(cliDir, 'dist', 'bin.js'))) throw new Error('cli/dist is missing. Run the build first.')

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-release-'))
  const stage = path.join(scratch, 'stage')
  fs.mkdirSync(stage)
  // npm pack gives exactly the published file set (files: dist, src, bin.js).
  run('tar', ['xzf', pack(cliDir, scratch), '-C', stage, '--strip-components=1'], scratch)
  for (const extra of ['README.md', 'LICENSE']) {
    const source = path.join(repoDir, extra)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, extra))
  }
  // Compiled tests ship in dist; they import vitest and are never loaded.
  for (const entry of fs.readdirSync(path.join(stage, 'dist'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.test\.(m?js|d\.ts)(\.map)?$/.test(entry.name)) fs.rmSync(path.join(entry.parentPath, entry.name))
  }
  const cli = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')) as PackageJson
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(releasePackageJson(cli), null, 2)}\n`)

  fs.mkdirSync(outDir, { recursive: true })
  const tarball = pack(stage, outDir)
  fs.rmSync(scratch, { recursive: true, force: true })
  console.log(tarball)
}

main()
