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

/** Poll a weather JSON feed. `enabled` gates it on the consuming layer's
 * visibility — a feed for a hidden layer never fetches (and stops on hide),
 * which keeps the 1.8 MB lattice off the critical path when temperature is off
 * (the default). Polling lazy-starts the first time the layer is enabled. */
function useFeed<T>(
  path: string,
  intervalMs: number,
  enabled = true,
): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!enabled) return;
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
  }, [path, intervalMs, enabled]);
  return data;
}

export const useAlerts = () =>
  useFeed<WeatherFc<Geometry, AlertProps>>('alerts.json', 60_000);
/** The whole-planet temperature lattice (the zoomed-out grid). 1.8 MB, so it's
 * gated on the temperature layer being visible (off by default). */
export const useLattice = (enabled: boolean) =>
  useFeed<LatticeFc>('lattice.json', 600_000, enabled);

/** The point-forecast tile index (snapshot + hours). The citytile layer's
 * TileLayer fetches the actual per-tile JSON on demand. Always loaded — it's
 * also the map-wide timeline's axis. */
export const useCityTiles = () =>
  useFeed<CityTileIndex>('citytile/latest.json', 600_000);

/** The wind u/v texture index (snapshot + forecast hours + m/s bounds). The
 * wind layer loads the per-step PNG nearest the map-wide timeline. */
export const useWindTex = (enabled: boolean) =>
  useFeed<WindTexIndex>('windtex/latest.json', 600_000, enabled);

/** The REFC precip texture index (snapshot + forecast hours + dBZ bounds). The
 * precipitation layer loads the per-step PNG nearest the map-wide timeline when
 * scrubbed into the future. */
export const useRefcTex = (enabled: boolean) =>
  useFeed<RefcTexIndex>('refctex/latest.json', 600_000, enabled);

/** The surface-CAPE texture index (snapshot + forecast hours + J/kg bounds). The
 * storm-potential overlay loads the per-step PNG nearest the map-wide timeline. */
export const useCapeTex = (enabled: boolean) =>
  useFeed<CapeTexIndex>('capetex/latest.json', 600_000, enabled);

/**
 * Latest worldwide radar frame from RainViewer. Falls back to the IEM
 * NEXRAD composite (US only) until — or unless — the API answers.
 */
export function useRadarTiles(enabled = true): RadarSource {
  const [source, setSource] = useState<RadarSource>(RADAR_FALLBACK);
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled]);
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

/** One hook, all feeds — keeps the layer registry itself hook-free. `visible`
 * (the layer-id → on/off map) gates each feed on its layer, so a hidden layer
 * costs no fetch or polling; alerts and the citytile axis always load (the axis
 * drives the shared timeline). */
export function useWeatherData(visible: Record<string, boolean>): WeatherData {
  const alerts = useAlerts();
  const lattice = useLattice(visible.temp);
  const radar = useRadarTiles(visible.precip);
  const cityTiles = useCityTiles();
  const windTex = useWindTex(visible.wind);
  const refcTex = useRefcTex(visible.precip);
  const capeTex = useCapeTex(visible.cape);
  return { alerts, radar, lattice, cityTiles, windTex, refcTex, capeTex };
}
