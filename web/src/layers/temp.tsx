import type { Color } from '@deck.gl/core';
import { TextLayer } from '@deck.gl/layers';
import type { Feature, Point } from '../generated/geojson';
import type { GridProps } from '../generated/weather';
import { age, type WeatherFc } from '../weather';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

type GridFc = WeatherFc<Point, GridProps>;
type GridFeature = Feature<Point, GridProps>;

function tempColor(f: number): Color {
  if (f <= 32) return [37, 99, 235, 255];
  if (f <= 50) return [13, 148, 136, 255];
  if (f <= 70) return [22, 163, 74, 255];
  if (f <= 85) return [234, 88, 12, 255];
  return [220, 38, 38, 255];
}

export const temp: WeatherLayer<GridFc> = {
  id: 'temps',
  label: () => 'temperature',
  legend: <Swatch className="bg-linear-to-br from-blue-600 to-red-600" />,
  defaultVisible: false,
  select: (w) => w.activeGrid,
  build: (grid, ctx) => {
    // Near the ground, every cell; out at planet zoom, thin the lattice (by its
    // i/j props) so the labels don't pile up.
    const stride = ctx.zoom < 3 ? 3 : ctx.zoom < 4.5 ? 2 : 1;
    const cells = grid.features.filter(
      (f) =>
        f.properties.tempF != null &&
        (ctx.region ||
          ((f.properties.i ?? 0) % stride === 0 &&
            (f.properties.j ?? 0) % stride === 0)),
    );
    return [
      new TextLayer<GridFeature>({
        id: 'temps',
        data: cells,
        pickable: true,
        // GeoJSON coordinates are number[]; deck.gl wants a fixed position tuple.
        getPosition: (f) => f.geometry.coordinates as [number, number],
        getText: (f) => `${Math.round(f.properties.tempF as number)}°`,
        getColor: (f) => tempColor(f.properties.tempF as number),
        getSize: 16,
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontWeight: 700,
        fontSettings: { sdf: true },
        outlineWidth: 2,
        outlineColor: [255, 255, 255, 235],
        characterSet: 'auto',
      }),
    ];
  },
  controls: (ctx, grid) => (
    <div className="text-slate-400 text-xs">
      {age(grid?.generated_ms)} · {ctx.region ? 'regional' : 'global'}
    </div>
  ),
  tooltip: (o) => {
    const p = o?.properties;
    if (p?.tempF == null) return null;
    return `${Math.round(p.tempF)}°F · ${p.rh ?? '—'}% RH\nwind ${Math.round(p.windMph ?? 0)} mph from ${p.windDir ?? '—'}°`;
  },
};
