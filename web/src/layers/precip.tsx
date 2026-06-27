import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { Slider } from '@/components/ui/slider';
import type { RadarSource } from '../config';
import { WEATHER_BASE } from '../config';
import type { CityTileIndex, RefcTexIndex } from '../generated/weather';
import { nearestStep } from '../Timeline';
import { age } from '../weather';
import { RasterLegend } from './legend';
import { REFC_DOMAIN, REFC_STOPS } from './rasterShared';
import { RefcRasterLayer } from './scalarRasterLayer';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

/** Within half a forecast step (1.5 h) of wall-clock now the timeline is "parked
 *  at now", so the live radar is the truth; past it we show the GFS forecast. */
const NOW_EPS_MS = 1.5 * 3_600_000;

type PrecipData = {
  /** Live radar composite (always present; RainViewer or the IEM fallback). */
  radar: RadarSource;
  /** GFS REFC forecast texture index (null until the feed loads). */
  refc: RefcTexIndex | null;
  /** The timeline's origin (temperature snapshot); null before it loads. */
  axis: CityTileIndex | null;
};

/**
 * What precipitation shows for the map-wide time: the live composite, or the GFS
 * REFC forecast step whose valid time matches the timeline. Resolved off the
 * timeline's *valid time* (axis snapshot + offset) vs. wall-clock now, so it's
 * correct even if the radar/temp/REFC feeds are a cycle apart.
 */
function resolvePrecip(
  d: PrecipData,
  time: number,
): { mode: 'live' } | { mode: 'forecast'; refc: RefcTexIndex; step: number } {
  const validMs = d.axis ? d.axis.snapshotMs + time * 3_600_000 : null;
  if (
    d.refc &&
    validMs !== null &&
    Math.abs(validMs - Date.now()) >= NOW_EPS_MS
  ) {
    const offsetH = (validMs - d.refc.snapshotMs) / 3_600_000;
    return {
      mode: 'forecast',
      refc: d.refc,
      step: nearestStep(d.refc.hours, offsetH),
    };
  }
  return { mode: 'live' };
}

/**
 * Precipitation: one time-aware layer. Parked at now it tiles the live radar
 * composite (RainViewer, IEM NEXRAD fallback — ~1 km truth); scrubbed into the
 * future it swaps to the GFS REFC forecast raster (coarse 0.25°, but it moves
 * with the one map-wide timeline instead of freezing at "now"). Never both at
 * once. The forecast texture for the nearest step swaps via the `image` prop, so
 * scrubbing within forecast range is a texture swap, no layer rebuild.
 */
export const precip: WeatherLayer<PrecipData> = {
  id: 'precip',
  label: () => 'precipitation',
  legend: (
    <Swatch className="bg-linear-to-br from-green-500 via-yellow-500 to-red-600" />
  ),
  defaultVisible: true,
  initialUi: { opacity: 0.65 },
  select: (w) => ({ radar: w.radar, refc: w.refcTex, axis: w.cityTiles }),
  build: (data, ctx) => {
    const opacity = ctx.ui.opacity ?? 0.65;
    const r = resolvePrecip(data, ctx.time);
    if (r.mode === 'forecast') {
      return [
        new RefcRasterLayer({
          id: 'precip-forecast',
          image: `${WEATHER_BASE}/weather/refctex/${r.refc.snapshotMs}/${r.step}.png`,
          min: r.refc.dbzMin,
          max: r.refc.dbzMax,
          opacity,
        }),
      ];
    }
    return [
      new TileLayer({
        id: 'precip-live',
        data: data.radar.template,
        minZoom: 1,
        maxZoom: data.radar.maxNativeZoom,
        tileSize: 256,
        opacity,
        renderSubLayers: (props: any) => {
          const [[west, south], [east, north]] = props.tile.boundingBox;
          // deck.gl BitmapLayer needs `data: undefined` (not null) to typecheck.
          return new BitmapLayer(props, {
            data: undefined,
            image: props.data,
            bounds: [west, south, east, north],
          });
        },
      }),
    ];
  },
  controls: (ctx, data) => {
    const forecast = data && resolvePrecip(data, ctx.time).mode === 'forecast';
    return (
      <div className="flex flex-col gap-1.5">
        <div className="text-slate-400 text-xs">
          {forecast
            ? `GFS forecast · ${age(data?.refc?.snapshotMs)}`
            : 'live · RainViewer / IEM'}
        </div>
        {forecast && (
          <RasterLegend stops={REFC_STOPS} domain={REFC_DOMAIN} unit="dBZ" />
        )}
        <Slider
          value={[ctx.ui.opacity ?? 0.65]}
          min={0.1}
          max={1}
          step={0.05}
          onValueChange={([v]) => ctx.setUi({ opacity: v })}
          aria-label="precipitation opacity"
        />
      </div>
    );
  },
};
