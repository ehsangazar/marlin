#!/usr/bin/env bash
# Build the release, put it on GitHub, then point the update feed at it.
#
# Order matters and is the whole reason this is a script. release.sh regenerates
# site/version.json at tag time, but that file names a disk image that does not
# exist yet. Deploying it then would tell every running copy of Marlin to
# download a 404. So: build, upload, and only then publish the feed.
#
# Run scripts/release.sh <version> first. This picks up whatever it tagged.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

V="$(node -p "require('./package.json').version")"
TAG="v$V"
DMG="src-tauri/target/release/bundle/dmg/Marlin_${V}_aarch64.dmg"
HOST="root@178.105.103.56"
KEY="$HOME/.ssh/id_ed25519_hetzner"

git rev-parse "$TAG" >/dev/null 2>&1 || { echo "no tag $TAG — run scripts/release.sh $V first"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty"; exit 1; }

# Signing and notarising. Without these four values the build still succeeds,
# ad-hoc signed, and anyone who is not you gets "Apple could not verify this
# app" — so the build says which case it is running rather than finding out at
# the far end. The credentials live in 1Password, read once into the
# environment, because the desktop app relocks between calls.
if op item get "Apple Developer ID" --vault "Dev & Infra" >/dev/null 2>&1; then
  APPLE="$(op item get "Apple Developer ID" --vault "Dev & Infra" --fields label=notesPlain --reveal)"
  field() { printf '%s' "$APPLE" | grep "^$1:" | sed "s/^$1: //; s/\"$//"; }
  export APPLE_SIGNING_IDENTITY="$(field 'Signing identity')"
  export APPLE_ID="$(field 'Apple ID')"
  export APPLE_PASSWORD="$(field 'App-specific password')"
  export APPLE_TEAM_ID="$(field 'Team ID')"
  unset APPLE
  echo "==> signing as $APPLE_SIGNING_IDENTITY, notarising as $APPLE_ID"
else
  echo "!! no 'Apple Developer ID' item in 1Password: this build will be ad-hoc"
  echo "!! signed and Gatekeeper will refuse it on every Mac but this one."
  read -r -p "   build anyway? [y/N] " yn
  [ "$yn" = "y" ] || exit 1
fi

echo "==> building $TAG"
pnpm bundle
[ -f "$DMG" ] || { echo "no disk image at $DMG"; exit 1; }

# Trust the verdict, not the exit code: tauri will happily bundle an unsigned
# app, and the failure only shows up on someone else's machine.
APP="src-tauri/target/release/bundle/macos/Marlin.app"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  spctl -a -vvv -t exec "$APP" || { echo "Gatekeeper rejected the build"; exit 1; }
  xcrun stapler validate "$DMG" || { echo "the disk image is not stapled"; exit 1; }
fi

echo "==> pushing"
git push
git push --tags

# The changelog section for this version, minus its own heading, is the release
# body. One source for what changed, never two that disagree.
NOTES="$(awk -v v="## \\[$V\\]" 'BEGIN{p=0} $0 ~ v {p=1; next} /^## \[/ && p {exit} p' CHANGELOG.md)"

echo "==> releasing"
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DMG" --clobber
else
  gh release create "$TAG" "$DMG" --title "Marlin $TAG" --notes "$NOTES"
fi

# Last, and only now that the disk image is downloadable. marlin.gazar.dev is a
# hand-run nginx container bind-mounting /data/marlin-site; there is no CI for
# it, so the feed goes up over scp.
echo "==> publishing the update feed"
scp -i "$KEY" site/version.json "$HOST:/data/marlin-site/version.json"
scp -i "$KEY" site/index.html "$HOST:/data/marlin-site/index.html"

echo
echo "$TAG is live. Every running copy will see it on its next check:"
curl -s https://marlin.gazar.dev/version.json
