import type { Color } from '@deck.gl/core';
import { LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { GridProps, PointGeom, WeatherFc } from '../generated/weather';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

type GridFc = WeatherFc<PointGeom, GridProps>;

interface WindSeg {
  from: [number, number];
  to: [number, number];
  mph: number;
}

/**
 * Vector per grid cell pointing where the wind blows toward, scaled by speed.
 * `kmScale` stretches vectors for the coarse global lattice viewed from far out
 * (lengths sized for a metro grid vanish at planet zoom).
 */
function windSegments(grid: GridFc, kmScale: number): WindSeg[] {
  return grid.features
    .filter((f) => f.properties.windMph != null && f.properties.windDir != null)
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const mph = f.properties.windMph as number;
      const dir = f.properties.windDir as number;
      // windDir is meteorological (the direction the wind comes FROM).
      const toward = ((dir + 180) * Math.PI) / 180;
      const lengthKm = (2 + mph * 0.6) * kmScale;
      const dLat = (lengthKm / 111) * Math.cos(toward);
      const dLon =
        (lengthKm / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(toward);
      return {
        from: [lon, lat] as [number, number],
        to: [lon + dLon, lat + dLat] as [number, number],
        mph,
      };
    });
}

function windColor(mph: number): Color {
  if (mph < 5) return [148, 163, 184, 200];
  if (mph < 15) return [56, 132, 222, 220];
  if (mph < 25) return [245, 158, 11, 235];
  return [220, 38, 38, 255];
}

export const wind: WeatherLayer<GridFc> = {
  id: 'wind',
  label: () => 'wind',
  legend: <Swatch className="bg-[#3884de]" />,
  defaultVisible: true,
  select: (w) => w.activeGrid,
  build: (grid, ctx) => {
    const segs = windSegments(grid, ctx.region ? 1 : 30);
    if (!segs.length) return [];
    return [
      new LineLayer<WindSeg>({
        id: 'wind-vectors',
        data: segs,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getColor: (d) => windColor(d.mph),
        getWidth: (d) => Math.max(1.5, Math.min(5, d.mph / 8)),
        widthUnits: 'pixels',
      }),
      new ScatterplotLayer<WindSeg>({
        id: 'wind-origins',
        data: segs,
        getPosition: (d) => d.from,
        getFillColor: [70, 80, 95, 200],
        radiusMinPixels: 2,
        radiusMaxPixels: 2,
      }),
    ];
  },
};
