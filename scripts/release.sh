#!/usr/bin/env bash
# Cut a release: bump the version tag and push it. The pushed `v*` tag fires
# .github/workflows/release.yml, which generates the GitHub Release notes from
# the PRs merged since the previous tag. Deploys are unaffected — they stay on
# push-to-main (CD). The app version label is git-derived (vite.config.ts), so
# there are no files to bump: the tag IS the release.
#
# Usage: scripts/release.sh [patch|minor|major|X.Y.Z]   (default: patch)
#   patch|minor|major  bump the latest vX.Y.Z tag
#   X.Y.Z (or vX.Y.Z)  release this exact version (use for the first release)
set -euo pipefail
cd "$(dirname "$0")/.."

arg="${1:-patch}"

# --- guards: release only from a clean, pushed main -------------------------
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || {
  echo "error: releases come from main, not '$branch'." >&2
  exit 1
}
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty — commit or stash first." >&2
  exit 1
fi
git fetch --quiet --tags origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
  echo "error: main is out of sync with origin/main — push or pull first." >&2
  exit 1
}

# --- compute the next version (shared with the workflows) -------------------
prev=$(git tag --list 'v*' --sort=-v:refname | head -n1)
next="$(scripts/next-version.sh "$arg")"

git rev-parse -q --verify "refs/tags/$next" >/dev/null && {
  echo "error: tag $next already exists." >&2
  exit 1
}

# --- tag + push (release.yml takes it from here) ---------------------------
echo "Releasing ${prev:-none} -> $next ($(git rev-parse --short HEAD))"
git tag -a "$next" -m "Release $next"
git push origin "$next"

echo
echo "Pushed $next. release.yml is generating the GitHub Release notes:"
echo "  gh run watch \$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')"
echo "  gh release view $next --web"
