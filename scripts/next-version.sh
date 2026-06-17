#!/usr/bin/env bash
# Print the next release version (vX.Y.Z) for a bump level, from the latest v*
# tag. No side effects — it only reads tags and prints. Shared by `just release`
# (scripts/release.sh), auto-release.yml, and deploy-web.yml so all three agree
# on the version (the deploy bakes the same number auto-release tags, keeping
# the live label clean). Needs tags fetched (workflows use fetch-depth: 0).
#
# With no tags yet, the inaugural release is v0.1.0 (v1.0.0 for `major`).
# Usage: scripts/next-version.sh [patch|minor|major|X.Y.Z]   (default: patch)
set -euo pipefail

arg="${1:-patch}"

# An explicit X.Y.Z is taken as-is (normalized to a leading v), whether or not
# tags exist — used for the first release or to jump to a specific version.
if echo "$arg" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "v${arg#v}"
  exit 0
fi

prev=$(git tag --list 'v*' --sort=-v:refname | head -n1)

if [ -z "$prev" ]; then
  case "$arg" in
    major) echo "v1.0.0" ;;
    minor | patch) echo "v0.1.0" ;;
    *)
      echo "error: expected patch|minor|major or an X.Y.Z version, got '$arg'." >&2
      exit 1
      ;;
  esac
  exit 0
fi

read -r major minor patch <<<"$(echo "${prev#v}" | tr '.' ' ')"
case "$arg" in
  major) echo "v$((major + 1)).0.0" ;;
  minor) echo "v${major}.$((minor + 1)).0" ;;
  patch) echo "v${major}.${minor}.$((patch + 1))" ;;
  *)
    echo "error: expected patch|minor|major or an X.Y.Z version, got '$arg'." >&2
    exit 1
    ;;
esac
