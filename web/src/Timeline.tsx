import { Slider } from '@/components/ui/slider';
import type { CityTileIndex } from './generated/weather';

/** The forecast-hour offset nearest "now" (snapped to a step) — the timeline's
 * default position. */
export function nowOffset(axis: CityTileIndex): number {
  const targetH = (Date.now() - axis.snapshotMs) / 3_600_000;
  return axis.hours.reduce((best, h) =>
    Math.abs(h - targetH) < Math.abs(best - targetH) ? h : best,
  );
}

/** The next forecast step after `t`, looping back to the first. */
export function nextStep(t: number, axis: CityTileIndex): number {
  return axis.hours.find((h) => h > t) ?? axis.hours[0];
}

/** Map-wide forecast time control, tethered to the bottom of the panel. Sets a
 * single hour offset every time-aware layer filters to (DataFilterExtension),
 * so it moves the whole map through forecast time on the GPU; Play steps it. */
export function Timeline({
  axis,
  time,
  playing,
  onChange,
  onTogglePlay,
}: {
  axis: CityTileIndex;
  time: number;
  playing: boolean;
  onChange: (t: number) => void;
  onTogglePlay: () => void;
}) {
  const when = new Date(axis.snapshotMs + time * 3_600_000);
  const last = axis.hours[axis.hours.length - 1];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-slate-200 tabular-nums">
          {when.toLocaleString(undefined, {
            weekday: 'short',
            hour: 'numeric',
          })}
        </span>
        <span className="text-slate-400 tabular-nums">
          +{Math.round(time)}h
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={playing ? 'pause' : 'play'}
          className="flex size-6 shrink-0 items-center justify-center rounded bg-white/10 text-[10px] text-slate-200 leading-none hover:bg-white/20"
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <Slider
          className="flex-1"
          min={0}
          max={last}
          step={3}
          value={[time]}
          onValueChange={([v]) => onChange(v)}
          aria-label="forecast time"
        />
      </div>
    </div>
  );
}
