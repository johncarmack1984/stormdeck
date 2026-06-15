import { Slider } from '@/components/ui/slider';
import type { CityTileIndex } from './generated/weather';

/** The forecast-hour offset nearest "now" (snapped to a forecast step) — the
 * timeline's default position. */
export function nowOffset(axis: CityTileIndex): number {
  const targetH = (Date.now() - axis.snapshotMs) / 3_600_000;
  return axis.hours.reduce((best, h) =>
    Math.abs(h - targetH) < Math.abs(best - targetH) ? h : best,
  );
}

/** Map-wide forecast time scrubber. Sets a single hour offset that every
 * time-aware layer filters to (DataFilterExtension), so dragging it moves the
 * whole map through forecast time on the GPU. */
export function Timeline({
  axis,
  time,
  onChange,
}: {
  axis: CityTileIndex;
  time: number;
  onChange: (t: number) => void;
}) {
  const when = new Date(axis.snapshotMs + time * 3_600_000);
  const last = axis.hours[axis.hours.length - 1];
  return (
    <div className="dark absolute right-3 bottom-8 left-3 z-10 mx-auto flex max-w-2xl items-center gap-3 rounded-lg bg-slate-900/80 px-4 py-2.5 text-slate-200 shadow-lg backdrop-blur-sm">
      <span className="w-32 shrink-0 font-medium text-sm tabular-nums">
        {when.toLocaleString(undefined, {
          weekday: 'short',
          hour: 'numeric',
        })}
      </span>
      <Slider
        className="flex-1"
        min={0}
        max={last}
        step={3}
        value={[time]}
        onValueChange={([v]) => onChange(v)}
        aria-label="forecast time"
      />
      <span className="w-10 shrink-0 text-right text-slate-400 text-xs tabular-nums">
        +{Math.round(time)}h
      </span>
    </div>
  );
}
