import { alerts } from './alerts';
import { cape } from './cape';
import { precip } from './precip';
import { temp } from './temp';
import { defineLayer, type WeatherLayer } from './types';
import { wind } from './wind';

export type { LayerCtx, WeatherLayer } from './types';

/**
 * The layer registry. Array order is paint order (the filled rasters at the
 * bottom, vector/point layers on top). Adding a layer is a one-line change here
 * plus its module — `App` never has to learn the layer exists. Each layer is
 * wrapped in `defineLayer`, which type-checks it as its own `WeatherLayer<D>`
 * and erases the data type to `unknown` for the shared array (no `any`).
 */
export const LAYERS: WeatherLayer<unknown>[] = [
  defineLayer(precip),
  defineLayer(cape),
  defineLayer(alerts),
  defineLayer(wind),
  defineLayer(temp),
];
