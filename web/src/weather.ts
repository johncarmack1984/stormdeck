import { useEffect, useState } from 'react';
import type { RadarSource } from './config';
import {
  RADAR_FALLBACK,
  RAINVIEWER_API,
  RAINVIEWER_MAX_NATIVE_ZOOM,
  WEATHER_BASE,
} from './config';
import type { FeatureCollection, Geometry, Point } from './generated/geojson';
import type {
  AlertProps,
  CapeTexIndex,
  CityTileIndex,
  LatticeForecast,
  RefcTexIndex,
  WindTexIndex,
} from './generated/weather';

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

/** The whole-planet temperature lattice JSON: a FeatureCollection of
 * GFS-sampled points, each carrying a temperature series, plus the shared
 * snapshot + hour axis it was sampled on — the same envelope as a city tile,
 * but global and untiled. */
export type LatticeFc = FeatureCollection<Point, LatticeForecast> & {
  snapshotMs: number;
  hours: number[];
};

/** Human "N min ago" for a feed's `generated_ms` (or model snapshot) time. */
export function age(ms?: number): string {
  if (!ms) return '—';
  const min = Math.round((Date.now() - ms) / 60_000);
  return min <= 0 ? 'just now' : `${min} min ago`;
}

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
/** The whole-planet temperature lattice (the zoomed-out grid). */
export const useLattice = () => useFeed<LatticeFc>('lattice.json', 600_000);

/** The point-forecast tile index (snapshot + hours). The citytile layer's
 * TileLayer fetches the actual per-tile JSON on demand. */
export const useCityTiles = () =>
  useFeed<CityTileIndex>('citytile/latest.json', 600_000);

/** The wind u/v texture index (snapshot + forecast hours + m/s bounds). The
 * wind layer loads the per-step PNG nearest the map-wide timeline. */
export const useWindTex = () =>
  useFeed<WindTexIndex>('windtex/latest.json', 600_000);

/** The REFC precip texture index (snapshot + forecast hours + dBZ bounds). The
 * precipitation layer loads the per-step PNG nearest the map-wide timeline when
 * scrubbed into the future. */
export const useRefcTex = () =>
  useFeed<RefcTexIndex>('refctex/latest.json', 600_000);

/** The surface-CAPE texture index (snapshot + forecast hours + J/kg bounds). The
 * storm-potential overlay loads the per-step PNG nearest the map-wide timeline. */
export const useCapeTex = () =>
  useFeed<CapeTexIndex>('capetex/latest.json', 600_000);

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

/** Everything the map's layers draw from, in one place. */
export interface WeatherData {
  alerts: WeatherFc<Geometry, AlertProps> | null;
  radar: RadarSource;
  /** Whole-planet temperature lattice (the zoomed-out grid). */
  lattice: LatticeFc | null;
  /** Point-forecast tile index (cities + the forecast time axis). */
  cityTiles: CityTileIndex | null;
  /** Wind u/v texture index (snapshot + forecast hours + m/s bounds). */
  windTex: WindTexIndex | null;
  /** REFC precip texture index (snapshot + forecast hours + dBZ bounds). */
  refcTex: RefcTexIndex | null;
  /** Surface-CAPE texture index (snapshot + forecast hours + J/kg bounds). */
  capeTex: CapeTexIndex | null;
}

/** One hook, all feeds — keeps the layer registry itself hook-free. The
 * temperature layer picks lattice vs. city tiles from `ctx.zoom` itself, so
 * this hook no longer needs the zoom. */
export function useWeatherData(): WeatherData {
  const alerts = useAlerts();
  const lattice = useLattice();
  const radar = useRadarTiles();
  const cityTiles = useCityTiles();
  const windTex = useWindTex();
  const refcTex = useRefcTex();
  const capeTex = useCapeTex();
  return { alerts, radar, lattice, cityTiles, windTex, refcTex, capeTex };
}
