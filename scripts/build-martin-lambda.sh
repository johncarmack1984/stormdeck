#!/usr/bin/env bash
# Package the prebuilt martin release binary as an AWS Lambda zip
# (provided.al2023 / arm64). Martin has native Lambda support: when
# AWS_LAMBDA_RUNTIME_API is set it serves Lambda events instead of HTTP.
# Usage: build-martin-lambda.sh [out.zip]
#   Downloads a PINNED martin release and verifies its sha256 before baking it
#   into the Lambda — "latest" is never used (supply-chain: freeze the exact
#   bytes). To bump, update PINNED_RELEASE + PINNED_SHA256 together (get the
#   checksum from `shasum -a 256` of the release tarball), or override both
#   MARTIN_RELEASE and MARTIN_SHA256 for a one-off. Dependabot can't track
#   release binaries, so this is a deliberate manual bump.
set -euo pipefail

# Pinned martin release + the sha256 of its aarch64 musl tarball.
PINNED_RELEASE="martin-v1.11.0"
PINNED_SHA256="350692798cbcda7d307adadcd9b16653bfe679fc0d2974ef25e70465255b7bed"

OUT="${1:-build/martin-lambda.zip}"
RELEASE="${MARTIN_RELEASE:-$PINNED_RELEASE}"
# The pinned checksum applies only to the pinned release; any override must bring
# its own (MARTIN_SHA256) — we refuse to run an unverified binary.
EXPECTED_SHA256="${MARTIN_SHA256:-}"
if [ -z "$EXPECTED_SHA256" ] && [ "$RELEASE" = "$PINNED_RELEASE" ]; then
  EXPECTED_SHA256="$PINNED_SHA256"
fi
if [ -z "$EXPECTED_SHA256" ]; then
  echo "error: no sha256 for martin release '$RELEASE' — set MARTIN_SHA256" >&2
  exit 1
fi

URL="https://github.com/maplibre/martin/releases/download/${RELEASE}/martin-aarch64-unknown-linux-musl.tar.gz"

mkdir -p "$(dirname "$OUT")"
ABS_OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TARBALL="$WORK/martin.tar.gz"
echo "==> downloading $URL"
curl -fL --progress-bar "$URL" -o "$TARBALL"

# Verify before trusting the contents. shasum -a 256 is on macOS and the CI
# ubuntu runner alike (avoids sha256sum, which macOS lacks).
actual=$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)
if [ "$actual" != "$EXPECTED_SHA256" ]; then
  echo "::error::martin tarball sha256 mismatch for $RELEASE" >&2
  echo "  expected $EXPECTED_SHA256" >&2
  echo "  actual   $actual" >&2
  exit 1
fi
echo "==> sha256 verified ($actual)"
tar -xzf "$TARBALL" -C "$WORK" martin

# TILE_SOURCES is a space-separated list of s3:// urls set on the function
# by the stack (unquoted on purpose so it word-splits into one positional
# source arg each); MARTIN_EXTRA_ARGS is a hook for extra flags.
cat >"$WORK/bootstrap" <<'EOF'
#!/bin/sh
set -eu
exec ./martin ${MARTIN_EXTRA_ARGS:-} $TILE_SOURCES
EOF
chmod +x "$WORK/bootstrap" "$WORK/martin"

rm -f "$ABS_OUT"
echo "==> zipping $OUT"
(cd "$WORK" && zip -q -9 "$ABS_OUT" bootstrap martin)
echo "==> wrote $OUT ($(du -h "$ABS_OUT" | cut -f1))"
