import type { Layer } from '@deck.gl/core';
import { WindLayer } from 'deck-wind-layer';
import { Slider } from '@/components/ui/slider';
import { WEATHER_BASE } from '../config';
import type { WindTexIndex } from '../generated/weather';
import { nearestStep } from '../Timeline';
import { age } from '../weather';
import { RasterLegend } from './legend';
import { WIND_COLOR_MAX, WIND_STOPS } from './rasterShared';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';
import { WindRasterLayer } from './windRasterLayer';

/**
 * Windy-style wind: a colored wind-speed raster (`WindRasterLayer`) under
 * animated particles (`WindLayer` from the `deck-wind-layer` package), both
 * reading the GFS u/v texture for the forecast step nearest `ctx.time`. The
 * layer ids are stable, so scrubbing the timeline just swaps the texture
 * (`image` prop), no rebuild.
 */
export const wind: WeatherLayer<WindTexIndex> = {
  id: 'wind',
  label: () => 'wind',
  legend: (
    <Swatch className="bg-linear-to-r from-blue-700 via-green-400 to-fuchsia-600" />
  ),
  defaultVisible: true,
  initialUi: { speed: 0.15, opacity: 0.6 },
  select: (w) => w.windTex,
  build: (idx, ctx) => {
    const step = nearestStep(idx.hours, ctx.time);
    const common = {
      image: `${WEATHER_BASE}/weather/windtex/${idx.snapshotMs}/${step}.png`,
      uMin: idx.uMin,
      uMax: idx.uMax,
      vMin: idx.vMin,
      vMax: idx.vMax,
    };
    // Array order = paint order: raster underneath, particles on top.
    const layers: Layer[] = [
      new WindRasterLayer({
        id: 'wind-raster',
        ...common,
        opacity: ctx.ui.opacity ?? 0.6,
      }),
    ];
    // prefers-reduced-motion: show the speed raster only, no animated particles.
    if (!ctx.reducedMotion) {
      layers.push(
        new WindLayer({
          id: 'wind-particles',
          ...common,
          speedFactor: ctx.ui.speed ?? 0.15,
        }),
      );
    }
    return layers;
  },
  controls: (ctx, idx) => (
    <div className="flex flex-col gap-1.5">
      <div className="text-slate-400 text-xs">GFS · {age(idx?.snapshotMs)}</div>
      <RasterLegend
        stops={WIND_STOPS}
        domain={[0, WIND_COLOR_MAX]}
        unit="m/s"
      />
      <label className="flex items-center gap-2 text-slate-400 text-xs">
        <span className="w-10 shrink-0">fill</span>
        <Slider
          className="flex-1"
          value={[ctx.ui.opacity ?? 0.6]}
          min={0}
          max={1}
          step={0.05}
          onValueChange={([v]) => ctx.setUi({ opacity: v })}
          aria-label="wind fill opacity"
        />
      </label>
      <label className="flex items-center gap-2 text-slate-400 text-xs">
        <span className="w-10 shrink-0">speed</span>
        <Slider
          className="flex-1"
          value={[ctx.ui.speed ?? 0.15]}
          min={0.05}
          max={0.3}
          step={0.05}
          onValueChange={([v]) => ctx.setUi({ speed: v })}
          aria-label="wind particle speed"
        />
      </label>
    </div>
  ),
};
