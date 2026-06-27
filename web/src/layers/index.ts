import { alerts } from './alerts';
import { precip } from './precip';
import { temp } from './temp';
import type { WeatherLayer } from './types';
import { wind } from './wind';

export type { LayerCtx, WeatherLayer } from './types';

/**
 * The layer registry. Array order is paint order (precipitation at the bottom,
 * temps on top). Adding a layer is a one-line change here plus its module — `App`
 * never has to learn the layer exists.
 */
export const LAYERS: WeatherLayer<any>[] = [precip, alerts, wind, temp];
