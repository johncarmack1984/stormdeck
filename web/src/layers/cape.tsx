import { Slider } from '@/components/ui/slider';
import { WEATHER_BASE } from '../config';
import type { CapeTexIndex } from '../generated/weather';
import { nearestStep } from '../Timeline';
import { age } from '../weather';
import { CapeRasterLayer } from './scalarRasterLayer';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

/**
 * Storm potential: GFS surface CAPE (convective available potential energy) as a
 * scrubbing raster — where the atmosphere is primed for thunderstorms. It's
 * always a forecast (no live analog like radar has), so it renders the step
 * nearest the map-wide time at every position. Off by default: a specialist
 * overlay beside the live NWS alerts, which stay the authoritative "now" hazard
 * layer. The texture swaps via the `image` prop as the timeline scrubs.
 */
export const cape: WeatherLayer<CapeTexIndex> = {
  id: 'cape',
  label: () => 'storm potential',
  legend: (
    <Swatch className="bg-linear-to-br from-green-500 via-orange-500 to-fuchsia-600" />
  ),
  defaultVisible: false,
  initialUi: { opacity: 0.5 },
  select: (w) => w.capeTex,
  build: (idx, ctx) => {
    const step = nearestStep(idx.hours, ctx.time);
    return [
      new CapeRasterLayer({
        id: 'cape-raster',
        image: `${WEATHER_BASE}/weather/capetex/${idx.snapshotMs}/${step}.png`,
        min: idx.capeMin,
        max: idx.capeMax,
        opacity: ctx.ui.opacity ?? 0.5,
      }),
    ];
  },
  controls: (ctx, idx) => (
    <div className="flex flex-col gap-1.5">
      <div className="text-slate-400 text-xs">
        CAPE · GFS · {age(idx?.snapshotMs)}
      </div>
      <Slider
        value={[ctx.ui.opacity ?? 0.5]}
        min={0.1}
        max={1}
        step={0.05}
        onValueChange={([v]) => ctx.setUi({ opacity: v })}
        aria-label="storm potential opacity"
      />
    </div>
  ),
};
