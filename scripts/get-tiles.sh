#!/usr/bin/env bash
# Extract basemap archives from the latest protomaps daily build:
#   - full-detail extract of the area of interest (bbox, all zooms)
#   - low-zoom whole-world extract (z0-6) so zooming out has context
# Existing outputs are kept; delete a file to re-extract it.
# Usage: get-tiles.sh <minLon,minLat,maxLon,maxLat> <region.pmtiles> <world.pmtiles>
set -euo pipefail

BBOX="${1:?usage: get-tiles.sh <bbox> <region-out> <world-out>}"
REGION_OUT="${2:?missing region output path}"
WORLD_OUT="${3:?missing world output path}"
WORLD_MAXZOOM="${WORLD_MAXZOOM:-6}"

command -v pmtiles >/dev/null || {
  echo "error: pmtiles CLI not found (brew install pmtiles)" >&2
  exit 1
}

mkdir -p "$(dirname "$REGION_OUT")" "$(dirname "$WORLD_OUT")"

# Daily builds publish as YYYYMMDD.pmtiles; today's may not exist yet, so walk back.
for offset in 0 1 2 3 4; do
  if date -v-1d +%Y%m%d >/dev/null 2>&1; then
    DAY=$(date -u -v-"${offset}"d +%Y%m%d)   # BSD date (macOS)
  else
    DAY=$(date -u -d "-${offset} day" +%Y%m%d) # GNU date (Linux)
  fi
  URL="https://build.protomaps.com/${DAY}.pmtiles"
  if curl -sfIL -o /dev/null "$URL"; then
    if [ -f "$REGION_OUT" ]; then
      echo "==> $REGION_OUT exists, keeping it (delete to re-extract)"
    else
      echo "==> extracting bbox ${BBOX} from ${URL}"
      pmtiles extract "$URL" "$REGION_OUT" --bbox="$BBOX"
      echo "==> wrote $REGION_OUT ($(du -h "$REGION_OUT" | cut -f1))"
    fi
    if [ -f "$WORLD_OUT" ]; then
      echo "==> $WORLD_OUT exists, keeping it (delete to re-extract)"
    else
      echo "==> extracting world z0-${WORLD_MAXZOOM} from ${URL}"
      pmtiles extract "$URL" "$WORLD_OUT" --maxzoom="$WORLD_MAXZOOM"
      echo "==> wrote $WORLD_OUT ($(du -h "$WORLD_OUT" | cut -f1))"
    fi
    exit 0
  fi
  echo "    no build published for ${DAY}, trying previous day..."
done

echo "error: no protomaps daily build found in the last 5 days" >&2
exit 1
