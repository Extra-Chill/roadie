// Build the installable release tarball.
//
//   pnpm --filter @extrachill/roadie run pack:release  [--out <dir>]
//
// Roadie depends on three workspace packages (errore, libsqlproxy,
// opencode-injection-guard). Their npm releases are not guaranteed to match
// the workspace copies Roadie is built and tested against (errore on npm lacks
// the `errore.try(fn, catchFn)` form Roadie uses), so the tarball vendors the
// workspace copies under `vendor/` and rewrites their imports to relative
// paths. Every other dependency installs from npm as usual, which keeps native
// modules (libsql) correct for the installing platform.
//
// Not `bundleDependencies`: npm then skips linking bins for some transitive
// install scripts (msgpackr-extract's node-gyp-build-optional-packages), and
// `npm i -g` of the tarball fails.
//
// Expects `pnpm build` to have run for the workspace packages and the CLI.
// Prints the tarball path on the last line of stdout.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  entryOf,
  releasePackageJson,
  rewriteVendoredImports,
  VENDORED_PACKAGES,
  type PackageJson,
} from '../src/release-packaging.js'

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(cliDir, '..')


function readJson(file: string): PackageJson {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson
}

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

/** npm pack a directory and extract the result (exactly the published file set) into `dest`. */
function packInto(sourceDir: string, dest: string, scratch: string): void {
  const tarball = run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', scratch, sourceDir], scratch)
    .split('\n')
    .at(-1)!
  fs.mkdirSync(dest, { recursive: true })
  run('tar', ['xzf', path.join(scratch, tarball), '-C', dest, '--strip-components=1'], scratch)
}

function jsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(m?js)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

function main(): void {
  const outIndex = process.argv.indexOf('--out')
  const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1]! : path.join(cliDir, 'release'))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-release-'))
  const stage = path.join(scratch, 'stage')

  const cli = readJson(path.join(cliDir, 'package.json'))
  if (!fs.existsSync(path.join(cliDir, 'dist', 'bin.js'))) {
    throw new Error('cli/dist is missing. Run the build first.')
  }

  // The CLI's own published files (files: dist, src, bin.js) plus README and LICENSE.
  packInto(cliDir, stage, scratch)
  for (const extra of ['README.md', 'LICENSE']) {
    const source = path.join(repoDir, extra)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, extra))
  }

  const entries: Record<string, string> = {}
  for (const name of VENDORED_PACKAGES) {
    const dir = path.join(repoDir, name)
    const pkg = readJson(path.join(dir, 'package.json'))
    if (!fs.existsSync(path.join(dir, 'dist'))) throw new Error(`${name}/dist is missing. Build workspace packages first.`)
    const dest = path.join(stage, 'vendor', name)
    packInto(dir, dest, scratch)
    // Tests ship in some dist folders and import vitest; they are never loaded.
    for (const file of jsFiles(dest)) {
      if (/\.test\.m?js$/.test(file)) fs.rmSync(file)
    }
    entries[name] = path.join(dest, entryOf(pkg))
    if (!fs.existsSync(entries[name])) throw new Error(`${name} entry ${entries[name]} is missing`)
  }
  // Compiled tests ship in dist too. They import vitest and are never loaded.
  for (const file of jsFiles(path.join(stage, 'dist'))) {
    if (/\.test\.m?js$/.test(file)) {
      fs.rmSync(file)
      fs.rmSync(`${file}.map`, { force: true })
      fs.rmSync(file.replace(/\.m?js$/, '.d.ts'), { force: true })
    }
  }
  for (const file of [...jsFiles(path.join(stage, 'dist')), ...jsFiles(path.join(stage, 'vendor')), path.join(stage, 'bin.js')]) {
    const code = fs.readFileSync(file, 'utf8')
    const rewritten = rewriteVendoredImports(code, path.dirname(file), entries)
    if (rewritten !== code) fs.writeFileSync(file, rewritten)
  }

  fs.writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(releasePackageJson(cli, VENDORED_PACKAGES), null, 2)}\n`,
  )

  fs.mkdirSync(outDir, { recursive: true })
  const tarball = run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', outDir, stage], scratch)
    .split('\n')
    .at(-1)!
  fs.rmSync(scratch, { recursive: true, force: true })
  console.log(path.join(outDir, tarball))
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
