/** Empty in production — the site, tiles and weather share one origin,
 * so every fetch is relative. Dev points at the local martin. */
export const API_BASE: string =
  import.meta.env.VITE_API_BASE ?? 'http://localhost:3030';

/** Weather JSON base; empty string in dev so vite serves web/public/weather/. */
export const WEATHER_BASE: string =
  import.meta.env.VITE_WEATHER_BASE ?? API_BASE;

/** Whole-world start; a URL hash (shareable view) overrides this. */
export const INITIAL_VIEW = { longitude: -97.0, latitude: 32.8, zoom: 0 };

/** Below this zoom the coarse global conditions lattice renders; at or
 * above it, the fine regional grid takes over. */
export const GRID_ZOOM_SPLIT = 6.5;

/** A radar tile template plus the deepest zoom the server actually renders;
 * past it the TileLayer overzooms (stretches) the maxNativeZoom tiles. */
export interface RadarSource {
  template: string;
  maxNativeZoom: number;
}

/**
 * RainViewer aggregates the world's national radar networks into one
 * composite. The API returns timestamped frame paths to build tile URLs.
 */
export const RAINVIEWER_API =
  'https://api.rainviewer.com/public/weather-maps.json';

/** RainViewer's free tile endpoint returns "Zoom Level Not Supported"
 * tiles past z7. */
export const RAINVIEWER_MAX_NATIVE_ZOOM = 7;

/**
 * Fallback radar if RainViewer is unreachable: NEXRAD composite (US only),
 * rendered from NOAA data by the Iowa Environmental Mesonet.
 */
export const RADAR_FALLBACK: RadarSource = {
  template:
    'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
  maxNativeZoom: 12,
};
