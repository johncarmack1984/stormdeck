import type { Color } from '@deck.gl/core';
import { GeoJsonLayer } from '@deck.gl/layers';
import type { Geometry } from '../generated/geojson';
import type { AlertProps } from '../generated/weather';
import { age, type WeatherFc } from '../weather';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

type AlertFc = WeatherFc<Geometry, AlertProps>;

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

export const alerts: WeatherLayer<AlertFc> = {
  id: 'alerts',
  label: (fc) => `NWS alerts${fc ? ` (${fc.features.length})` : ''}`,
  legend: <Swatch className="bg-[#dc3c1e]" />,
  defaultVisible: true,
  select: (w) => w.alerts,
  build: (fc) => [
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
  ],
  controls: (_ctx, fc) => (
    <div className="text-slate-400 text-xs">{age(fc?.generated_ms)}</div>
  ),
  tooltip: (o) => {
    const p = o?.properties;
    if (!p?.event) return null;
    return [p.event, p.headline, p.areaDesc].filter(Boolean).join('\n');
  },
};
