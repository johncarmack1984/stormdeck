import type { Color } from '@deck.gl/core';
import {
  DataFilterExtension,
  type DataFilterExtensionProps,
} from '@deck.gl/extensions';
import { TileLayer } from '@deck.gl/geo-layers';
import { TextLayer } from '@deck.gl/layers';
import { WEATHER_BASE } from '../config';
import type { CityForecast, CityTileIndex } from '../generated/weather';
import { age } from '../weather';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

/** One city's reading at one forecast step — the flattened, time-filterable
 * unit. Each city in a tile expands to one of these per hour. */
interface CityHour {
  position: [number, number];
  hour: number; // offset from the snapshot; the DataFilter value
  temp: number;
  name: string;
}

// One shared filter dimension (the forecast hour) across the whole map.
const TIME_FILTER = new DataFilterExtension({ filterSize: 1 });

function tempColor(f: number): Color {
  if (f <= 32) return [37, 99, 235, 255];
  if (f <= 50) return [13, 148, 136, 255];
  if (f <= 70) return [22, 163, 74, 255];
  if (f <= 85) return [234, 88, 12, 255];
  return [220, 38, 38, 255];
}

interface CityTile {
  hours: number[];
  features: {
    geometry: { coordinates: [number, number] };
    properties: CityForecast;
  }[];
}

/** Flatten a tile's cities into one point per (city, forecast hour). */
function explode(tile: CityTile | null): CityHour[] {
  if (!tile) return [];
  const out: CityHour[] = [];
  for (const f of tile.features) {
    const position = f.geometry.coordinates;
    const { name, t } = f.properties;
    for (let k = 0; k < t.length; k++) {
      out.push({ position, hour: tile.hours[k], temp: t[k], name });
    }
  }
  return out;
}

/**
 * City point forecasts, tile-addressed (the Windy `citytile` pattern). Each
 * tile ships every city's whole series; the client explodes it to one point per
 * (city, hour) and `DataFilterExtension` shows only those matching the map-wide
 * forecast time (`ctx.time`) — so scrubbing the timeline filters on the GPU,
 * with no refetch and no React churn.
 */
export const citytile: WeatherLayer<CityTileIndex> = {
  id: 'citytile',
  label: () => 'city temps',
  legend: <Swatch className="bg-linear-to-br from-blue-600 to-red-600" />,
  defaultVisible: false,
  select: (w) => w.cityTiles,
  build: (idx, ctx) => [
    // id carries the snapshot so a new model run refetches cleanly.
    new TileLayer({
      id: `citytile-${idx.snapshotMs}`,
      minZoom: idx.minZoom,
      maxZoom: idx.maxZoom,
      tileSize: 256,
      getTileData: ({ index: { x, y, z }, signal }: any) =>
        fetch(
          `${WEATHER_BASE}/weather/citytile/${idx.snapshotMs}/${z}/${x}/${y}.json`,
          { signal },
        )
          .then((r) => (r.ok ? r.json() : null))
          .then(explode),
      renderSubLayers: (props: any) =>
        new TextLayer<CityHour, DataFilterExtensionProps<CityHour>>({
          id: `${props.id}-text`,
          data: props.data,
          pickable: true,
          getPosition: (d) => d.position,
          getText: (d) => `${Math.round(d.temp)}°`,
          getColor: (d) => tempColor(d.temp),
          getSize: 13,
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontWeight: 700,
          fontSettings: { sdf: true },
          outlineWidth: 2,
          outlineColor: [255, 255, 255, 235],
          characterSet: 'auto',
          // Show only the hour the map-wide timeline is parked on. Steps are
          // 3h apart, so a ±1.5h window selects exactly one.
          getFilterValue: (d) => d.hour,
          filterRange: [ctx.time - 1.5, ctx.time + 1.5],
          extensions: [TIME_FILTER],
        }),
      // TileLayer caches each tile's sublayers; re-run renderSubLayers when the
      // timeline moves so the new filterRange reaches already-loaded tiles.
      updateTriggers: { renderSubLayers: ctx.time },
    }),
  ],
  controls: (_ctx, idx) => (
    <div className="text-slate-400 text-xs">GFS · {age(idx?.snapshotMs)}</div>
  ),
  tooltip: (o) => {
    const d = o as CityHour | undefined;
    return d?.name ? `${d.name}: ${Math.round(d.temp)}°` : null;
  },
};
