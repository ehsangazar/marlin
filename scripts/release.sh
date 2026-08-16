#!/usr/bin/env bash
# Bump the version everywhere it appears, update the changelog, commit and tag.
#
# package.json is the source of truth (tauri.conf.json points at it), but the
# Rust crate needs its own copy, so this keeps them from drifting. Three files
# each holding a version by hand is three files that eventually disagree.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: scripts/release.sh <version>   e.g. 0.2.0"; exit 1; }
V="$1"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "not semver: $V"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit first"; exit 1; }

node -e "const f='package.json',j=require('./'+f);j.version='$V';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
perl -0pi -e "s/^version = \"[^\"]+\"/version = \"$V\"/m" src-tauri/Cargo.toml

DATE="$(date +%Y-%m-%d)"
perl -0pi -e "s/## \[Unreleased\]/## [Unreleased]\n\n## [$V] - $DATE/" CHANGELOG.md

# Refresh Cargo.lock so the version bump is recorded rather than left stale.
(cd src-tauri && cargo update -p marlin --precise "$V" 2>/dev/null || cargo check -q >/dev/null 2>&1 || true)

# Regenerate the update feed so it cannot describe a release that is not this one.
node scripts/version-json.mjs

git add -A
git commit -q -m "Release v$V"
git tag -a "v$V" -m "Marlin v$V"
echo "tagged v$V — push with: git push && git push --tags"
