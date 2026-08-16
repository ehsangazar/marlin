#!/usr/bin/env bash
# Point the update feed at a release that CI has already built.
#
# This used to run `tauri build` on whatever machine you happened to be sitting
# at, which is why every release Marlin had ever shipped was one Apple Silicon
# disk image: no Intel Mac build, no Windows build, and no way to make one
# without owning the hardware. Building moved to .github/workflows/release.yml.
# What is left here is the step that cannot move, because it needs an SSH key
# for a server that also runs production and this is a public repository.
#
# The order is the whole point. site/version.json is the feed every installed
# copy of Marlin polls once a day. Publishing it before the installers are
# downloadable tells every running copy to fetch a 404, so this refuses to
# publish until it has checked each URL in the feed against the actual release.
#
#   scripts/release.sh 0.1.2     bump, changelog, commit, tag, regenerate the feed
#   git push && git push --tags  CI builds macOS and Windows, attaches them
#   scripts/publish.sh           verify, then publish the feed
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

V="$(node -p "require('./package.json').version")"
TAG="v$V"
HOST="root@178.105.103.56"
KEY="$HOME/.ssh/id_ed25519_hetzner"

git rev-parse "$TAG" >/dev/null 2>&1 || { echo "no tag $TAG: run scripts/release.sh $V first"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty"; exit 1; }

# The feed has to describe this version. It is generated from package.json, so a
# mismatch means release.sh was not the last thing to touch it.
FEED_V="$(node -p "require('./site/version.json').version")"
[ "$FEED_V" = "$V" ] || { echo "site/version.json says $FEED_V, package.json says $V: rerun scripts/release.sh"; exit 1; }

echo "==> pushing $TAG"
git push
git push --tags

# Wait for the workflow rather than guessing. A release that is still a draft,
# or still uploading, looks exactly like a release with missing artefacts.
echo "==> waiting for the release build"
for _ in $(seq 1 120); do
  if gh release view "$TAG" --json isDraft --jq '.isDraft' 2>/dev/null | grep -qx false; then
    break
  fi
  printf '.'
  sleep 30
done
echo
gh release view "$TAG" --json isDraft --jq '.isDraft' 2>/dev/null | grep -qx false || {
  echo "$TAG is still a draft after an hour. Check: gh run list --workflow=release.yml"
  exit 1
}

# Every URL the feed will hand out, checked against the release that exists.
# A name invented in version-json.mjs and never verified is how the update
# button starts downloading nothing.
echo "==> checking every download in the feed"
# An empty `downloads` would make the loop below check nothing and pass, which
# is the one failure mode a verification step must not have.
COUNT="$(node -p "Object.keys(require('./site/version.json').downloads||{}).length")"
[ "$COUNT" -gt 0 ] || { echo "site/version.json has no downloads to check: rerun scripts/version-json.mjs"; exit 1; }
FAIL=0
while read -r KEY_NAME URL; do
  NAME="${URL##*/}"
  if gh release view "$TAG" --json assets --jq '.assets[].name' | grep -qxF "$NAME"; then
    echo "    ok       $KEY_NAME -> $NAME"
  else
    echo "    MISSING  $KEY_NAME -> $NAME"
    FAIL=1
  fi
done < <(node -p "Object.entries(require('./site/version.json').downloads).map(([k,v])=>k+' '+v).join('\n')")

if [ "$FAIL" = 1 ]; then
  echo
  echo "The release is missing artefacts the feed names. Publishing now would point"
  echo "installed copies at a 404. What the release actually has:"
  gh release view "$TAG" --json assets --jq '.assets[].name' | sed 's/^/    /'
  echo
  echo "Fix the names in scripts/version-json.mjs, rerun it, amend, and try again."
  exit 1
fi

# Last, and only now that every installer is downloadable. marlin.gazar.dev is a
# hand-run nginx container bind-mounting /data/marlin-site; there is no CI for
# it, so the feed goes up over scp.
echo "==> publishing the update feed"
scp -i "$KEY" site/version.json "$HOST:/data/marlin-site/version.json"
scp -i "$KEY" site/index.html "$HOST:/data/marlin-site/index.html"

echo
echo "$TAG is live. Every running copy will see it on its next check:"
curl -s https://marlin.gazar.dev/version.json
