import { useEffect, useState } from 'react';
import type { RadarSource } from './config';
import {
  GRID_ZOOM_SPLIT,
  RADAR_FALLBACK,
  RAINVIEWER_API,
  RAINVIEWER_MAX_NATIVE_ZOOM,
  WEATHER_BASE,
} from './config';
import type { FeatureCollection, Geometry, Point } from './generated/geojson';
import type { AlertProps, CityTileIndex, GridProps } from './generated/weather';

// The payload shapes come from the Rust producer — weather-ingest's
// contract.rs is the single source of truth, and `just build types`
// regenerates ./generated/weather.ts from it (CI fails if the two
// drift).

/** A GeoJSON FeatureCollection plus the epoch-ms timestamp the ingester stamps
 * on as a foreign member. `FeatureCollection` is typed-geojson's, so these
 * payloads stay mutually assignable with `@types/geojson`. */
export type WeatherFc<G, P> = FeatureCollection<G, P> & {
  generated_ms: number;
};

function useFeed<T>(path: string, intervalMs: number): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${WEATHER_BASE}/weather/${path}`, { cache: 'no-cache' })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<T>;
        })
        .then((d) => {
          if (alive) setData(d);
        })
        .catch((err) => console.warn(`weather feed ${path} unavailable:`, err));
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, intervalMs]);
  return data;
}

export const useAlerts = () =>
  useFeed<WeatherFc<Geometry, AlertProps>>('alerts.json', 60_000);
export const useGrid = () =>
  useFeed<WeatherFc<Point, GridProps>>('grid.json', 300_000);
export const useGlobalGrid = () =>
  useFeed<WeatherFc<Point, GridProps>>('global.json', 600_000);

/** The point-forecast tile index (snapshot + hours). The citytile layer's
 * TileLayer fetches the actual per-tile JSON on demand. */
export const useCityTiles = () =>
  useFeed<CityTileIndex>('citytile/latest.json', 600_000);

/**
 * Latest worldwide radar frame from RainViewer. Falls back to the IEM
 * NEXRAD composite (US only) until — or unless — the API answers.
 */
export function useRadarTiles(): RadarSource {
  const [source, setSource] = useState<RadarSource>(RADAR_FALLBACK);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(RAINVIEWER_API)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((d) => {
          const frame = d?.radar?.past?.at(-1);
          if (alive && d?.host && frame?.path) {
            setSource({
              template: `${d.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
              maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM,
            });
          }
        })
        .catch((err) =>
          console.warn('rainviewer unavailable, using IEM fallback:', err),
        );
    load();
    const timer = setInterval(load, 300_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return source;
}

/** Everything the map's layers draw from, in one place. The region/global
 * grid split lives here so a layer just reads `activeGrid`. */
export interface WeatherData {
  alerts: WeatherFc<Geometry, AlertProps> | null;
  radar: RadarSource;
  /** Fine bbox grid (regional). */
  grid: WeatherFc<Point, GridProps> | null;
  /** Coarse planet lattice. */
  globalGrid: WeatherFc<Point, GridProps> | null;
  /** Whichever grid is live at the current zoom. */
  activeGrid: WeatherFc<Point, GridProps> | null;
  /** Point-forecast tile index (cities + the forecast time axis). */
  cityTiles: CityTileIndex | null;
  /** True near the ground (fine grid); false far out (global lattice). */
  region: boolean;
}

/** One hook, all feeds — keeps the layer registry itself hook-free. */
export function useWeatherData(zoom: number): WeatherData {
  const alerts = useAlerts();
  const grid = useGrid();
  const globalGrid = useGlobalGrid();
  const radar = useRadarTiles();
  const cityTiles = useCityTiles();
  const region = zoom >= GRID_ZOOM_SPLIT;
  return {
    alerts,
    radar,
    grid,
    globalGrid,
    activeGrid: region ? grid : globalGrid,
    cityTiles,
    region,
  };
}
