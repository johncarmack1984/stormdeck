import type { Color } from '@deck.gl/core';
import {
  DataFilterExtension,
  type DataFilterExtensionProps,
} from '@deck.gl/extensions';
import { TileLayer } from '@deck.gl/geo-layers';
import { TextLayer } from '@deck.gl/layers';
import { GRID_ZOOM_SPLIT, WEATHER_BASE } from '../config';
import type { CityForecast, CityTileIndex } from '../generated/weather';
import { age, type LatticeFc } from '../weather';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

// All GFS 2 m temperature, one source: a whole-planet lattice when zoomed out, a
// per-city tile pyramid when zoomed in (the Windy `citytile` trick). Both ship
// every point's full forecast series, so scrubbing the map-wide timeline filters
// on the GPU (DataFilterExtension) with no refetch — and lattice, cities, and
// wind all move together.

const FONT = 'ui-monospace, Menlo, monospace';

// One shared filter dimension (the forecast hour) across the whole map.
const TIME_FILTER = new DataFilterExtension({ filterSize: 1 });

function tempColor(f: number): Color {
  if (f <= 32) return [37, 99, 235, 255];
  if (f <= 50) return [13, 148, 136, 255];
  if (f <= 70) return [22, 163, 74, 255];
  if (f <= 85) return [234, 88, 12, 255];
  return [220, 38, 38, 255];
}

/** One reading at one forecast step — the flattened, time-filterable unit shared
 * by both modes. `name` is set for cities and absent for lattice points. */
interface TempRecord {
  position: [number, number];
  hour: number; // offset from the snapshot; the DataFilter value
  temp: number;
  name?: string;
}

/** What the temperature layer pulls from the shared feeds: the city-tile index
 * (zoomed in) and the whole-planet lattice (zoomed out). Both share one snapshot
 * + hour axis, so the timeline scrubs them in lockstep. */
interface TempData {
  idx: CityTileIndex | null;
  lattice: LatticeFc | null;
}

interface CityTile {
  hours: number[];
  features: {
    geometry: { coordinates: [number, number] };
    properties: CityForecast;
  }[];
}

/** Flatten a city tile into one record per (city, forecast hour). */
function explodeCities(tile: CityTile | null): TempRecord[] {
  if (!tile) return [];
  const out: TempRecord[] = [];
  for (const f of tile.features) {
    const position = f.geometry.coordinates;
    const { name, t } = f.properties;
    for (let k = 0; k < t.length; k++) {
      out.push({ position, hour: tile.hours[k], temp: t[k], name });
    }
  }
  return out;
}

// The lattice is one big FeatureCollection; flatten it the same way, but cache
// the result keyed on (data, stride) so scrubbing the timeline (which only moves
// filterRange, a GPU uniform) never re-explodes ~1600 points × the hour axis.
let latticeCache: {
  fc: LatticeFc;
  stride: number;
  records: TempRecord[];
} | null = null;
function latticeRecords(fc: LatticeFc, stride: number): TempRecord[] {
  if (latticeCache?.fc === fc && latticeCache.stride === stride) {
    return latticeCache.records;
  }
  const records: TempRecord[] = [];
  for (const f of fc.features) {
    const { t, i, j } = f.properties;
    // Thin the lattice at low zoom (by its i/j) so labels don't pile up.
    if (i % stride !== 0 || j % stride !== 0) continue;
    const position = f.geometry.coordinates as [number, number];
    for (let k = 0; k < t.length; k++) {
      records.push({ position, hour: fc.hours[k], temp: t[k] });
    }
  }
  latticeCache = { fc, stride, records };
  return records;
}

export const temp: WeatherLayer<TempData> = {
  id: 'temps',
  label: () => 'temperature',
  legend: <Swatch className="bg-linear-to-br from-blue-600 to-red-600" />,
  defaultVisible: false,
  select: (w) => ({ idx: w.cityTiles, lattice: w.lattice }),
  build: (d, ctx) => {
    if (!d.idx && !d.lattice) return [];

    // Zoomed out: the whole-planet lattice.
    if (ctx.zoom < GRID_ZOOM_SPLIT) {
      if (!d.lattice) return [];
      const stride = ctx.zoom < 3 ? 3 : ctx.zoom < 4.5 ? 2 : 1;
      return [
        new TextLayer<TempRecord, DataFilterExtensionProps<TempRecord>>({
          id: 'temps-lattice',
          data: latticeRecords(d.lattice, stride),
          pickable: true,
          getPosition: (r) => r.position,
          getText: (r) => `${Math.round(r.temp)}°`,
          getColor: (r) => tempColor(r.temp),
          getSize: 16,
          fontFamily: FONT,
          fontWeight: 700,
          fontSettings: { sdf: true },
          outlineWidth: 2,
          outlineColor: [255, 255, 255, 235],
          characterSet: 'auto',
          // Show only the hour the timeline is parked on (steps are 3h apart, so
          // a ±1.5h window selects exactly one). data stays referentially stable,
          // so scrubbing only updates this uniform.
          getFilterValue: (r) => r.hour,
          filterRange: [ctx.time - 1.5, ctx.time + 1.5],
          extensions: [TIME_FILTER],
        }),
      ];
    }

    // Zoomed in: per-city tiles. id carries the snapshot so a new model run
    // refetches cleanly.
    if (!d.idx) return [];
    const idx = d.idx;
    return [
      new TileLayer({
        id: `temps-city-${idx.snapshotMs}`,
        minZoom: idx.minZoom,
        maxZoom: idx.maxZoom,
        tileSize: 256,
        getTileData: ({ index: { x, y, z }, signal }: any) =>
          fetch(
            `${WEATHER_BASE}/weather/citytile/${idx.snapshotMs}/${z}/${x}/${y}.json`,
            { signal },
          )
            .then((r) => (r.ok ? r.json() : null))
            .then(explodeCities),
        renderSubLayers: (props: any) =>
          new TextLayer<TempRecord, DataFilterExtensionProps<TempRecord>>({
            id: `${props.id}-text`,
            data: props.data,
            pickable: true,
            getPosition: (r) => r.position,
            getText: (r) => `${Math.round(r.temp)}°`,
            getColor: (r) => tempColor(r.temp),
            getSize: 13,
            fontFamily: FONT,
            fontWeight: 700,
            fontSettings: { sdf: true },
            outlineWidth: 2,
            outlineColor: [255, 255, 255, 235],
            characterSet: 'auto',
            getFilterValue: (r) => r.hour,
            filterRange: [ctx.time - 1.5, ctx.time + 1.5],
            extensions: [TIME_FILTER],
          }),
        // TileLayer caches each tile's sublayers; re-run renderSubLayers when the
        // timeline moves so the new filterRange reaches already-loaded tiles.
        updateTriggers: { renderSubLayers: ctx.time },
      }),
    ];
  },
  controls: (_ctx, d) => (
    <div className="text-slate-400 text-xs">
      GFS · {age(d?.idx?.snapshotMs ?? d?.lattice?.snapshotMs)}
    </div>
  ),
  tooltip: (o) => {
    const d = o as TempRecord | undefined;
    if (!d || d.temp == null) return null;
    return d.name
      ? `${d.name}: ${Math.round(d.temp)}°`
      : `${Math.round(d.temp)}°F`;
  },
};
