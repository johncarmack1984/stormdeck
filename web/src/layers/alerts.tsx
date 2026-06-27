import type { Color } from '@deck.gl/core';
import { GeoJsonLayer } from '@deck.gl/layers';
import type { Geometry } from '../generated/geojson';
import type { AlertProps, CityTileIndex } from '../generated/weather';
import { age, type WeatherFc } from '../weather';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

type AlertFc = WeatherFc<Geometry, AlertProps>;

/** Alerts plus the timeline axis (the citytile snapshot) so the layer can show
 * only the alerts in effect at the map-wide forecast time, like every other
 * time-aware layer. */
type AlertData = { fc: AlertFc; axis: CityTileIndex | null };

const FILL: Record<string, Color> = {
  Extreme: [168, 0, 90, 80],
  Severe: [220, 60, 30, 70],
  Moderate: [240, 150, 20, 55],
  Minor: [120, 170, 40, 45],
  Unknown: [128, 128, 128, 45],
};

const LINE: Record<string, Color> = {
  Extreme: [168, 0, 90, 220],
  Severe: [220, 60, 30, 220],
  Moderate: [200, 120, 0, 220],
  Minor: [100, 145, 30, 220],
  Unknown: [110, 110, 110, 220],
};

/** Wall-clock ms the timeline currently points at, or null before the axis
 * loads (in which case we don't filter — show all active alerts). */
function validMs(axis: CityTileIndex | null, time: number): number | null {
  return axis ? axis.snapshotMs + time * 3_600_000 : null;
}

/** Alerts in effect at `at` (ms). A null onset/expires is treated as unbounded
 * on that side; a null `at` means "don't filter". NWS `/alerts/active` only
 * returns currently-active alerts, so scrubbing forward expires them and any
 * future-onset alert in the feed appears at its onset. */
function activeAt(
  features: AlertFc['features'],
  at: number | null,
): AlertFc['features'] {
  if (at == null) return features;
  return features.filter((f) => {
    const onset = f.properties.onset ? Date.parse(f.properties.onset) : NaN;
    const expires = f.properties.expires
      ? Date.parse(f.properties.expires)
      : NaN;
    if (!Number.isNaN(onset) && at < onset) return false;
    if (!Number.isNaN(expires) && at > expires) return false;
    return true;
  });
}

export const alerts: WeatherLayer<AlertData> = {
  id: 'alerts',
  label: (d) => `NWS alerts${d ? ` (${d.fc.features.length})` : ''}`,
  legend: <Swatch className="bg-[#dc3c1e]" />,
  defaultVisible: true,
  select: (w) => (w.alerts ? { fc: w.alerts, axis: w.cityTiles } : null),
  build: (d, ctx) => {
    const features = activeAt(d.fc.features, validMs(d.axis, ctx.time));
    const fc = { ...d.fc, features };
    return [
      new GeoJsonLayer({
        id: 'alerts',
        data: fc as any,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 40],
        stroked: true,
        filled: true,
        lineWidthMinPixels: 1.5,
        getFillColor: (f: any) => FILL[f.properties.severity] ?? FILL.Unknown,
        getLineColor: (f: any) => LINE[f.properties.severity] ?? LINE.Unknown,
      }),
    ];
  },
  controls: (ctx, d) => {
    if (!d) return null;
    const total = d.fc.features.length;
    const shown = activeAt(d.fc.features, validMs(d.axis, ctx.time)).length;
    return (
      <div className="text-slate-400 text-xs">
        {shown < total ? `${shown} of ${total} in effect · ` : ''}
        {age(d.fc.generated_ms)}
      </div>
    );
  },
  tooltip: (o) => {
    const p = o?.properties;
    if (!p?.event) return null;
    return [p.event, p.headline, p.areaDesc].filter(Boolean).join('\n');
  },
};
