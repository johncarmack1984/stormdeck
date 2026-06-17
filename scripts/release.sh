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

# --- compute the next version ----------------------------------------------
prev=$(git tag --list 'v*' --sort=-v:refname | head -n1)
prev="${prev:-v0.0.0}"
read -r major minor patch <<<"$(echo "${prev#v}" | tr '.' ' ')"

case "$arg" in
  major) next="v$((major + 1)).0.0" ;;
  minor) next="v${major}.$((minor + 1)).0" ;;
  patch) next="v${major}.${minor}.$((patch + 1))" ;;
  v*.*.* | [0-9]*.*.*)
    candidate="v${arg#v}"
    echo "$candidate" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || {
      echo "error: '$arg' is not a valid X.Y.Z version." >&2
      exit 1
    }
    next="$candidate"
    ;;
  *)
    echo "error: expected patch|minor|major or an X.Y.Z version, got '$arg'." >&2
    exit 1
    ;;
esac

git rev-parse -q --verify "refs/tags/$next" >/dev/null && {
  echo "error: tag $next already exists." >&2
  exit 1
}

# --- tag + push (release.yml takes it from here) ---------------------------
echo "Releasing $prev -> $next ($(git rev-parse --short HEAD))"
git tag -a "$next" -m "Release $next"
git push origin "$next"

echo
echo "Pushed $next. release.yml is generating the GitHub Release notes:"
echo "  gh run watch \$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')"
echo "  gh release view $next --web"
