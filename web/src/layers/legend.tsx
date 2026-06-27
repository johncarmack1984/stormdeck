import type { Rgb } from './rasterShared';

/** CSS `linear-gradient` color-stop list from evenly-spaced rgb stops. */
function gradient(stops: readonly Rgb[]): string {
  const parts = stops.map((c, i) => {
    const pct = ((i / (stops.length - 1)) * 100).toFixed(0);
    const [r, g, b] = c.map((v) => Math.round(v * 255));
    return `rgb(${r}, ${g}, ${b}) ${pct}%`;
  });
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/**
 * A compact colormap legend for a raster layer: the same color stops the shader
 * uses (so the bar matches the map), with low / mid / high value ticks and a
 * unit — turning the color-only overlays into readable scales.
 */
export function RasterLegend({
  stops,
  domain,
  unit,
}: {
  stops: readonly Rgb[];
  domain: readonly [number, number];
  unit: string;
}) {
  const [lo, hi] = domain;
  const mid = Math.round((lo + hi) / 2);
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className="h-1.5 rounded-xs"
        style={{ background: gradient(stops) }}
      />
      <div className="flex justify-between text-[10px] text-slate-400 tabular-nums">
        <span>{lo}</span>
        <span>{mid}</span>
        <span>
          {hi} {unit}
        </span>
      </div>
    </div>
  );
}
