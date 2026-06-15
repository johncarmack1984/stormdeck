#!/usr/bin/env bash
# Local dev: martin serving local pmtiles on :3030, vite on :5173.
# (3030 because :3000 is usually some other dev server.)
set -euo pipefail
cd "$(dirname "$0")/.."

TILES="${TILES:-tiles/region.pmtiles}"
WORLD="${WORLD:-tiles/world.pmtiles}"

[ -f "$TILES" ] || { echo "error: $TILES not found — run 'just tiles extract' first" >&2; exit 1; }
SOURCES=("$TILES")
if [ -f "$WORLD" ]; then
  SOURCES+=("$WORLD")
else
  echo "hint: no $WORLD — run 'just tiles extract' to get low-zoom world context"
fi
command -v martin >/dev/null || {
  echo "error: martin not found (brew install martin, or cargo install martin)" >&2
  exit 1
}
[ -f web/public/weather/alerts.json ] || \
  echo "hint: run 'just weather local' to populate live weather for the dev server"
[ -d web/node_modules ] || { echo "==> pnpm install"; (cd web && pnpm install); }

trap 'kill 0' EXIT INT TERM
echo "==> martin: http://localhost:3030  |  web: http://localhost:5173"
martin --listen-addresses 127.0.0.1:3030 "${SOURCES[@]}" &
# Override the dev default (the live site) to this local martin + vite-served
# weather, for offline / tile / basemap work.
(cd web && VITE_API_BASE=http://localhost:3030 VITE_WEATHER_BASE= pnpm run dev) &
wait
