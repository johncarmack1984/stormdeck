import { alerts } from './alerts';
import { cape } from './cape';
import { precip } from './precip';
import { temp } from './temp';
import type { WeatherLayer } from './types';
import { wind } from './wind';

export type { LayerCtx, WeatherLayer } from './types';

/**
 * The layer registry. Array order is paint order (the filled rasters at the
 * bottom, vector/point layers on top). Adding a layer is a one-line change here
 * plus its module — `App` never has to learn the layer exists.
 */
export const LAYERS: WeatherLayer<any>[] = [precip, cape, alerts, wind, temp];
