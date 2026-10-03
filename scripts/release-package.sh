#!/usr/bin/env bash
# Homeboy release package step (nodejs extension `release_package_script`).
#
# Builds everything the CLI needs, packs the installable Roadie tarball, and
# prints its artifact JSON as the last line of stdout. All other output goes to
# stderr, as the package step contract requires.
set -euo pipefail

exec 3>&1 1>&2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# The release runner may not have pnpm on PATH (and Node 25+ no longer ships
# corepack), so fall back to the version pinned in package.json.
if ! command -v pnpm >/dev/null 2>&1; then
  pnpm_spec="$(node -p "require('./package.json').packageManager")"
  pnpm() { npx --yes "$pnpm_spec" "$@"; }
fi

pnpm install --frozen-lockfile
# The CLI typecheck covers its tests, which import the Discord twin.
(cd discord-digital-twin && pnpm generate && pnpm build)
(cd cli && pnpm build)

tarball="$(cd cli && pnpm exec tsx scripts/pack-release.ts --out "$root/cli/release" | tail -n 1)"
[[ -f "$tarball" ]] || { echo "pack-release did not produce a tarball" >&2; exit 1; }

printf '{"path":"%s","type":"npm_tarball","platform":null}\n' "$tarball" >&3
