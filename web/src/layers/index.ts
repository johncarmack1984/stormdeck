import { alerts } from './alerts';
import { citytile } from './citytile';
import { radar } from './radar';
import { temp } from './temp';
import type { WeatherLayer } from './types';
import { wind } from './wind';

export type { LayerCtx, WeatherLayer } from './types';

/**
 * The layer registry. Array order is paint order (radar at the bottom, temps on
 * top). Adding a layer is a one-line change here plus its module — `App` never
 * has to learn the layer exists.
 */
export const LAYERS: WeatherLayer<any>[] = [
  radar,
  alerts,
  wind,
  temp,
  citytile,
];
