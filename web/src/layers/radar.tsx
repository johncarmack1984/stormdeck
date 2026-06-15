import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { Slider } from '@/components/ui/slider';
import type { RadarSource } from '../config';
import { Swatch } from './swatch';
import type { WeatherLayer } from './types';

/** Live radar composite; the RainViewer (or IEM fallback) template is already
 *  stamped per frame, so the layer just tiles it. */
export const radar: WeatherLayer<RadarSource> = {
  id: 'radar',
  label: () => 'radar',
  legend: (
    <Swatch className="bg-linear-to-br from-green-500 via-yellow-500 to-red-600" />
  ),
  defaultVisible: true,
  initialUi: { opacity: 0.65 },
  select: (w) => w.radar,
  build: (source, ctx) => [
    new TileLayer({
      id: 'radar',
      data: source.template,
      minZoom: 1,
      maxZoom: source.maxNativeZoom,
      tileSize: 256,
      opacity: ctx.ui.opacity ?? 0.65,
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
  ],
  controls: (ctx) => (
    <Slider
      value={[ctx.ui.opacity ?? 0.65]}
      min={0.1}
      max={1}
      step={0.05}
      onValueChange={([v]) => ctx.setUi({ opacity: v })}
      aria-label="radar opacity"
    />
  ),
};
