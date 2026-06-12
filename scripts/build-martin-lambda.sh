#!/usr/bin/env bash
# Package the prebuilt martin release binary as an AWS Lambda zip
# (provided.al2023 / arm64). Martin has native Lambda support: when
# AWS_LAMBDA_RUNTIME_API is set it serves Lambda events instead of HTTP.
# Usage: build-martin-lambda.sh [out.zip]   (MARTIN_RELEASE=v1.2.0 to pin)
set -euo pipefail

OUT="${1:-build/martin-lambda.zip}"
RELEASE="${MARTIN_RELEASE:-latest}"

if [ "$RELEASE" = "latest" ]; then
  URL="https://github.com/maplibre/martin/releases/latest/download/martin-aarch64-unknown-linux-musl.tar.gz"
else
  URL="https://github.com/maplibre/martin/releases/download/${RELEASE}/martin-aarch64-unknown-linux-musl.tar.gz"
fi

mkdir -p "$(dirname "$OUT")"
ABS_OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> downloading $URL"
curl -fL --progress-bar "$URL" | tar -xz -C "$WORK" martin

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
